/**
 * Fixed-window batcher for room messages destined for one `codex queue` call.
 *
 * Semantics (docs/DESIGN.md §10.4):
 * - the window starts with the first buffered message and is never reset by
 *   later messages, so a burst cannot starve delivery;
 * - at most `maxMessages` messages and `maxBytes` UTF-8 bytes per batch, with
 *   the `\n\n` separators counted as well;
 * - messages are kept whole and in order: a batch is split, never truncated;
 * - one oversized message is flushed alone and flagged `oversized` so the
 *   caller can report an error instead of silently dropping content.
 *
 * @module @llmagentchatroom/codex-connector/batcher
 */

const DEFAULT_MAX_MESSAGES = 20
const DEFAULT_MAX_BYTES = 24 * 1024
const DEFAULT_WINDOW_MS = 1500
/** Bytes added by joining two messages with `\n\n`. */
const SEPARATOR_BYTES = 2

/**
 * @typedef {object} FlushPayload
 * @property {string} text - Messages joined with `\n\n`, ready for `--message`.
 * @property {number} count - Number of messages in this batch.
 * @property {number} bytes - UTF-8 byte length of `text`.
 * @property {boolean} oversized - True when `count === 1` and the single
 *   message does not fit within `maxBytes`; it is never truncated.
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @returns {number}
 */
function requireCount(value, name, min) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new TypeError(`batcher: ${name} must be an integer >= ${min}`)
  }
  return value
}

/**
 * @param {string} text
 * @returns {number}
 */
function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Create a fixed-window batcher.
 *
 * `push()` may flush synchronously: when the batch reaches `maxMessages` or a
 * message would overflow `maxBytes`, `onFlush` is called from inside `push`.
 * `onFlush` may return a promise; the batcher ignores it. Exceptions thrown by
 * `onFlush` propagate to the caller of `push()`/`flush()`.
 *
 * @param {{
 *   maxMessages?: number,
 *   maxBytes?: number,
 *   windowMs?: number,
 *   onFlush: (payload: FlushPayload) => unknown,
 *   setTimeoutFn?: (callback: () => void, ms: number) => unknown,
 *   clearTimeoutFn?: (handle: unknown) => void,
 * }} options
 * @returns {{ push: (text: string) => boolean, flush: () => boolean, stop: () => void,
 *   readonly size: number, readonly pendingBytes: number }}
 */
export function createBatcher(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('batcher: options are required')
  }
  const { onFlush } = options
  if (typeof onFlush !== 'function') {
    throw new TypeError('batcher: onFlush is required')
  }
  const maxMessages = requireCount(options.maxMessages ?? DEFAULT_MAX_MESSAGES, 'maxMessages', 1)
  const maxBytes = requireCount(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes', 1)
  const windowMs = requireCount(options.windowMs ?? DEFAULT_WINDOW_MS, 'windowMs', 0)
  const setTimer = options.setTimeoutFn ?? setTimeout
  const clearTimer = options.clearTimeoutFn ?? clearTimeout
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('batcher: setTimeoutFn/clearTimeoutFn must be functions')
  }

  /** @type {Array<{ text: string, bytes: number }>} */
  let items = []
  let bufferedBytes = 0
  /** @type {unknown} */
  let timer = null
  let stopped = false

  function clearWindow() {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  /**
   * @param {Array<{ text: string, bytes: number }>} batch
   * @param {boolean} oversized
   */
  function emit(batch, oversized) {
    const text = batch.map((item) => item.text).join('\n\n')
    onFlush({ text, count: batch.length, bytes: utf8Bytes(text), oversized })
  }

  /** @returns {boolean} True when a pending batch was flushed. */
  function flushNow() {
    if (stopped || items.length === 0) return false
    const batch = items
    items = []
    bufferedBytes = 0
    clearWindow()
    emit(batch, false)
    return true
  }

  /**
   * @param {string} text
   * @returns {boolean} True when the text was accepted.
   */
  function push(text) {
    if (stopped) return false
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('batcher: push requires a non-empty string')
    }
    const bytes = utf8Bytes(text)

    if (bytes > maxBytes) {
      // A single message that cannot fit is delivered alone and marked, never
      // truncated or merged with neighbours.
      flushNow()
      emit([{ text, bytes }], true)
      return true
    }

    if (items.length > 0) {
      const projected = bufferedBytes + bytes + SEPARATOR_BYTES
      if (projected > maxBytes) flushNow()
    }

    items.push({ text, bytes })
    bufferedBytes += bytes

    if (items.length >= maxMessages) {
      flushNow()
      return true
    }
    if (timer === null) {
      timer = setTimer(() => {
        timer = null
        flushNow()
      }, windowMs)
    }
    return true
  }

  /** @returns {boolean} True when a pending batch was flushed. */
  function flush() {
    return flushNow()
  }

  function stop() {
    if (stopped) return
    stopped = true
    clearWindow()
    items = []
    bufferedBytes = 0
  }

  return {
    push,
    flush,
    stop,
    get size() {
      return items.length
    },
    get pendingBytes() {
      return bufferedBytes
    },
  }
}
