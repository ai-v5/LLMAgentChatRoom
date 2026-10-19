import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-'))
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

test('health and about', async () => {
  const health = await call('/healthz')
  assert.equal(health.status, 200)
  const about = await call('/about')
  const body = await about.json()
  assert.equal(body.license, 'AGPL-3.0-only')
})

test('room, join, post, idempotency, history', async () => {
  const admin = ctx.admin.token
  const created = await call('/api/v1/rooms', { method: 'POST', body: JSON.stringify({ name: 'demo' }) }, admin)
  assert.equal(created.status, 201)
  const room = (await created.json()) as { room: { id: string }; invite: string }

  const joined = await call('/api/v1/rooms/' + room.room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name: 'agent-a', platform: 'dsh' }),
  })
  assert.equal(joined.status, 201)
  const member = (await joined.json()) as { token: string; member: { id: string } }

  const input = { clientMsgId: 'c-0000001', text: 'hello', refs: [], wake: [] }
  const first = await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify(input),
  }, member.token)
  assert.equal(first.status, 201)
  const firstBody = (await first.json()) as { message: { seq: number }; duplicate: boolean }
  assert.equal(firstBody.duplicate, false)
  assert.equal(firstBody.message.seq, 1)

  const again = await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify(input),
  }, member.token)
  assert.equal(again.status, 200)
  const againBody = (await again.json()) as { duplicate: boolean; message: { seq: number } }
  assert.equal(againBody.duplicate, true)
  assert.equal(againBody.message.seq, 1)

  const conflict = await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ ...input, text: 'different' }),
  }, member.token)
  assert.equal(conflict.status, 409)

  const history = await call('/api/v1/rooms/' + room.room.id + '/messages?since=0', {}, member.token)
  const historyBody = (await history.json()) as { messages: unknown[] }
  assert.equal(historyBody.messages.length, 1)
})

test('cross-room token is rejected and kick revokes access', async () => {
  const admin = ctx.admin.token
  const roomA = (await (await call('/api/v1/rooms', {
    method: 'POST', body: JSON.stringify({ name: 'a' }),
  }, admin)).json()) as { room: { id: string }; invite: string }
  const roomB = (await (await call('/api/v1/rooms', {
    method: 'POST', body: JSON.stringify({ name: 'b' }),
  }, admin)).json()) as { room: { id: string }; invite: string }
  const joined = (await (await call('/api/v1/rooms/' + roomA.room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: roomA.invite, name: 'agent-b', platform: 'codex' }),
  })).json()) as { token: string; member: { id: string } }

  const cross = await call('/api/v1/rooms/' + roomB.room.id + '/messages?since=0', {}, joined.token)
  assert.equal(cross.status, 401)

  const kicked = await call(
    '/api/v1/rooms/' + roomA.room.id + '/members/' + joined.member.id,
    { method: 'DELETE' },
    admin,
  )
  assert.equal(kicked.status, 200)

  const after = await call('/api/v1/rooms/' + roomA.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-0000002', text: 'after kick', refs: [], wake: [] }),
  }, joined.token)
  assert.equal(after.status, 401)
})


test.after(() => {
  server.close()
  ctx.db.close()
})
