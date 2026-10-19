import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../../../src/server/app.ts'
import { createConnector, createSpawnRunner } from '../src/connector.js'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-codex-'))
const ctx = createContext({
  dataDir,
  adminTokenFile: join(dataDir, 'admin.token'),
  version: 'test',
  sourceUrl: 'https://example.invalid/repo',
})
const server = createApp(ctx)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('no port')
const base = 'http://127.0.0.1:' + address.port

const silentLogger = { info() {}, warn() {} }

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(10)
  }
}

async function call(path, init = {}, token) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', 'Bearer ' + token)
  return fetch(base + path, { ...init, headers })
}

async function createRoom(name) {
  const response = await call(
    '/api/v1/rooms',
    { method: 'POST', body: JSON.stringify({ name }) },
    ctx.admin.token,
  )
  assert.equal(response.status, 201)
  return await response.json()
}

async function postAsOwner(roomId, text, wake, clientMsgId) {
  const response = await call(
    `/api/v1/rooms/${roomId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ clientMsgId, text, refs: [], replyTo: null, wake }),
    },
    ctx.admin.token,
  )
  assert.equal(response.status, 201)
  return await response.json()
}

async function memberStatus(roomId, memberId) {
  const response = await call(`/api/v1/rooms/${roomId}/members`, {}, ctx.admin.token)
  assert.equal(response.status, 200)
  const body = await response.json()
  const member = body.members.find((entry) => entry.id === memberId)
  assert.ok(member, `member ${memberId} should be listed`)
  return member
}

async function startConnector(room, runQueue) {
  const connector = createConnector({
    server: base,
    room: room.room.id,
    invite: room.invite,
    name: 'codex-agent',
    target: 'thread-demo',
    runQueue,
    logger: silentLogger,
    batch: { windowMs: 200 },
  })
  return connector.start()
}

test('wake messages are batched into one queue call and the cursor advances', async () => {
  const room = await createRoom('batch')
  const deliveries = []
  const handle = await startConnector(room, async (input) => {
    deliveries.push(input.text)
    return { state: 'queued', reason: null, detail: null }
  })
  try {
    await postAsOwner(room.room.id, 'alpha', [handle.memberId], 'c-codex-0001')
    await postAsOwner(room.room.id, 'beta', [handle.memberId], 'c-codex-0002')
    await postAsOwner(room.room.id, 'gamma', [handle.memberId], 'c-codex-0003')

    await waitFor(() => deliveries.length === 1, 'one batched delivery')
    await waitFor(() => handle.lastSeq === 3, 'cursor to reach seq 3')

    const blocks = deliveries[0].split('\n\n')
    assert.equal(blocks.length, 3)
    assert.match(blocks[0], /^\[chat-room msg=msg_[A-Za-z0-9]+ seq=1 from=owner \(human\) kind=instruction ts=/)
    assert.match(blocks[1], / seq=2 /)
    assert.match(blocks[2], / seq=3 /)
    assert.ok(blocks[0].endsWith('\nalpha'))
    assert.ok(blocks[1].endsWith('\nbeta'))
    assert.ok(blocks[2].endsWith('\ngamma'))

    assert.equal(handle.state, 'idle')
    assert.equal(deliveries.length, 1)
    const status = await memberStatus(room.room.id, handle.memberId)
    assert.equal(status.connectorOnline, true)
    assert.equal(status.deliveryState, 'idle')
    assert.equal(status.targetLoaded, 'unknown')
    assert.equal(status.lastDeliveredSeq, 3)
  } finally {
    await handle.stop()
  }
})

test('a retryable queue result is retried with backoff and only then advances', async () => {
  const room = await createRoom('retry')
  const calls = []
  let first = true
  const handle = await startConnector(room, async (input) => {
    calls.push(input.text)
    if (first) {
      first = false
      return { state: 'retryable', reason: 'timeout', detail: 'timeout' }
    }
    return { state: 'queued', reason: null, detail: null }
  })
  try {
    await postAsOwner(room.room.id, 'retry me', [handle.memberId], 'c-codex-0004')
    await waitFor(() => calls.length === 1 && handle.state === 'retryable', 'retryable state')
    assert.equal(handle.lastSeq, 0)
    assert.ok(calls[0].includes('retry me'), 'batch is kept pending while retrying')

    await waitFor(() => calls.length === 2 && handle.state === 'idle', 'retry to succeed', 8000)
    assert.equal(calls[0], calls[1], 'the same batch is retried')
    assert.equal(handle.lastSeq, 1)
    const status = await memberStatus(room.room.id, handle.memberId)
    assert.equal(status.deliveryState, 'idle')
    assert.equal(status.lastDeliveredSeq, 1)
  } finally {
    await handle.stop()
  }
})

test('target_missing is reported as error and leaves the cursor untouched', async () => {
  const room = await createRoom('missing')
  const handle = await startConnector(room, async () => ({ state: 'error', reason: 'target_missing' }))
  try {
    await postAsOwner(room.room.id, 'anyone there?', [handle.memberId], 'c-codex-0005')
    await waitFor(() => handle.state === 'error', 'error state')
    assert.equal(handle.lastSeq, 0)
    const status = await memberStatus(room.room.id, handle.memberId)
    assert.equal(status.deliveryState, 'error')
    assert.equal(status.lastDeliveredSeq, 0)
  } finally {
    await handle.stop()
  }
})

test('the default spawn runner reports a missing codex binary', async () => {
  const run = createSpawnRunner({ codexBin: `missing-codex-${process.pid}-${Date.now()}`, timeoutMs: 5000 })
  const result = await run({ target: 'thread-demo', text: 'hello' })
  assert.equal(result.state, 'error')
  assert.equal(result.reason, 'server_too_old')
  assert.match(result.detail, /missing/i)
})

test('a kicked member stops the connector', async () => {
  const room = await createRoom('kick')
  const handle = await startConnector(room, async () => ({ state: 'queued', reason: null, detail: null }))
  try {
    const kicked = await call(
      `/api/v1/rooms/${room.room.id}/members/${handle.memberId}`,
      { method: 'DELETE' },
      ctx.admin.token,
    )
    assert.equal(kicked.status, 200)
    await waitFor(() => handle.closed, 'connector to stop after a kick', 8000)
  } finally {
    await handle.stop()
  }
})

test.after(() => {
  server.close()
  ctx.db.close()
})
