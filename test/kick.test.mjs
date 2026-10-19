import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-kick-'))
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

async function call(path, init = {}, token) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', 'Bearer ' + token)
  return fetch(base + path, { ...init, headers })
}

async function joinMember(roomId, invite, name) {
  const response = await call('/api/v1/rooms/' + roomId + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite, name, platform: 'dsh' }),
  })
  assert.equal(response.status, 201)
  return await response.json()
}
test('kick closes SSE and revokes token', async () => {
  const admin = ctx.admin.token
  const created = await call('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'kick' }),
  }, admin)
  const room = await created.json()

  const victim = await joinMember(room.room.id, room.invite, 'victim')
  const sender = await joinMember(room.room.id, room.invite, 'sender')

  const controller = new AbortController()
  const stream = await fetch(base + '/api/v1/rooms/' + room.room.id + '/events?since=0', {
    headers: { authorization: 'Bearer ' + victim.token },
    signal: controller.signal,
  })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()

  const posted = await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-kick-0001', text: 'hi', refs: [], wake: [] }),
  }, sender.token)
  assert.equal(posted.status, 201)

  let buffer = ''
  while (!buffer.includes('event: message')) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  assert.match(buffer, /event: message/)

  const kicked = await call(
    '/api/v1/rooms/' + room.room.id + '/members/' + victim.member.id,
    { method: 'DELETE' },
    admin,
  )
  assert.equal(kicked.status, 200)

  const deadline = Date.now() + 3000
  let ended = false
  while (Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) {
      ended = true
      break
    }
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  assert.equal(ended, true)

  const after = await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-kick-0002', text: 'after', refs: [], wake: [] }),
  }, victim.token)
  assert.equal(after.status, 401)
  controller.abort()
})

test.after(() => {
  server.close()
  ctx.db.close()
})
