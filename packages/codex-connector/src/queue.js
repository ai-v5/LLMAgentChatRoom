/**
 * `codex queue` argv construction and result classification.
 *
 * The connector only needs to know whether the target thread accepted the
 * batch. `codex queue` reports success with exit code 0 and a receipt on
 * stdout; every other outcome is mapped onto the room protocol's delivery
 * states so the GUI can distinguish "retry later" from "the binding is wrong".
 *
 * @module @llmagentchatroom/codex-connector/queue
 */

/** Bytes of stderr kept in a classification detail. */
export const STDERR_DETAIL_LIMIT = 300

/** @typedef {'target_missing' | 'ambiguous_target' | 'server_too_old' | 'timeout' | 'spawn_failed' | null} QueueReason */

/**
 * @typedef {object} QueueResult
 * @property {'queued' | 'retryable' | 'error'} state - Room delivery state.
 * @property {QueueReason} reason - Machine-readable failure cause.
 * @property {string | null} detail - Short human-readable detail (stderr is
 *   clipped to {@link STDERR_DETAIL_LIMIT} chars).
 */

const TARGET_MISSING = /not found|no such thread|unknown thread/i
const AMBIGUOUS_TARGET = /ambiguous|multiple threads|matches multiple/i
const SERVER_TOO_OLD = /unknown command|unknown option|unrecognized|invalid subcommand/i

/**
 * Build the argv array passed to `spawn`. Values stay separate argv entries,
 * so no shell quoting, splitting, or injection is involved.
 * @param {{ target?: unknown, text?: unknown }} input
 * @returns {string[]} `['queue', '--thread', target, '--message', text]`
 */
export function buildQueueArgs(input) {
  const { target, text } = input ?? {}
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new TypeError('codex queue: target (thread id or exact name) is required')
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('codex queue: text is required')
  }
  return ['queue', '--thread', target, '--message', text]
}

/**
 * Clip stored stderr so one noisy failure cannot bloat the room status detail.
 * @param {string} value
 * @returns {string}
 */
function clip(value) {
  return value.length > STDERR_DETAIL_LIMIT ? value.slice(0, STDERR_DETAIL_LIMIT) : value
}

/**
 * @param {'queued' | 'retryable' | 'error'} state
 * @param {QueueReason} reason
 * @param {string} stderr
 * @param {string | null} prefix
 * @returns {QueueResult}
 */
function result(state, reason, stderr, prefix = reason) {
  const clipped = clip(String(stderr ?? '').trim())
  let detail = null
  if (prefix && clipped.length > 0) detail = `${prefix}: ${clipped}`
  else if (prefix) detail = prefix
  else if (clipped.length > 0) detail = clipped
  return { state, reason, detail }
}

/**
 * Classify one `codex queue` invocation.
 *
 * Precedence: timeout, spawn failure, success, then stderr phrases. A phrase
 * match always wins over the generic retryable fallback because it means the
 * binding itself is wrong and retrying cannot help.
 *
 * @param {{ code?: number | null, stdout?: string, stderr?: string,
 *   timedOut?: boolean, errorCode?: string | null }} [input]
 * @returns {QueueResult}
 */
export function classifyQueueResult(input = {}) {
  const { code = null, stdout = '', stderr = '', timedOut = false, errorCode = null } = input ?? {}

  if (timedOut) {
    return result('retryable', 'timeout', typeof stderr === 'string' ? stderr : '')
  }
  if (errorCode === 'ENOENT') {
    // `codex` is not on PATH: either the CLI is missing or it predates `queue`.
    return result(
      'error',
      'server_too_old',
      typeof stderr === 'string' ? stderr : '',
      'codex binary is missing (ENOENT)',
    )
  }
  if (typeof errorCode === 'string' && errorCode.length > 0) {
    return result(
      'error',
      'spawn_failed',
      typeof stderr === 'string' ? stderr : '',
      `spawn failed (${errorCode})`,
    )
  }
  if (code === 0) {
    return { state: 'queued', reason: null, detail: null }
  }

  const err = typeof stderr === 'string' ? stderr : ''
  if (TARGET_MISSING.test(err)) return result('error', 'target_missing', err)
  if (AMBIGUOUS_TARGET.test(err)) return result('error', 'ambiguous_target', err)
  if (SERVER_TOO_OLD.test(err)) return result('error', 'server_too_old', err)

  // Any other non-zero exit (or a signal kill) may succeed on a retry.
  return result('retryable', null, err)
}
