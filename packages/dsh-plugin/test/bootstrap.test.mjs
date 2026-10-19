import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomPlugin } from '../src/plugin.js'

const BOOTSTRAP_PATH = '/api/llmroom/bootstrap'

function createPlugin() {
  return createRoomPlugin({
    defineTool: (definition) => definition,
    createUserMessage: (input) => input,
  })
}

function createHarness() {
  const routes = new Map()
  const disposers = []
  return {
    routes,
    ctx: {
      logger: {
        warn() {},
      },
      tools: {
        register() {
          return () => {}
        },
      },
      effect(callback) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
      },
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

test('bootstrap route returns the default server and the admin token', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-bootstrap-test-'))
  const harness = createHarness()
  try {
    writeFileSync(join(dataDir, 'admin.token'), 'admin-token-for-bootstrap\n', 'utf8')
    createPlugin().apply(harness.ctx, { autoStart: false, dataDir })

    const route = harness.routes.get(BOOTSTRAP_PATH)
    assert.ok(route)
    assert.deepEqual(route.methods, ['GET'])
    assert.equal(route.requestBody, 'buffered')

    const response = await route.fetch(new Request('http://dsh.invalid' + BOOTSTRAP_PATH))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      server: 'http://127.0.0.1:8787',
      token: 'admin-token-for-bootstrap',
    })
  } finally {
    await harness.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('bootstrap route reports a missing admin token', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-bootstrap-missing-'))
  const harness = createHarness()
  try {
    createPlugin().apply(harness.ctx, { autoStart: false, dataDir, server: 'http://127.0.0.1:9999' })
    const route = harness.routes.get(BOOTSTRAP_PATH)
    assert.ok(route)

    const response = await route.fetch(new Request('http://dsh.invalid' + BOOTSTRAP_PATH))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'token_missing' })
  } finally {
    await harness.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
