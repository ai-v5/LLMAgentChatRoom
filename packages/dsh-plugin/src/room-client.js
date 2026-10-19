/**
 * Dependency-free client for the LLMAgentChatRoom HTTP API, including the
 * Server-Sent Events loop. Only `fetch` and Web-standard streams are used so
 * the DSH host (Node 24) needs no runtime dependencies.
 * @module @llmagentchatroom/dsh-plugin/room-client
 */

import { randomUUID } from 'node:crypto'

const API_PREFIX = '/api/v1'
const DEFAULT_TIMEOUT_MS = 15_000
const CLIENT_MSG_ID = /^[A-Za-z0-9._-]{8,64}$/

/** Error thrown for a non-2xx response or a transport failure. */
export class RoomError extends Error {
  /**
   * @param {number} status - HTTP status, or 0 when no response was received.
   * @param {string} code - Server error code (`unauthorized`, `rate_limited`, ...).
   * @param {string} message - Human-readable detail.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'RoomError'
    this.status = status
    this.code = code
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`room client: ${field} is required`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @returns {string} Base URL without a trailing slash.
 */
function normalizeServer(value) {
  const raw = requireString(value, 'server')
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new TypeError(`room client: server is not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`room client: server must use http or https: ${raw}`)
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

/** @returns {string} A fresh idempotency key accepted by the room server. */
function newClientMsgId() {
  return `c-${randomUUID().replaceAll('-', '')}`
}

/**
 * @param {Response} response
 * @returns {Promise<RoomError>}
 */
async function responseError(response) {
  let code = 'invalid_response'
  let message = response.statusText || `HTTP ${response.status}`
  try {
    const body = await response.json()
    const error = body && typeof body === 'object' ? body.error : undefined
    if (error && typeof error === 'object') {
      if (typeof error.code === 'string' && error.code.length > 0) code = error.code
      if (typeof error.message === 'string' && error.message.length > 0) message = error.message
    }
  } catch {
    // A non-JSON error body keeps the HTTP status text.
  }
  return new RoomError(response.status, code, String(message).slice(0, 500))
}

/**
 * @param {unknown} error
 * @param {AbortSignal} timeout
 * @param {AbortSignal | undefined} caller
 * @returns {Error}
 */
function transportError(error, timeout, caller) {
  if (caller?.aborted) return /** @type {Error} */ (error)
  if (timeout.aborted) return new RoomError(0, 'request_timeout', 'request timed out')
  const message = error instanceof Error ? error.message : String(error)
  return new RoomError(0, 'network_error', message)
}

/**
 * Parse one SSE frame (the text between blank lines).
 * @param {string} raw - Frame text without the terminating blank line.
 * @returns {{ event: string, id: number | string | undefined, data: unknown } | null}
 */
export function parseSseFrame(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let id
  let event
  let data = ''
  let hasData = false
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') {
      data += (hasData ? '\n' : '') + value
      hasData = true
    }
  }
  if (!hasData) return null
  let parsed = data
  if (data.length > 0) {
    try {
      parsed = JSON.parse(data)
    } catch {
      parsed = data
    }
  }
  return {
    event: event || 'message',
    id: typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id,
    data: parsed,
  }
}

/**
 * A joined room member: HTTP calls plus a resumable SSE event iterator.
 */
export class RoomClient {
  /** @type {string} */
  #server
  /** @type {string} */
  #room
  /** @type {string} */
  #token = ''
  /** @type {string} */
  #memberId = ''
  /** @type {string} */
  #memberName = ''
  /** @type {string | null} */
  #roomName = null
  /** @type {string | null} */
  #ownerMemberId = null
  /** @type {number} */
  #lastSeq = 0
  /** @type {number} */
  #timeoutMs
  /** @type {(input: string, init?: RequestInit) => Promise<Response>} */
  #fetch
  /** @type {Set<AbortController>} */
  #streams = new Set()

  /**
   * @param {{ server: string, room: string, token?: string, memberId?: string,
   *   memberName?: string, lastSeq?: number, fetch?: typeof fetch, timeoutMs?: number }} options
   */
  constructor(options) {
    this.#server = normalizeServer(options.server)
    this.#room = requireString(options.room, 'room')
    if (options.token !== undefined) this.#token = requireString(options.token, 'token')
    if (options.memberId !== undefined) this.#memberId = requireString(options.memberId, 'memberId')
    if (options.memberName !== undefined) this.#memberName = String(options.memberName)
    if (options.lastSeq !== undefined) {
      if (!Number.isInteger(options.lastSeq) || options.lastSeq < 0) {
        throw new TypeError('room client: lastSeq must be a non-negative integer')
      }
      this.#lastSeq = options.lastSeq
    }
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const impl = options.fetch ?? globalThis.fetch
    if (typeof impl !== 'function') throw new TypeError('room client: fetch is unavailable')
    this.#fetch = (input, init) => impl(input, init)
  }

  /**
   * Join a room with an invite code.
   * @param {{ server: string, room: string, invite: string, name: string,
   *   platform?: string, fetch?: typeof fetch, timeoutMs?: number }} options
   * @returns {Promise<RoomClient>} Joined client.
   */
  static async join(options) {
    if (!options || typeof options !== 'object') throw new TypeError('room client: join options are required')
    const room = requireString(options.room, 'room')
    const invite = requireString(options.invite, 'invite')
    const name = requireString(options.name, 'name')
    const platform = options.platform === undefined ? 'dsh' : requireString(options.platform, 'platform')
    const client = new RoomClient({ server: options.server, room, fetch: options.fetch, timeoutMs: options.timeoutMs })
    const body = await client.#request(`/rooms/${encodeURIComponent(room)}/join`, {
      method: 'POST',
      body: { invite, name: name.slice(0, 64), platform: platform.slice(0, 32) },
    })
    const token = body && typeof body === 'object' ? body.token : undefined
    const member = body && typeof body === 'object' ? body.member : undefined
    const memberId = member && typeof member === 'object' ? member.id : undefined
    if (typeof token !== 'string' || token.length === 0 || typeof memberId !== 'string' || memberId.length === 0) {
      throw new RoomError(0, 'invalid_response', 'join response is missing token/member')
    }
    client.#token = token
    client.#memberId = memberId
    client.#memberName = typeof member.name === 'string' ? member.name : name
    client.#roomName = body.room && typeof body.room.name === 'string' ? body.room.name : null
    client.#ownerMemberId = typeof body.owner === 'string' ? body.owner : null
    return client
  }

  /**
   * Rebuild a client from persisted credentials without calling `/join`.
   * @param {{ server: string, room: string, token: string, memberId: string,
   *   memberName?: string, lastSeq?: number, fetch?: typeof fetch, timeoutMs?: number }} options
   * @returns {RoomClient} Resumable client.
   */
  static resume(options) {
    if (!options || typeof options !== 'object') throw new TypeError('room client: resume options are required')
    return new RoomClient({
      server: options.server,
      room: options.room,
      token: options.token,
      memberId: options.memberId,
      memberName: options.memberName,
      lastSeq: options.lastSeq,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    })
  }

  /** @returns {string} Normalized server base URL. */
  get server() {
    return this.#server
  }

  /** @returns {string} Room id. */
  get room() {
    return this.#room
  }

  /** @returns {string} Member bearer token. */
  get token() {
    return this.#token
  }

  /** @returns {string} Member id. */
  get memberId() {
    return this.#memberId
  }

  /** @returns {string} Member display name. */
  get memberName() {
    return this.#memberName
  }

  /** @returns {string | null} Room name reported by `/join`. */
  get roomName() {
    return this.#roomName
  }

  /** @returns {string | null} Owner member id reported by `/join`. */
  get ownerMemberId() {
    return this.#ownerMemberId
  }

  /** @returns {number} Highest message seq observed on the event stream. */
  get lastSeq() {
    return this.#lastSeq
  }

  /** @param {number} value - Highest observed seq; values only move forward. */
  set lastSeq(value) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError('room client: lastSeq must be a non-negative integer')
    }
    if (value > this.#lastSeq) this.#lastSeq = value
  }

  /**
   * Post a chat message. The same `clientMsgId` with identical content is
   * idempotent on the server, so a retried request cannot duplicate the message.
   * @param {string} text - Message body.
   * @param {{ clientMsgId?: string, replyTo?: string | null, wake?: string[],
   *   signal?: AbortSignal }} [options]
   * @returns {Promise<{ message: object, duplicate: boolean, clientMsgId: string }>}
   */
  async send(text, options = {}) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new TypeError('room client: send requires non-empty text')
    }
    const clientMsgId = options.clientMsgId ?? newClientMsgId()
    if (typeof clientMsgId !== 'string' || !CLIENT_MSG_ID.test(clientMsgId)) {
      throw new TypeError('room client: clientMsgId must be 8-64 chars of [A-Za-z0-9._-]')
    }
    const replyTo = options.replyTo ?? null
    if (replyTo !== null && (typeof replyTo !== 'string' || replyTo.length > 64)) {
      throw new TypeError('room client: replyTo must be a message id or null')
    }
    const wake = options.wake ?? []
    if (!Array.isArray(wake) || wake.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new TypeError('room client: wake must be an array of member ids')
    }
    const body = { clientMsgId, text, refs: [], replyTo, wake }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.#request(`/rooms/${encodeURIComponent(this.#room)}/messages`, {
          method: 'POST',
          body,
          signal: options.signal,
        })
        return {
          message: response && typeof response === 'object' ? response.message : null,
          duplicate: Boolean(response && typeof response === 'object' && response.duplicate),
          clientMsgId,
        }
      } catch (error) {
        const retryable = error instanceof RoomError && (error.status === 0 || error.status >= 500)
        if (!retryable || attempt >= 1 || options.signal?.aborted) throw error
      }
    }
  }

  /**
   * Read room history in seq order.
   * @param {number} [since] - Exclusive lower seq bound.
   * @param {number} [limit] - Page size (server caps at 200).
   * @returns {Promise<object[]>} Messages.
   */
  async history(since = 0, limit = 200) {
    if (!Number.isInteger(since) || since < 0) throw new TypeError('room client: since must be a non-negative integer')
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('room client: limit must be a positive integer')
    const params = new URLSearchParams({ since: String(since), limit: String(Math.min(limit, 200)) })
    const body = await this.#request(`/rooms/${encodeURIComponent(this.#room)}/messages?${params}`)
    const messages = body && typeof body === 'object' ? body.messages : undefined
    if (!Array.isArray(messages)) throw new RoomError(0, 'invalid_response', 'history response is missing messages')
    return messages
  }

  /**
   * Report this member's connector status.
   * @param {{ connectorOnline?: boolean, deliveryState?: string,
   *   targetLoaded?: 'true' | 'false' | 'unknown', lastDeliveredSeq?: number,
   *   detail?: string | null }} [update]
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean }>}
   */
  async status(update = {}, options = {}) {
    const body = {
      connectorOnline: update.connectorOnline ?? true,
      deliveryState: update.deliveryState ?? 'idle',
      targetLoaded: update.targetLoaded ?? 'unknown',
      lastDeliveredSeq: Number.isInteger(update.lastDeliveredSeq) ? update.lastDeliveredSeq : this.#lastSeq,
      detail: update.detail ?? null,
    }
    return /** @type {{ ok: boolean }} */ (await this.#request(
      `/rooms/${encodeURIComponent(this.#room)}/members/self/status`,
      { method: 'POST', body, signal: options.signal, timeoutMs: options.timeoutMs },
    ))
  }

  /**
   * Stream SSE frames, reconnecting is the caller's responsibility. The
   * iterator ends on abort, server close, or stream end.
   * @param {{ signal?: AbortSignal, since?: number }} [options]
   * @yields {{ event: string, id: number | string | undefined, data: unknown }}
   */
  async *events(options = {}) {
    const caller = options.signal
    const since = Number.isInteger(options.since) ? options.since : this.#lastSeq
    const controller = new AbortController()
    this.#streams.add(controller)
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
    /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
    let reader
    try {
      const url = `${this.#server}${API_PREFIX}/rooms/${encodeURIComponent(this.#room)}/events?since=${since}`
      /** @type {Response} */
      let response
      try {
        response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${this.#token}`, accept: 'text/event-stream' },
          signal,
        })
      } catch (error) {
        if (signal.aborted) return
        throw new RoomError(0, 'network_error', error instanceof Error ? error.message : String(error))
      }
      if (!response.ok) throw await responseError(response)
      if (!response.body) throw new RoomError(response.status, 'invalid_response', 'event stream has no body')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        /** @type {ReadableStreamReadResult<Uint8Array>} */
        let chunk
        try {
          chunk = await reader.read()
        } catch (error) {
          if (signal.aborted) return
          throw new RoomError(0, 'network_error', error instanceof Error ? error.message : String(error))
        }
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary === -1) break
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseSseFrame(raw)
          if (!frame) continue
          this.#observe(frame)
          yield frame
        }
      }
      const tail = parseSseFrame(buffer)
      if (tail) {
        this.#observe(tail)
        yield tail
      }
    } finally {
      this.#streams.delete(controller)
      if (reader) {
        try {
          await reader.cancel()
        } catch {
          // The stream may already be errored or closed.
        }
      }
    }
  }

  /** Abort every active event stream and send request owned by this client. */
  close() {
    for (const controller of this.#streams) controller.abort()
    this.#streams.clear()
  }

  /**
   * @param {{ event: string, id: number | string | undefined, data: unknown }} frame
   */
  #observe(frame) {
    if (frame.event !== 'message') return
    const data = frame.data && typeof frame.data === 'object' ? frame.data : null
    const seq = Number.isInteger(frame.id)
      ? frame.id
      : data && Number.isInteger(data.seq)
        ? data.seq
        : undefined
    if (typeof seq === 'number' && seq > this.#lastSeq) this.#lastSeq = seq
  }

  /**
   * @param {string} path - Path below `/api/v1`.
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  async #request(path, options = {}) {
    const headers = { accept: 'application/json' }
    if (this.#token.length > 0) headers.authorization = `Bearer ${this.#token}`
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    /** @type {Response} */
    let response
    try {
      response = await this.#fetch(`${this.#server}${API_PREFIX}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      })
    } catch (error) {
      throw transportError(error, timeout, options.signal)
    }
    if (!response.ok) throw await responseError(response)
    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      throw new RoomError(response.status, 'invalid_response', 'response body is not JSON')
    }
  }
}
