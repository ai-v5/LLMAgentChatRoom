import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../../../src/server/app.ts'
import { RoomClient, RoomError, parseSseFrame } from '../src/room-client.js'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-plugin-client-'))
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

async function adminCall(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', 'Bearer ' + ctx.admin.token)
  if (init.body) headers.set('content-type', 'application/json')
  return fetch(base + path, { ...init, headers })
}

async function createRoom(name) {
  const response = await adminCall('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

async function joinClient(room, invite, name, platform = 'dsh') {
  return RoomClient.join({ server: base, room: room.id, invite, name, platform })
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out: ' + label)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

test('parseSseFrame parses ids, events, data, and comments', () => {
  assert.deepEqual(parseSseFrame('id: 12\nevent: message\ndata: {"a":1}'), {
    event: 'message',
    id: 12,
    data: { a: 1 },
  })
  assert.deepEqual(parseSseFrame('data: hello'), { event: 'message', id: undefined, data: 'hello' })
  assert.equal(parseSseFrame(': connected'), null)
  assert.equal(parseSseFrame('event: heartbeat'), null)
  assert.deepEqual(parseSseFrame('event: member.removed\ndata: {"memberId":"m"}\ndata: {"n":1}'), {
    event: 'member.removed',
    id: undefined,
    data: '{"memberId":"m"}\n{"n":1}',
  })
})

test('join, send with idempotency, and paginated history', async () => {
  const { room, invite } = await createRoom('client-basic')
  const alice = await joinClient(room, invite, 'alice')
  const bob = await joinClient(room, invite, 'bob', 'codex')

  assert.equal(alice.room, room.id)
  assert.match(alice.memberId, /^member_/)
  assert.equal(typeof alice.token, 'string')
  assert.equal(alice.token.length > 0, true)
  assert.equal(bob.memberName, 'bob')

  const first = await alice.send('hello room', {
    clientMsgId: 'c-basic-0001',
    wake: [bob.memberId],
  })
  assert.equal(first.duplicate, false)
  assert.equal(first.clientMsgId, 'c-basic-0001')
  assert.equal(first.message.text, 'hello room')
  assert.deepEqual(first.message.wake, [bob.memberId])

  const duplicate = await alice.send('hello room', {
    clientMsgId: 'c-basic-0001',
    wake: [bob.memberId],
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.message.id, first.message.id)

  await assert.rejects(
    alice.send('changed body', { clientMsgId: 'c-basic-0001' }),
    (error) => {
      assert.equal(error instanceof RoomError, true)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'idempotency_conflict')
      return true
    },
  )

  const history = await bob.history(0, 50)
  assert.equal(history.length, 1)
  assert.equal(history[0].id, first.message.id)
  assert.equal(history[0].author.memberId, alice.memberId)

  const auto = await bob.send('auto id')
  assert.match(auto.clientMsgId, /^c-[0-9a-f]{32}$/)
})

test('join rejects a bad invite with status, code, and message', async () => {
  const { room } = await createRoom('client-bad-invite')
  await assert.rejects(
    RoomClient.join({ server: base, room: room.id, invite: 'not-the-invite', name: 'nobody' }),
    (error) => {
      assert.equal(error instanceof RoomError, true)
      assert.equal(error.status, 403)
      assert.equal(error.code, 'forbidden')
      assert.equal(typeof error.message, 'string')
      return true
    },
  )
})

test('status reports idle, queued, and unknown target state', async () => {
  const { room, invite } = await createRoom('client-status')
  const client = await joinClient(room, invite, 'status-agent')

  await client.status({
    connectorOnline: true,
    deliveryState: 'queued',
    targetLoaded: 'unknown',
    lastDeliveredSeq: 3,
    detail: 'waiting for turn',
  })

  const response = await fetch(base + '/api/v1/rooms/' + room.id + '/members', {
    headers: { authorization: 'Bearer ' + client.token },
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  const me = body.members.find((member) => member.id === client.memberId)
  assert.equal(me.connectorOnline, true)
  assert.equal(me.deliveryState, 'queued')
  assert.equal(me.targetLoaded, 'unknown')
  assert.equal(me.lastDeliveredSeq, 3)
})

test('SSE replays history and streams live messages', async () => {
  const { room, invite } = await createRoom('client-sse')
  const listener = await joinClient(room, invite, 'listener')
  const sender = await joinClient(room, invite, 'sender', 'codex')
  const received = []
  const controller = new AbortController()
  let consumerError = null
  const consumer = (async () => {
    try {
      for await (const frame of listener.events({ signal: controller.signal })) {
        if (frame.event !== 'message') continue
        received.push(frame)
        if (received.length === 2) break
      }
    } catch (error) {
      consumerError = error
    }
  })()
  try {
    await sender.send('first', { clientMsgId: 'c-sse-0001' })
    await waitFor(() => received.length >= 1, 3000, 'replayed first message')
    await sender.send('second', { clientMsgId: 'c-sse-0002' })
    await withTimeout(consumer, 3000, 'live second message')
    assert.equal(consumerError, null)
    assert.equal(received.length, 2)
    assert.equal(received[0].data.seq, 1)
    assert.equal(received[0].data.text, 'first')
    assert.equal(received[1].data.seq, 2)
    assert.equal(received[1].data.text, 'second')
    assert.equal(received[1].id, 2)
    assert.equal(listener.lastSeq, 2)
  } finally {
    controller.abort()
    await withTimeout(consumer.catch(() => undefined), 3000, 'consumer cleanup')
  }
})

test('kick closes the SSE stream and revokes the token', async () => {
  const { room, invite } = await createRoom('client-kick')
  const listener = await joinClient(room, invite, 'victim')
  const sender = await joinClient(room, invite, 'sender', 'codex')
  const received = []
  const controller = new AbortController()
  let ended = false
  const consumer = (async () => {
    for await (const frame of listener.events({ signal: controller.signal })) {
      if (frame.event === 'message') received.push(frame)
    }
    ended = true
  })()
  try {
    await sender.send('before kick', { clientMsgId: 'c-kick-0001' })
    await waitFor(() => received.length >= 1, 3000, 'pre-kick message')

    const kicked = await adminCall('/api/v1/rooms/' + room.id + '/members/' + listener.memberId, {
      method: 'DELETE',
    })
    assert.equal(kicked.status, 200)

    await withTimeout(consumer, 3000, 'SSE close after kick')
    assert.equal(ended, true)
    await assert.rejects(
      listener.send('after kick', { clientMsgId: 'c-kick-0002' }),
      (error) => error instanceof RoomError && error.status === 401,
    )
    await assert.rejects(
      async () => {
        for await (const frame of listener.events()) {
          void frame
        }
      },
      (error) => error instanceof RoomError && error.status === 401,
    )
  } finally {
    controller.abort()
    listener.close()
  }
})

test.after(() => {
  server.closeAllConnections()
  server.close()
  ctx.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
