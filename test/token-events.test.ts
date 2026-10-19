import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-token-events-'))
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

async function createRoom(name: string): Promise<{ id: string; invite: string }> {
  const created = await call('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, ctx.admin.token)
  assert.equal(created.status, 201)
  const body = (await created.json()) as { room: { id: string }; invite: string }
  return { id: body.room.id, invite: body.invite }
}

test('events accept the admin token from the query string', { timeout: 10000 }, async () => {
  const room = await createRoom('token-events')
  const joined = await call('/api/v1/rooms/' + room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name: 'events-member', platform: 'dsh' }),
  })
  assert.equal(joined.status, 201)
  const member = (await joined.json()) as { token: string }

  const posted = await call('/api/v1/rooms/' + room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-token-events-1', text: 'token event', refs: [], wake: [] }),
  }, member.token)
  assert.equal(posted.status, 201)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(
      base + '/api/v1/rooms/' + room.id + '/events?token=' + encodeURIComponent(ctx.admin.token),
      { signal: controller.signal },
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let frame = ''
    for (;;) {
      const index = buffer.indexOf('\n\n')
      if (index >= 0) {
        const candidate = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (candidate.includes('event: message')) {
          frame = candidate
          break
        }
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error('stream ended before a message frame')
      buffer += decoder.decode(chunk.value, { stream: true })
    }

    assert.match(frame, /id: 1/)
    assert.match(frame, /"text":"token event"/)
    await reader.cancel()
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
})

test('events reject an invalid admin token from the query string', async () => {
  const room = await createRoom('token-events-invalid')

  const response = await fetch(
    base + '/api/v1/rooms/' + room.id + '/events?token=' + encodeURIComponent('not-the-admin-token'),
  )
  assert.equal(response.status, 401)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'unauthorized')
})

test.after(() => {
  server.closeAllConnections()
  server.close()
  ctx.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
