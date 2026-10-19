import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-contracts-'))
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

async function makeRoom(name: string, token: string): Promise<{ room: { id: string }; invite: string }> {
  const response = await call('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, token)
  assert.equal(response.status, 201)
  const body = (await response.json()) as { room: { id: string }; invite: string }
  return { id: body.room.id, invite: body.invite }
}

async function joinMember(room: { id: string; invite: string }, name: string): Promise<{ token: string; member: { id: string } }> {
  const response = await call('/api/v1/rooms/' + room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name, platform: 'dsh' }),
  })
  assert.equal(response.status, 201)
  return (await response.json()) as { token: string; member: { id: string } }
}

test('mixed credentials are rejected and cookie writes need CSRF', async () => {
  const login = await call('/api/v1/session', {
    method: 'POST',
    body: JSON.stringify({ token: ctx.admin.token }),
  })
  assert.equal(login.status, 200)
  const cookies = login.headers.getSetCookie()
  const cookie = cookies[0].split(';')[0]
  const body = (await login.json()) as { csrf: string }

  const mixed = await fetch(base + '/api/v1/rooms', {
    headers: { cookie, authorization: 'Bearer ' + ctx.admin.token },
  })
  assert.equal(mixed.status, 400)

  const noCsrf = await fetch(base + '/api/v1/rooms', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cookie-room' }),
  })
  assert.equal(noCsrf.status, 403)

  const withCsrf = await fetch(base + '/api/v1/rooms', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': body.csrf },
    body: JSON.stringify({ name: 'cookie-room' }),
  })
  assert.equal(withCsrf.status, 201)
})

test('payload and id validation', async () => {
  const room = await makeRoom('limits', ctx.admin.token)
  const member = await joinMember(room, 'agent-limits')

  const huge = await call('/api/v1/rooms/' + room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({
      clientMsgId: 'c-huge-0001',
      text: 'x'.repeat(8193),
      refs: [],
      wake: [],
    }),
  }, member.token)
  assert.equal(huge.status, 413)

  const badId = await call('/api/v1/rooms/' + room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'short', text: 'hi', refs: [], wake: [] }),
  }, member.token)
  assert.equal(badId.status, 400)
})

test('wake budget caps automatic wakes per member', async () => {
  const room = await makeRoom('budget', ctx.admin.token)
  const member = await joinMember(room, 'agent-budget')
  for (let index = 1; index <= 11; index += 1) {
    const response = await call('/api/v1/rooms/' + room.id + '/messages', {
      method: 'POST',
      body: JSON.stringify({
        clientMsgId: 'c-budget-' + String(index).padStart(4, '0'),
        text: 'wake ' + index,
        refs: [],
        wake: [],
      }),
    }, ctx.admin.token)
    assert.equal(response.status, 201)
  }
  const history = (await (await call(
    '/api/v1/rooms/' + room.id + '/messages?since=0',
    {},
    ctx.admin.token,
  )).json()) as { messages: Array<{ wake: string[] }> }
  const wakes = history.messages.filter((message) => message.wake.includes(member.member.id))
  assert.equal(wakes.length, 10)
})


test.after(() => {
  server.close()
  ctx.db.close()
})
