/**
 * Codex connector: joins a room as an agent member, keeps an SSE connection
 * open, batches wake messages, and delivers each batch with `codex queue`.
 *
 * Delivery semantics follow docs/DESIGN.md §10.2/§10.4:
 * - `queued` is a receipt only; the connector never claims the agent replied;
 * - the delivery cursor advances only after a receipt or an explicit skip;
 * - a retryable result is retried with 1s/2s/4s backoff while keeping the batch;
 * - a binding error (`target_missing`, `ambiguous_target`, `server_too_old`)
 *   and an oversized batch leave the cursor untouched and are reported as
 *   `error`, so the owner sees the binding needs attention.
 *
 * @module @llmagentchatroom/codex-connector/connector
 */

import { spawn } from 'node:child_process'
import { RoomClient, RoomError } from '../../dsh-plugin/src/room-client.js'
import { formatIncoming, shouldWake } from '../../dsh-plugin/src/format.js'
import { createBatcher } from './batcher.js'
import { buildQueueArgs, classifyQueueResult } from './queue.js'

const TARGET_LOADED = 'unknown'
const QUEUE_TIMEOUT_MS = 20_000
const HEARTBEAT_MS = 30_000
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 15_000
const STATUS_TIMEOUT_MS = 5_000
const OFFLINE_STATUS_TIMEOUT_MS = 2_000
const DETAIL_LIMIT = 500
const RUNNER_DETAIL_LIMIT = 300

/**
 * @param {unknown} value
 * @returns {string | null} Trimmed non-empty string, otherwise null.
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function requireString(name, value) {
  const text = optionalString(value)
  if (text === null) throw new TypeError(`codex-connector: ${name} is required`)
  return text
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof RoomError) {
    return error.status > 0 ? `${error.code} (HTTP ${error.status}): ${error.message}` : `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} logger
 * @returns {{ info: (message: string) => void, warn: (message: string) => void }}
 */
function normalizeLogger(logger) {
  const source = logger && typeof logger === 'object' ? logger : {}
  return {
    info: typeof source.info === 'function' ? (message) => source.info(message) : () => {},
    warn: typeof source.warn === 'function' ? (message) => source.warn(message) : () => {},
  }
}

/**
 * Sleep that resolves early when the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Default runner: spawn `codex` without a shell, capture stdout/stderr, and
 * classify the outcome. A 20s timeout bounds a wedged CLI.
 * @param {{ codexBin?: string, timeoutMs?: number }} [options]
 * @returns {(input: { target: string, text: string, args?: string[], signal?: AbortSignal }) => Promise<import('./queue.js').QueueResult>}
 */
export function createSpawnRunner(options = {}) {
  const codexBin = optionalString(options.codexBin) ?? 'codex'
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : QUEUE_TIMEOUT_MS

  return function runQueue(input) {
    const { target, text, signal } = input ?? {}
    if (signal?.aborted) {
      return Promise.resolve({ state: 'retryable', reason: 'spawn_failed', detail: 'aborted' })
    }
    let args
    try {
      args = buildQueueArgs({ target, text })
    } catch (error) {
      return Promise.resolve(classifyQueueResult({ stderr: describeError(error) }))
    }

    /** @type {import('node:child_process').ChildProcess | null} */
    let child = null
    try {
      child = spawn(codexBin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      return Promise.resolve(classifyQueueResult({ stderr: describeError(error) }))
    }

    return new Promise((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timedOut = false

      /** @param {import('./queue.js').QueueResult} value */
      function finish(value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      }

      const timer = setTimeout(() => {
        timedOut = true
        try {
          child?.kill()
        } catch {
          // The child may already have exited.
        }
        finish(classifyQueueResult({ code: null, stdout, stderr, timedOut: true }))
      }, timeoutMs)
      timer.unref?.()

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => {
        const code = /** @type {{ code?: string }} */ (error).code
        finish(
          classifyQueueResult({
            errorCode: code,
            stderr: [stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n'),
          }),
        )
      })
      child.on('close', (code, signalName) => {
        finish(
          classifyQueueResult({
            code: typeof code === 'number' ? code : null,
            stdout,
            stderr: signalName && stderr.length === 0 ? `terminated by ${signalName}` : stderr,
            timedOut,
          }),
        )
      })

      function onAbort() {
        try {
          child?.kill()
        } catch {
          // The child may already have exited.
        }
        finish({ state: 'retryable', reason: 'spawn_failed', detail: 'aborted' })
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }
}

/**
 * @typedef {object} ConnectorOptions
 * @property {string} server - Room server base URL.
 * @property {string} room - Room id.
 * @property {string} invite - Invite code.
 * @property {string} name - Member name in the room.
 * @property {string} target - `codex queue --thread` value (uuid or exact name).
 * @property {string} [codexBin='codex'] - CLI used by the default runner.
 * @property {string} [platform='codex'] - Platform label reported on join.
 * @property {{ maxMessages?: number, maxBytes?: number, windowMs?: number }} [batch]
 * @property {(input: { target: string, text: string, args: string[], signal: AbortSignal }) =>
 *   Promise<import('./queue.js').QueueResult>} [runQueue] - Injected delivery runner.
 * @property {AbortSignal} [signal] - External stop signal.
 * @property {{ info?: (message: string) => void, warn?: (message: string) => void }} [logger]
 */

/**
 * @typedef {object} ConnectorHandle
 * @property {readonly string} state - Last announced delivery state.
 * @property {readonly number} lastSeq - Highest seq delivered or explicitly skipped.
 * @property {readonly string} memberId - Joined member id.
 * @property {readonly boolean} closed - True once the connector stopped.
 * @property {string} room - Room id.
 * @property {string} target - Bound Codex thread.
 * @property {() => Promise<void>} stop - Stop the connector and wait for cleanup.
 */

/**
 * Create a connector. Call {@link ConnectorHandle} `start()` to join the room.
 * @param {ConnectorOptions} options
 * @returns {{ start: () => Promise<ConnectorHandle> }}
 */
export function createConnector(options = {}) {
  const server = requireString('server', options.server)
  const room = requireString('room', options.room)
  const invite = requireString('invite', options.invite)
  const name = requireString('name', options.name)
  const target = requireString('target', options.target)
  const codexBin = optionalString(options.codexBin) ?? 'codex'
  const platform = optionalString(options.platform) ?? 'codex'
  const logger = normalizeLogger(options.logger)
  const externalSignal = options.signal
  const batch = options.batch && typeof options.batch === 'object' ? options.batch : {}
  const runQueue = typeof options.runQueue === 'function' ? options.runQueue : createSpawnRunner({ codexBin })

  /** @type {RoomClient | null} */
  let client = null
  /** @type {AbortController | null} */
  let controller = null
  let memberId = ''
  let state = /** @type {'idle' | 'queued' | 'retryable' | 'error'} */ ('idle')
  let detail = /** @type {string | null} */ (null)
  let deliveredSeq = 0
  let closed = false
  let started = false
  let stopping = false
  /** @type {Promise<void> | null} */
  let loop = null
  /** @type {unknown} */
  let heartbeatTimer = null
  /** @type {Promise<unknown>} */
  let deliveryChain = Promise.resolve()

  /** Messages accepted by the batcher but not yet acknowledged. @type {Array<{ seq: number }>} */
  const pending = []
  /** Seqs that arrived and are not yet delivered (dedupes reconnect replays). @type {Set<number>} */
  const known = new Set()
  /** Seqs resolved out of order, waiting for their gap to fill. @type {Set<number>} */
  const resolved = new Set()

  const batcher = createBatcher({
    maxMessages: batch.maxMessages,
    maxBytes: batch.maxBytes,
    windowMs: batch.windowMs,
    onFlush(payload) {
      // Capture the matching pending entries synchronously so a later flush
      // cannot interleave with this one, then serialize delivery.
      const items = pending.splice(0, payload.count)
      enqueue(() => deliver(payload, items))
    },
  })

  /**
   * @param {() => Promise<void>} task
   */
  function enqueue(task) {
    deliveryChain = deliveryChain.then(task).catch((error) => {
      logger.warn(`connector: delivery failed: ${describeError(error)}`)
    })
  }

  /**
   * @param {import('./queue.js').QueueResult} result
   * @returns {string | null}
   */
  function resultDetail(result) {
    const message = result && typeof result.detail === 'string' && result.detail.length > 0 ? result.detail : null
    if (message !== null) return message
    return result && typeof result.reason === 'string' && result.reason.length > 0 ? result.reason : null
  }

  /**
   * Report the current connector state to the room.
   * @param {boolean} connectorOnline
   * @returns {Promise<void>}
   */
  async function reportStatus(connectorOnline) {
    if (!client || closed) return
    try {
      await client.status(
        {
          connectorOnline,
          deliveryState: state,
          targetLoaded: TARGET_LOADED,
          lastDeliveredSeq: deliveredSeq,
          detail,
        },
        { timeoutMs: STATUS_TIMEOUT_MS },
      )
    } catch (error) {
      logger.warn(`connector: status report failed: ${describeError(error)}`)
    }
  }

  /**
   * Change the announced state and report it when it actually changed.
   * @param {'idle' | 'queued' | 'retryable' | 'error'} next
   * @param {string | null} nextDetail
   * @returns {Promise<void>}
   */
  async function setState(next, nextDetail = null) {
    const normalized =
      typeof nextDetail === 'string' && nextDetail.length > 0 ? nextDetail.slice(0, DETAIL_LIMIT) : null
    if (state === next && detail === normalized) return
    state = next
    detail = normalized
    logger.info(`connector: state ${state}${detail ? ` (${detail})` : ''}`)
    await reportStatus(true)
  }

  /**
   * @param {number} seq
   */
  function resolveSeq(seq) {
    known.delete(seq)
    if (seq <= deliveredSeq) return
    resolved.add(seq)
    while (resolved.delete(deliveredSeq + 1)) deliveredSeq += 1
  }

  /**
   * Run the queue runner, turning a throw into a retryable classification.
   * @param {string} text
   * @returns {Promise<import('./queue.js').QueueResult>}
   */
  async function callRunQueue(text) {
    try {
      const args = buildQueueArgs({ target, text })
      const result = await runQueue({ target, text, args, signal: /** @type {AbortSignal} */ (controller?.signal) })
      if (!result || typeof result !== 'object' || typeof result.state !== 'string') {
        return { state: 'retryable', reason: 'spawn_failed', detail: 'runner returned no classification' }
      }
      return result
    } catch (error) {
      return {
        state: 'retryable',
        reason: 'spawn_failed',
        detail: describeError(error).slice(0, RUNNER_DETAIL_LIMIT),
      }
    }
  }

  /**
   * @param {import('./batcher.js').FlushPayload} payload
   * @param {Array<{ seq: number }>} items
   * @returns {Promise<void>}
   */
  async function deliver(payload, items) {
    if (closed) return
    if (payload.oversized) {
      logger.warn('connector: refusing to deliver a batch larger than maxBytes (no truncation)')
      await setState('error', 'batch_too_large')
      return
    }
    const seqs = items.map((item) => item.seq)
    await setState('queued', null)
    for (let attempt = 0; ; attempt += 1) {
      if (closed) return
      const result = await callRunQueue(payload.text)
      if (closed) return
      if (result.state === 'queued') {
        for (const seq of seqs) resolveSeq(seq)
        await setState('idle', null)
        return
      }
      if (result.state === 'error') {
        // The binding itself is wrong; keeping the cursor here makes a restart
        // replay the batch instead of silently losing it.
        await setState('error', resultDetail(result) ?? 'error')
        return
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        await setState('error', `retry_exhausted: ${resultDetail(result) ?? 'retryable'}`)
        return
      }
      await setState('retryable', resultDetail(result))
      await sleep(RETRY_DELAYS_MS[attempt], /** @type {AbortSignal} */ (controller?.signal))
    }
  }

  /**
   * @param {any} message
   */
  function handleMessage(message) {
    if (closed || !message || typeof message !== 'object') return
    if (!Number.isInteger(message.seq)) return
    const seq = message.seq
    if (seq <= deliveredSeq || known.has(seq)) return
    const authorId = message.author && typeof message.author === 'object' ? message.author.memberId : undefined
    if (authorId === memberId || !shouldWake(message, memberId)) {
      // Not addressed to this connector: explicitly skip it so the cursor can
      // move past it (docs/DESIGN.md §7.5).
      resolveSeq(seq)
      return
    }
    known.add(seq)
    pending.push({ seq })
    batcher.push(formatIncoming(message))
  }

  /**
   * @param {{ event?: string, data?: any }} frame
   * @returns {Promise<void>}
   */
  async function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.event === 'message') {
      handleMessage(frame.data)
      return
    }
    if (frame.event === 'member.removed' && frame.data?.memberId === memberId) {
      logger.warn('connector: member was removed from the room; stopping')
      await shutdown('member_removed')
    }
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  function isFatal(error) {
    if (!(error instanceof RoomError)) return false
    return error.status === 401 || error.status === 403 || error.code === 'member_revoked'
  }

  async function runLoop() {
    let backoff = RECONNECT_INITIAL_MS
    let since = 0
    while (!closed) {
      try {
        for await (const frame of /** @type {RoomClient} */ (client).events({
          signal: /** @type {AbortSignal} */ (controller?.signal),
          since,
        })) {
          backoff = RECONNECT_INITIAL_MS
          await handleFrame(frame)
          if (closed) return
          since = deliveredSeq
        }
      } catch (error) {
        if (closed || controller?.signal.aborted) return
        if (isFatal(error)) {
          logger.warn(`connector: stopping after ${describeError(error)}`)
          await shutdown('unauthorized')
          return
        }
        logger.warn(`connector: event stream failed: ${describeError(error)}`)
      }
      if (closed || controller?.signal.aborted) return
      since = deliveredSeq
      await sleep(backoff, /** @type {AbortSignal} */ (controller.signal))
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }

  /**
   * Stop accepting work and release the stream. Does not await the loop so it
   * can be called from inside it.
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async function shutdown(reason) {
    if (closed) return
    closed = true
    if (heartbeatTimer !== null) {
      clearTimeout(/** @type {NodeJS.Timeout} */ (heartbeatTimer))
      heartbeatTimer = null
    }
    batcher.stop()
    controller?.abort()
    client?.close()
    logger.info(`connector: stopped (${reason})`)
  }

  async function stop() {
    if (stopping) {
      await Promise.allSettled([Promise.resolve(loop), deliveryChain])
      return
    }
    stopping = true
    if (!closed) {
      // Best effort: show the connector as offline on the member panel. A kick
      // has already revoked the token, so failures are expected and ignored.
      try {
        await client?.status(
          {
            connectorOnline: false,
            deliveryState: state,
            targetLoaded: TARGET_LOADED,
            lastDeliveredSeq: deliveredSeq,
            detail: null,
          },
          { timeoutMs: OFFLINE_STATUS_TIMEOUT_MS },
        )
      } catch (error) {
        logger.warn(`connector: offline status report failed: ${describeError(error)}`)
      }
    }
    await shutdown('stopped')
    await Promise.allSettled([Promise.resolve(loop), deliveryChain])
  }

  /** @type {ConnectorHandle} */
  const handle = {
    get state() {
      return state
    },
    get lastSeq() {
      return deliveredSeq
    },
    get memberId() {
      return memberId
    },
    get closed() {
      return closed
    },
    room,
    target,
    stop,
  }

  function scheduleHeartbeat() {
    heartbeatTimer = setTimeout(() => {
      void reportStatus(true)
      if (!closed) scheduleHeartbeat()
    }, HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  }
  async function start() {
    if (started) throw new Error('codex-connector: start() already called')
    started = true
    if (externalSignal?.aborted) throw new Error('codex-connector: aborted before start')
    client = await RoomClient.join({ server, room, invite, name, platform })
    memberId = client.memberId
    controller = new AbortController()
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => {
        void shutdown('aborted')
      }, { once: true })
    }
    if (externalSignal?.aborted) {
      await shutdown('aborted')
      return handle
    }
    await reportStatus(true)
    scheduleHeartbeat()
    loop = runLoop()
    void loop.catch((error) => {
      logger.warn(`connector: event loop stopped: ${describeError(error)}`)
    })
    return handle
  }

  return { start }
}

/**
 * Create and start a connector in one call.
 * @param {ConnectorOptions} options
 * @returns {Promise<ConnectorHandle>}
 */
export async function start(options) {
  return createConnector(options).start()
}
