import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-rate-'))
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
const roomsUrl = base + '/api/v1/rooms'

test('join attempts are rate limited per IP', async () => {
  const created = await fetch(roomsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + ctx.admin.token,
    },
    body: JSON.stringify({ name: 'rate' }),
  })
  assert.equal(created.status, 201)
  const body = (await created.json()) as { room: { id: string }; invite: string }
  const joinUrl = roomsUrl + '/' + body.room.id + '/join'

  let lastStatus = 0
  for (let index = 0; index < 11; index += 1) {
    const payload = {
      invite: body.invite,
      name: 'rate-' + index,
      platform: 'dsh',
    }
    const response = await fetch(joinUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    lastStatus = response.status
  }
  assert.equal(lastStatus, 429)
})

test.after(() => {
  server.close()
  ctx.db.close()
})
