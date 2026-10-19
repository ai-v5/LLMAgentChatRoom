import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-sse-'))
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

test('SSE replays history then streams live messages', async () => {
  const admin = ctx.admin.token
  const room = (await (await call('/api/v1/rooms', {
    method: 'POST', body: JSON.stringify({ name: 'sse' }),
  }, admin)).json()) as { room: { id: string }; invite: string }

  const sender = (await (await call('/api/v1/rooms/' + room.room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name: 'sender', platform: 'dsh' }),
  })).json()) as { token: string }

  const listener = (await (await call('/api/v1/rooms/' + room.room.id + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: room.invite, name: 'listener', platform: 'codex' }),
  })).json()) as { token: string }

  await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-sse-001', text: 'first', refs: [], wake: [] }),
  }, sender.token)

  const controller = new AbortController()
  const response = await fetch(base + '/api/v1/rooms/' + room.room.id + '/events?since=0', {
    headers: { authorization: 'Bearer ' + listener.token },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  async function nextMessage(): Promise<string> {
    for (;;) {
      const index = buffer.indexOf('\n\n')
      if (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (frame.includes('event: message')) return frame
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error('stream ended')
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  const first = await nextMessage()
  assert.match(first, /id: 1/)
  assert.match(first, /"text":"first"/)

  await call('/api/v1/rooms/' + room.room.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId: 'c-sse-002', text: 'second', refs: [], wake: [] }),
  }, sender.token)

  const second = await nextMessage()
  assert.match(second, /id: 2/)
  assert.match(second, /"text":"second"/)

  await reader.cancel()
  controller.abort()
})

test.after(() => {
  server.close()
  ctx.db.close()
})
