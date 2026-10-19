import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBatcher } from '../src/batcher.js'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(5)
  }
}

function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimeoutFn(callback, ms) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, at: now + ms })
      return id
    },
    clearTimeoutFn(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let next = null
        for (const entry of timers) {
          if (entry[1].at <= target && (next === null || entry[1].at < next[1].at)) next = entry
        }
        if (next === null) break
        timers.delete(next[0])
        now = next[1].at
        next[1].callback()
      }
      now = target
    },
  }
}

test('flushes once the fixed window closes', async () => {
  const flushes = []
  const batcher = createBatcher({ windowMs: 25, onFlush: (payload) => flushes.push(payload) })

  batcher.push('first')
  batcher.push('second')
  assert.equal(flushes.length, 0)

  await waitFor(() => flushes.length === 1, 'window flush')
  assert.equal(flushes[0].text, 'first\n\nsecond')
  assert.equal(flushes[0].count, 2)
  assert.equal(flushes[0].oversized, false)
  assert.equal(flushes[0].bytes, Buffer.byteLength('first\n\nsecond'))
  batcher.stop()
})

test('the window starts at the first message and is not reset by later pushes', () => {
  const clock = createClock()
  const flushes = []
  const batcher = createBatcher({
    windowMs: 1500,
    onFlush: (payload) => flushes.push(payload),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })

  batcher.push('a')
  clock.advance(1000)
  batcher.push('b')
  clock.advance(499)
  assert.equal(flushes.length, 0)
  clock.advance(1)
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].count, 2)
  assert.equal(flushes[0].text, 'a\n\nb')
  batcher.stop()
})

test('the 20-message limit flushes without waiting for the window', () => {
  const flushes = []
  const batcher = createBatcher({ windowMs: 60_000, onFlush: (payload) => flushes.push(payload) })

  for (let index = 1; index <= 20; index += 1) batcher.push(`m${index}`)
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].count, 20)
  assert.equal(flushes[0].text.split('\n\n').length, 20)
  assert.equal(flushes[0].text.startsWith('m1\n\nm2'), true)
  assert.equal(flushes[0].text.endsWith('m20'), true)
  assert.equal(batcher.size, 0)
  batcher.stop()
})

test('the 24KB limit splits the batch without truncating any message', () => {
  const flushes = []
  const batcher = createBatcher({ onFlush: (payload) => flushes.push(payload) })
  const first = 'a'.repeat(15_000)
  const second = 'b'.repeat(15_000)

  batcher.push(first)
  batcher.push(second)
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].text, first)
  assert.equal(flushes[0].count, 1)
  assert.equal(flushes[0].bytes, 15_000)
  assert.equal(flushes[0].oversized, false)

  assert.equal(batcher.flush(), true)
  assert.equal(flushes.length, 2)
  assert.equal(flushes[1].text, second)
  assert.equal(flushes[1].bytes, 15_000)
  batcher.stop()
})

test('messages keep their order across a manual flush', () => {
  const flushes = []
  const batcher = createBatcher({ windowMs: 60_000, onFlush: (payload) => flushes.push(payload) })

  batcher.push('one')
  batcher.push('two')
  batcher.push('three')
  assert.equal(batcher.flush(), true)
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].text, 'one\n\ntwo\n\nthree')
  assert.equal(flushes[0].count, 3)
  assert.equal(batcher.flush(), false)
  batcher.stop()
})

test('an oversized message is flushed alone and flagged, never truncated', () => {
  const flushes = []
  const batcher = createBatcher({ onFlush: (payload) => flushes.push(payload) })
  const oversized = 'x'.repeat(24 * 1024 + 1)

  batcher.push('first')
  batcher.push(oversized)
  assert.equal(flushes.length, 2)
  assert.equal(flushes[0].text, 'first')
  assert.equal(flushes[0].oversized, false)
  assert.equal(flushes[1].text, oversized)
  assert.equal(flushes[1].text.length, oversized.length)
  assert.equal(flushes[1].count, 1)
  assert.equal(flushes[1].oversized, true)
  batcher.stop()
})

test('stop clears the pending window', async () => {
  const flushes = []
  const batcher = createBatcher({ windowMs: 10, onFlush: (payload) => flushes.push(payload) })

  batcher.push('pending')
  batcher.stop()
  await delay(50)
  assert.equal(flushes.length, 0)
  assert.equal(batcher.push('after stop'), false)
})
