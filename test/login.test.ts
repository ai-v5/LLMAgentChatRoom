import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../src/server/app.ts'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-login-test-'))
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

test('GET /login creates an owner session and redirects home', async () => {
  const response = await fetch(base + '/login?token=' + encodeURIComponent(ctx.admin.token), {
    redirect: 'manual',
  })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/')

  const setCookie = response.headers.get('set-cookie')
  assert.ok(setCookie)
  assert.match(setCookie, /^llmroom_session=[^;]+;/)
  assert.match(setCookie, /Max-Age=43200/)

  const cookie = setCookie.split(';', 1)[0] as string
  const rooms = await fetch(base + '/api/v1/rooms', { headers: { cookie } })
  assert.equal(rooms.status, 200)
  assert.deepEqual(await rooms.json(), { rooms: [] })
})

test('GET /login rejects an invalid token without setting a cookie', async () => {
  const response = await fetch(base + '/login?token=not-the-admin-token', {
    redirect: 'manual',
  })
  assert.equal(response.status, 403)
  assert.equal(await response.text(), 'invalid token')
  assert.equal(response.headers.get('set-cookie'), null)
})

test.after(() => {
  server.closeAllConnections()
  server.close()
  ctx.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
