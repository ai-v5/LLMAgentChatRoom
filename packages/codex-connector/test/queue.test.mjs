import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQueueArgs, classifyQueueResult, STDERR_DETAIL_LIMIT } from '../src/queue.js'

test('buildQueueArgs keeps the message as one argv element', () => {
  const text = '[chat-room msg=m_1 seq=1 from=agent-a (agent, codex) kind=data ts=2026-01-01T00:00:00Z]\nhello "world"\n\nsecond message'
  assert.deepEqual(buildQueueArgs({ target: 'thread-abc', text }), [
    'queue',
    '--thread',
    'thread-abc',
    '--message',
    text,
  ])
})

test('buildQueueArgs rejects a missing target or text', () => {
  assert.throws(() => buildQueueArgs({ target: '', text: 'hi' }), TypeError)
  assert.throws(() => buildQueueArgs({ target: '   ', text: 'hi' }), TypeError)
  assert.throws(() => buildQueueArgs({ target: 'thread-a', text: '' }), TypeError)
  assert.throws(() => buildQueueArgs({}), TypeError)
})

test('a zero exit is a queued receipt', () => {
  const result = classifyQueueResult({ code: 0, stdout: 'queued\n' })
  assert.deepEqual(result, { state: 'queued', reason: null, detail: null })
})

test('a timeout is retryable', () => {
  const result = classifyQueueResult({ code: null, timedOut: true, stderr: 'still waiting' })
  assert.equal(result.state, 'retryable')
  assert.equal(result.reason, 'timeout')
  assert.match(result.detail, /timeout/)
})

test('ENOENT means the codex binary is missing or too old', () => {
  const result = classifyQueueResult({ errorCode: 'ENOENT', stderr: 'spawn codex ENOENT' })
  assert.equal(result.state, 'error')
  assert.equal(result.reason, 'server_too_old')
  assert.match(result.detail, /missing/i)
})

test('other spawn failures are reported as spawn_failed', () => {
  const result = classifyQueueResult({ errorCode: 'EACCES', stderr: 'permission denied' })
  assert.equal(result.state, 'error')
  assert.equal(result.reason, 'spawn_failed')
})

test('stderr phrases map to the exact failure reason', () => {
  const cases = [
    ['Error: thread "abc" not found', 'target_missing'],
    ['no such thread: abc', 'target_missing'],
    ['unknown thread name', 'target_missing'],
    ['ambiguous thread name "demo"', 'ambiguous_target'],
    ['multiple threads match "demo"', 'ambiguous_target'],
    ['"demo" matches multiple sessions', 'ambiguous_target'],
    ['unknown command: queue', 'server_too_old'],
    ['unknown option --thread', 'server_too_old'],
    ['unrecognized argument --message', 'server_too_old'],
    ['invalid subcommand "queue"', 'server_too_old'],
  ]
  for (const [stderr, reason] of cases) {
    const result = classifyQueueResult({ code: 2, stderr })
    assert.equal(result.state, 'error', stderr)
    assert.equal(result.reason, reason, stderr)
    assert.match(result.detail, new RegExp(stderr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), stderr)
  }
})

test('any other non-zero exit is retryable without a reason', () => {
  const result = classifyQueueResult({ code: 1, stdout: '', stderr: 'boom' })
  assert.equal(result.state, 'retryable')
  assert.equal(result.reason, null)
  assert.equal(result.detail, 'boom')
})

test('stored stderr is clipped to the detail limit', () => {
  const stderr = `${'E'.repeat(400)}TAIL`
  const result = classifyQueueResult({ code: 2, stderr })
  assert.equal(result.detail.length, STDERR_DETAIL_LIMIT)
  assert.ok(!result.detail.includes('TAIL'))
})

test('phrase matching is case-insensitive', () => {
  const result = classifyQueueResult({ code: 3, stderr: 'NO SUCH THREAD' })
  assert.equal(result.reason, 'target_missing')
})
