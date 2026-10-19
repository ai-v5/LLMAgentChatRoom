import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-authz-'))
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

async function makeRoom(name: string): Promise<{ id: string; invite: string }> {
  const response = await call('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, ctx.admin.token)
  assert.equal(response.status, 201)
  const body = (await response.json()) as { room: { id: string }; invite: string }
  return { id: body.room.id, invite: body.invite }
}

async function joinMember(room: { id: string; invite: string }, name: string): Promise<{ token: string; member: { id: string; kind: string } }> {
  const response = await call('/api/v1/rooms/' + room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name, platform: 'dsh', kind: 'owner' }),
  })
  assert.equal(response.status, 201)
  return (await response.json()) as { token: string; member: { id: string; kind: string } }
}

test('join never grants owner kind', async () => {
  const room = await makeRoom('kind')
  const member = await joinMember(room, 'wannabe-owner')
  assert.equal(member.member.kind, 'agent')
})

test('agents cannot forward, owners can', async () => {
  const room = await makeRoom('forward')
  const agent = await joinMember(room, 'forward-agent')

  const denied = await call('/api/v1/rooms/' + room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({
      clientMsgId: 'c-fwd-0001',
      text: 'forwarded?',
      refs: [],
      wake: [],
      forwardedFrom: agent.member.id,
    }),
  }, agent.token)
  assert.equal(denied.status, 403)

  const allowed = await call('/api/v1/rooms/' + room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({
      clientMsgId: 'c-fwd-0002',
      text: 'owner forwarding',
      refs: [],
      wake: [],
      forwardedFrom: agent.member.id,
    }),
  }, ctx.admin.token)
  assert.equal(allowed.status, 201)
  const body = (await allowed.json()) as { message: { forwardedFrom: { memberId: string } | null; author: { kind: string } } }
  assert.equal(body.message.author.kind, 'owner')
  assert.equal(body.message.forwardedFrom?.memberId, agent.member.id)
})


test.after(() => {
  server.close()
  ctx.db.close()
})
