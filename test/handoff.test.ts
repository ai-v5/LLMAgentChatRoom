import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-handoff-'))
const ctx = createContext({
  dataDir,
  adminTokenFile: join(dataDir, 'admin.token'),
  version: 'test',
  sourceUrl: 'https://example.invalid/repo',
  limits: { messagesPerMinute: 1000, joinsPerMinute: 1000 },
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

test('replay to live handoff keeps every seq', async () => {
  const admin = ctx.admin.token
  const room = (await (await call('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'handoff' }),
  }, admin)).json()) as { room: { id: string }; invite: string }

  const joined = (await (await call('/api/v1/rooms/' + room.room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name: 'agent-handoff', platform: 'dsh' }),
  })).json()) as { token: string }

  const post = (index: number) =>
    call('/api/v1/rooms/' + room.room.id + '/messages', {
      method: 'POST',
      body: JSON.stringify({
        clientMsgId: 'c-' + String(index).padStart(8, '0'),
        text: 'm' + index,
        refs: [],
        wake: [],
      }),
    }, joined.token)

  for (let index = 1; index <= 205; index += 1) {
    const response = await post(index)
    assert.equal(response.status, 201)
  }

  const listener = (await (await call('/api/v1/rooms/' + room.room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name: 'agent-listener', platform: 'dsh' }),
  })).json()) as { token: string }

  const controller = new AbortController()
  const response = await fetch(base + '/api/v1/rooms/' + room.room.id + '/events?since=0', {
    headers: { authorization: 'Bearer ' + listener.token },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)

  const pending = post(206)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const ids: number[] = []

  while (ids.length < 206) {
    const chunk = await withTimeout(reader.read(), 5000)
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const index = buffer.indexOf('\n\n')
      if (index < 0) break
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const match = /^id: (\d+)$/m.exec(frame)
      if (match && frame.includes('event: message')) ids.push(Number(match[1]))
    }
  }

  assert.equal((await pending).status, 201)
  assert.deepEqual(ids, Array.from({ length: 206 }, (_, index) => index + 1))
  await reader.cancel()
  controller.abort()
})

test.after(() => {
  server.close()
  ctx.db.close()
})
