import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'
import { Connection } from '../src/server/sse.ts'

test('pre-live queue overflow closes the connection', () => {
  let ended = false
  const res = {
    writeHead() {},
    write() {},
    end() { ended = true },
  }
  const connection = new Connection(res as never, 'room', 'member')
  for (let index = 0; index < 1001; index += 1) {
    connection.enqueue({ event: 'message', id: index, data: { index } })
  }
  assert.equal(connection.overflow, true)
  assert.equal(ended, true)
})

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-edge-'))
const ctx = createContext({
  dataDir,
  adminTokenFile: join(dataDir, 'admin.token'),
  version: 'test',
  sourceUrl: 'https://example.invalid/repo',
})
const server = createApp(ctx)
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('no port')
const base = 'http://127.0.0.1:' + address.port

async function call(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', 'Bearer ' + token)
  return fetch(base + path, { ...init, headers })
}

async function createRoom(name: string): Promise<{ roomId: string; invite: string }> {
  const response = await call('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, ctx.admin.token)
  const body = (await response.json()) as { room: { id: string }; invite: string }
  return { roomId: body.room.id, invite: body.invite }
}

async function joinMember(room: { roomId: string; invite: string }, name: string): Promise<{ token: string; memberId: string }> {
  const response = await call('/api/v1/rooms/' + room.roomId + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name, platform: 'dsh' }),
  })
  assert.equal(response.status, 201)
  const body = (await response.json()) as { token: string; member: { id: string } }
  return { token: body.token, memberId: body.member.id }
}

test('author never receives an echo of its own message', async () => {
  const room = await createRoom('echo')
  const member = await joinMember(room, 'echo-agent')
  const controller = new AbortController()
  const stream = await fetch(base + '/api/v1/rooms/' + room.roomId + '/events', {
    headers: { authorization: 'Bearer ' + member.token },
    signal: controller.signal,
  })
  assert.equal(stream.status, 200)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    const posted = await call('/api/v1/rooms/' + room.roomId + '/messages', {
      method: 'POST',
      body: JSON.stringify({ clientMsgId: 'c-echo-0001', text: 'self', refs: [], wake: [] }),
    }, member.token)
    assert.equal(posted.status, 201)
    const deadline = Date.now() + 600
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ])
      if (chunk === 'timeout') break
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    assert.equal(buffer.includes('event: message'), false)
  } finally {
    await reader.cancel().catch(() => {})
    controller.abort()
  }
})

test('agent messages do not wake peers without an explicit wake list', async () => {
  const room = await createRoom('nowake')
  const author = await joinMember(room, 'author')
  const peer = await joinMember(room, 'peer')
  const posted = await call('/api/v1/rooms/' + room.roomId + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-nowake-001', text: 'peer', refs: [], wake: [] }),
  }, author.token)
  assert.equal(posted.status, 201)
  const response = await call('/api/v1/rooms/' + room.roomId + '/messages?since=0', {}, peer.token)
  const history = (await response.json()) as { messages: Array<{ wake: string[] }> }
  assert.deepEqual(history.messages[0].wake, [])
})

test.after(() => {
  server.close()
  ctx.db.close()
})
