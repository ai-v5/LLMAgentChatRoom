/**
 * DSH host plugin that joins one LLMAgentChatRoom per Session, keeps an SSE
 * connection open, and injects wake messages as `chat-room` user messages.
 * The DSH imports are injected by `index.js` so this module stays testable
 * without a running Harness.
 * @module @llmagentchatroom/dsh-plugin/plugin
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { RoomClient, RoomError } from './room-client.js'
import { authorLabel, formatIncoming, messageKind, shouldWake } from './format.js'

/** Plugin name registered with the DSH loader. */
export const PLUGIN_NAME = 'llmagentchatroom'

/** Host services this plugin consumes. */
export const INJECT = ['tools', 'sessionController', 'sessions']

const TARGET_LOADED = 'unknown'
const BACKOFF_INITIAL_MS = 500
const BACKOFF_MAX_MS = 15_000
const PERSIST_DEBOUNCE_MS = 200

/**
 * @param {unknown} value
 * @returns {string | null} Trimmed non-empty string, otherwise null.
 */
function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
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
 * @param {string} tool
 * @param {unknown} error
 * @returns {Error}
 */
function toolError(tool, error) {
  if (error instanceof RoomError) {
    const status = error.status > 0 ? ` (HTTP ${error.status})` : ''
    return new Error(`${tool} failed: ${error.code}${status}: ${error.message}`)
  }
  return error instanceof Error ? error : new Error(`${tool} failed: ${String(error)}`)
}

/**
 * Read and normalize plugin configuration.
 * @param {unknown} config
 */
function readConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const platform = optionalString(source.platform) ?? 'dsh'
  if (platform.length > 32) throw new Error('dsh-plugin: platform must be at most 32 characters')
  return {
    server: optionalString(source.server),
    room: optionalString(source.room),
    invite: optionalString(source.invite),
    name: optionalString(source.name),
    platform,
    autoStart: source.autoStart === true,
    credentialsFile: optionalString(source.credentialsFile),
  }
}

/**
 * @param {string} sessionId
 * @returns {string} Short deterministic suffix for a default member name.
 */
function sessionSuffix(sessionId) {
  const clean = String(sessionId).replace(/[^A-Za-z0-9]/g, '')
  return clean.length > 0 ? clean.slice(-8) : 'session'
}

/**
 * Load the credential file, treating an absent or malformed file as empty.
 * @param {string | null} file
 * @param {{ warn: (message: string) => void }} log
 * @returns {Record<string, object>}
 */
function loadCredentials(file, log) {
  if (!file) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessions = parsed && typeof parsed === 'object' ? parsed.sessions : undefined
    return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {}
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code !== 'ENOENT') {
      log.warn(`chat-room: ignoring unreadable credentials file: ${describeError(error)}`)
    }
    return {}
  }
}

/**
 * Persist membership tokens atomically with owner-only permissions.
 * @param {string | null} file
 * @param {Record<string, object>} sessions
 * @param {{ warn: (message: string) => void }} log
 */
function saveCredentials(file, sessions, log) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, file)
  } catch (error) {
    log.warn(`chat-room: writing credentials file failed: ${describeError(error)}`)
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>} Resolves after the delay or when aborted.
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
 * Build the DSH plugin object.
 * @param {{ defineTool: Function, createUserMessage: Function }} dsh
 * @returns {{ name: string, inject: string[], apply: (ctx: any, config?: unknown) => void }}
 */
export function createRoomPlugin(dsh) {
  const { defineTool, createUserMessage } = dsh ?? {}
  if (typeof defineTool !== 'function') throw new TypeError('createRoomPlugin: defineTool is required')
  if (typeof createUserMessage !== 'function') throw new TypeError('createRoomPlugin: createUserMessage is required')

  /**
   * @param {any} ctx
   * @param {unknown} config
   */
  function apply(ctx, config) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('dsh-plugin: a context is required')
    if (typeof ctx.effect !== 'function') throw new TypeError('dsh-plugin: ctx.effect is required')
    if (typeof ctx.tools?.register !== 'function') throw new TypeError('dsh-plugin: ctx.tools.register is required')

    const settings = readConfig(config)
    const log = {
      warn(message) {
        ctx.logger?.warn(message)
      },
    }
    /** @type {Map<string, any>} */
    const bindings = new Map()
    /** @type {Record<string, any>} */
    const persisted = loadCredentials(settings.credentialsFile, log)
    let disposed = false
    let persistTimer = null
    let persistDirty = false

    function persistNow() {
      persistDirty = false
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      if (!settings.credentialsFile) return
      const sessions = {}
      for (const [sessionId, binding] of bindings) {
        if (binding.closed) continue
        sessions[sessionId] = {
          server: binding.server,
          room: binding.room,
          memberId: binding.memberId,
          memberName: binding.memberName,
          token: binding.client.token,
          lastSeq: binding.deliveredSeq,
        }
      }
      saveCredentials(settings.credentialsFile, sessions, log)
    }

    function schedulePersist() {
      if (disposed || !settings.credentialsFile) return
      persistDirty = true
      if (persistTimer) return
      persistTimer = setTimeout(() => {
        persistTimer = null
        if (!disposed && persistDirty) persistNow()
      }, PERSIST_DEBOUNCE_MS)
      persistTimer.unref?.()
    }

    /**
     * @param {any} binding
     * @param {string} state - `idle | queued | unknown | error`.
     * @param {string | null} detail
     */
    async function reportStatus(binding, state, detail = null) {
      if (binding.closed) return
      binding.deliveryState = state
      try {
        await binding.client.status({
          connectorOnline: true,
          deliveryState: state,
          targetLoaded: TARGET_LOADED,
          lastDeliveredSeq: binding.deliveredSeq,
          detail,
        }, { timeoutMs: 5000 })
      } catch (error) {
        if (!binding.closed) log.warn(`chat-room: status report failed: ${describeError(error)}`)
      }
    }

    /**
     * @param {any} binding
     * @param {number} seq
     */
    function advanceDelivered(binding, seq) {
      if (!isCount(seq) || seq <= binding.deliveredSeq) return
      binding.deliveredSeq = seq
      schedulePersist()
    }

    /**
     * @param {string} sessionId
     * @param {string} text
     * @param {string} roomId
     * @param {string} messageId
     */
    async function pushToAgent(sessionId, text, roomId, messageId) {
      if (!ctx.sessionController || typeof ctx.sessionController.resolveAgent !== 'function') {
        throw new Error('sessionController service is unavailable')
      }
      if (!ctx.sessions || typeof ctx.sessions.flush !== 'function') {
        throw new Error('sessions service is unavailable')
      }
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (!resolved || typeof resolved !== 'object') throw new Error('resolveAgent returned no result')
      if ('error' in resolved) {
        throw resolved.error instanceof Error ? resolved.error : new Error(String(resolved.error))
      }
      const agent = resolved.agent
      if (!agent || typeof agent.followup !== 'function') throw new Error('resolveAgent returned no agent')
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'chat-room', roomId, messageId },
      })
      agent.followup(message)
      const flushed = await ctx.sessions.flush(agent.session)
      if (!flushed) throw new Error('session persistence did not acknowledge the chat-room message')
    }

    /**
     * @param {any} binding
     * @param {any} message
     */
    async function handleMessage(binding, message) {
      if (!message || typeof message !== 'object' || !Number.isInteger(message.seq)) return
      if (message.author?.memberId === binding.memberId || !shouldWake(message, binding.memberId)) {
        advanceDelivered(binding, message.seq)
        return
      }
      await reportStatus(binding, 'queued', null)
      if (binding.closed || disposed) return
      // The delivery cursor only advances after flush acknowledges durability,
      // so a reconnect replays this message instead of losing it.
      await pushToAgent(binding.sessionId, formatIncoming(message), binding.room, String(message.id ?? ''))
      if (binding.closed || disposed) return
      advanceDelivered(binding, message.seq)
      await reportStatus(binding, 'idle', null)
    }

    /**
     * @param {any} binding
     * @param {string} reason
     */
    function detachBinding(binding, reason) {
      if (binding.closed) return
      binding.closed = true
      binding.controller.abort()
      binding.client.close()
      bindings.delete(binding.sessionId)
      persistNow()
      if (reason !== 'leave') {
        log.warn(`chat-room: session ${binding.sessionId} unbound from room ${binding.room} (${reason})`)
      }
    }

    /**
     * Background SSE loop. Never throws: all failures are logged and reported.
     * @param {any} binding
     */
    async function runLoop(binding) {
      let backoff = BACKOFF_INITIAL_MS
      while (!binding.closed && !disposed) {
        try {
          await reportStatus(binding, 'idle', null)
          for await (const frame of binding.client.events({
            signal: binding.controller.signal,
            since: binding.deliveredSeq,
          })) {
            if (binding.closed || disposed) return
            backoff = BACKOFF_INITIAL_MS
            if (frame.event === 'message') {
              await handleMessage(binding, frame.data)
            } else if (frame.event === 'member.removed' && frame.data?.memberId === binding.memberId) {
              detachBinding(binding, 'member_removed')
              return
            }
          }
        } catch (error) {
          if (binding.closed || disposed || binding.controller.signal.aborted) return
          log.warn(`chat-room: event stream for room ${binding.room} failed: ${describeError(error)}`)
          await reportStatus(binding, 'error', describeError(error))
          if (
            error instanceof RoomError
            && (error.status === 401 || error.status === 403 || error.code === 'member_revoked')
          ) {
            detachBinding(binding, 'unauthorized')
            return
          }
        }
        if (binding.closed || disposed) return
        await sleep(backoff, binding.controller.signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }

    /**
     * @param {string} sessionId
     * @param {RoomClient} client
     */
    function bind(sessionId, client) {
      if (disposed) {
        client.close()
        throw new Error('chat-room: plugin is stopping')
      }
      const binding = {
        sessionId,
        client,
        server: client.server,
        room: client.room,
        memberId: client.memberId,
        memberName: client.memberName,
        deliveredSeq: client.lastSeq,
        controller: new AbortController(),
        closed: false,
        deliveryState: 'idle',
        worker: null,
      }
      bindings.set(sessionId, binding)
      persistNow()
      binding.worker = runLoop(binding).catch((error) => {
        log.warn(`chat-room: event loop for room ${binding.room} stopped: ${describeError(error)}`)
      })
      return binding
    }

    /**
     * @param {string} sessionId
     * @param {{ server: string, room: string, invite: string, name: string, platform: string }} options
     */
    async function joinSession(sessionId, options) {
      const client = await RoomClient.join(options)
      return bind(sessionId, client)
    }

    /**
     * Resolve the session binding, resuming persisted credentials or joining
     * the configured room when `autoStart` is enabled.
     * @param {string} sessionId
     */
    async function ensureBinding(sessionId) {
      const existing = bindings.get(sessionId)
      if (existing && !existing.closed) return existing
      const saved = persisted[sessionId]
      if (saved && typeof saved === 'object' && saved.token) {
        try {
          const client = RoomClient.resume({
            server: saved.server,
            room: saved.room,
            token: saved.token,
            memberId: saved.memberId,
            memberName: saved.memberName,
            lastSeq: isCount(saved.lastSeq) ? saved.lastSeq : 0,
          })
          return bind(sessionId, client)
        } catch (error) {
          log.warn(`chat-room: resuming saved membership failed: ${describeError(error)}`)
          delete persisted[sessionId]
          persistNow()
        }
      }
      if (!settings.autoStart) {
        throw new Error('room_not_joined: call room_join first, or enable autoStart with server/room/invite config')
      }
      if (!settings.server || !settings.room || !settings.invite) {
        throw new Error('room_not_joined: autoStart requires server, room, and invite in the plugin config')
      }
      return joinSession(sessionId, {
        server: settings.server,
        room: settings.room,
        invite: settings.invite,
        name: settings.name ?? `dsh-${sessionSuffix(sessionId)}`,
        platform: settings.platform,
      })
    }

    /**
     * @param {any} binding
     * @returns {object} Stable view of the binding.
     */
    function bindingView(binding, alreadyJoined = false) {
      return {
        ok: true,
        alreadyJoined,
        server: binding.server,
        room: binding.room,
        roomName: binding.client.roomName ?? '',
        memberId: binding.memberId,
        memberName: binding.memberName,
        lastSeq: binding.deliveredSeq,
      }
    }

    const bindingProperties = {
      server: { type: 'string', required: true },
      room: { type: 'string', required: true },
      roomName: { type: 'string', required: true },
      memberId: { type: 'string', required: true },
      memberName: { type: 'string', required: true },
      lastSeq: { type: 'integer', required: true },
    }

    ctx.tools.register(defineTool({
      name: 'room_join',
      description: 'Join an LLMAgentChatRoom as this DSH session and start receiving wake messages. One binding per session; call room_leave before switching rooms. Arguments fall back to plugin config. The invite code is never echoed.',
      parameters: {
        server: { type: 'string', description: 'Room server base URL, for example http://127.0.0.1:8787.' },
        room: { type: 'string', description: 'Room id.' },
        invite: { type: 'string', description: 'Invite code for the room.' },
        name: { type: 'string', description: 'Member name unique within the room.' },
        platform: { type: 'string', description: 'Platform label reported to the room (default dsh).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, alreadyJoined: { type: 'boolean', required: true }, ...bindingProperties },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `joined room ${value.room} as ${value.memberName} (${value.memberId}) on ${value.server}`,
        }],
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const server = optionalString(args.server) ?? settings.server
        const room = optionalString(args.room) ?? settings.room
        const invite = optionalString(args.invite) ?? settings.invite
        if (!server || !room || !invite) {
          throw new Error('room_join requires server, room, and invite (arguments or plugin config)')
        }
        const name = (optionalString(args.name) ?? settings.name ?? `dsh-${sessionSuffix(sessionId)}`).slice(0, 64)
        const platform = (optionalString(args.platform) ?? settings.platform).slice(0, 32)
        const existing = bindings.get(sessionId)
        if (existing && !existing.closed) {
          if (existing.room === room) return bindingView(existing, true)
          throw new Error(`room_join: session is already bound to room ${existing.room}; call room_leave first`)
        }
        try {
          return bindingView(await joinSession(sessionId, { server, room, invite, name, platform }))
        } catch (error) {
          throw toolError('room_join', error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'room_send',
      description: 'Send a text message to the bound room. wake lists member ids to explicitly wake; the default empty list records without waking. Reusing client_msg_id with identical content is idempotent.',
      parameters: {
        text: { type: 'string', required: true, description: 'Message body (UTF-8, at most 8 KiB).' },
        client_msg_id: { type: 'string', description: 'Idempotency key, 8-64 chars of [A-Za-z0-9._-].' },
        reply_to: { type: 'string', description: 'Message id this message replies to.' },
        wake: { type: 'array', items: { type: 'string' }, description: 'Member ids to wake explicitly.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            room: { type: 'string', required: true },
            clientMsgId: { type: 'string', required: true },
            messageId: { type: 'string', required: true },
            seq: { type: 'integer', required: true },
            duplicate: { type: 'boolean', required: true },
            ts: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.duplicate
            ? `already sent (msg=${value.messageId} seq=${value.seq})`
            : `sent msg=${value.messageId} seq=${value.seq}`,
        }],
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const binding = await ensureBinding(sessionId)
        try {
          const result = await binding.client.send(args.text, {
            clientMsgId: args.client_msg_id,
            replyTo: args.reply_to ?? null,
            wake: Array.isArray(args.wake) ? args.wake : [],
            signal: exec.signal,
          })
          const message = result.message
          if (!message || typeof message !== 'object' || !Number.isInteger(message.seq)) {
            throw new RoomError(0, 'invalid_response', 'send response is missing the message')
          }
          return {
            ok: true,
            room: binding.room,
            clientMsgId: result.clientMsgId,
            messageId: String(message.id ?? ''),
            seq: message.seq,
            duplicate: result.duplicate,
            ts: String(message.ts ?? ''),
          }
        } catch (error) {
          throw toolError('room_send', error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'room_read',
      description: 'Read room history in seq order. Defaults to messages after the delivery cursor; pass since=0 to read the full retained history.',
      parameters: {
        since: { type: 'integer', description: 'Exclusive lower seq bound.' },
        limit: { type: 'integer', description: 'Maximum messages to return (server cap 200).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            lastSeq: { type: 'integer', required: true },
            messages: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  seq: { type: 'integer', required: true },
                  ts: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  from: { type: 'string', required: true },
                  forwardedFrom: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                  replyTo: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.count === 0) return [{ type: 'text', text: 'no messages' }]
          const lines = value.messages.map((message) => {
            const forwarded = message.forwardedFrom ? ` forwarded_from=${message.forwardedFrom}` : ''
            return `[chat-room msg=${message.id} seq=${message.seq} from=${message.from}${forwarded} kind=${message.kind} ts=${message.ts}]\n${message.text}`
          })
          return [{ type: 'text', text: lines.join('\n\n') }]
        },
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const binding = await ensureBinding(sessionId)
        const since = isCount(args.since) ? args.since : binding.deliveredSeq
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50
        try {
          const messages = await binding.client.history(since, limit)
          return {
            count: messages.length,
            lastSeq: binding.client.lastSeq,
            messages: messages.map((message) => ({
              id: String(message?.id ?? ''),
              seq: Number.isInteger(message?.seq) ? message.seq : 0,
              ts: String(message?.ts ?? ''),
              kind: messageKind(message),
              from: authorLabel(message?.author),
              forwardedFrom: message?.forwardedFrom ? authorLabel(message.forwardedFrom) : '',
              text: typeof message?.text === 'string' ? message.text : '',
              replyTo: typeof message?.replyTo === 'string' ? message.replyTo : '',
            })),
          }
        } catch (error) {
          throw toolError('room_read', error)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'room_status',
      description: 'Report this connector\'s status to the room (idle, queued, unknown, or error) and return the current binding state. targetLoaded is always unknown.',
      parameters: {
        delivery_state: {
          type: 'string',
          enum: ['idle', 'queued', 'unknown', 'error'],
          description: 'Delivery state to report.',
        },
        detail: { type: 'string', description: 'Short human-readable detail (at most 500 chars).' },
        connector_online: { type: 'boolean', description: 'Whether the connector is online (default true).' },
        last_delivered_seq: { type: 'integer', description: 'Last seq acknowledged by the session.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            bound: { type: 'boolean', required: true },
            server: { type: 'string', required: true },
            room: { type: 'string', required: true },
            memberId: { type: 'string', required: true },
            memberName: { type: 'string', required: true },
            deliveryState: { type: 'string', required: true },
            targetLoaded: { type: 'string', required: true },
            lastSeq: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.bound
            ? `room ${value.room}: ${value.deliveryState} (seq ${value.lastSeq}, targetLoaded ${value.targetLoaded})`
            : 'not bound to a room',
        }],
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        let binding = bindings.get(sessionId)
        if (!binding && settings.autoStart) binding = await ensureBinding(sessionId)
        if (!binding) {
          return {
            ok: true,
            bound: false,
            server: settings.server ?? '',
            room: settings.room ?? '',
            memberId: '',
            memberName: '',
            deliveryState: 'unknown',
            targetLoaded: TARGET_LOADED,
            lastSeq: 0,
          }
        }
        const state = args.delivery_state ?? 'idle'
        const detail = typeof args.detail === 'string' ? args.detail.slice(0, 500) : null
        try {
          await binding.client.status({
            connectorOnline: args.connector_online ?? true,
            deliveryState: state,
            targetLoaded: TARGET_LOADED,
            lastDeliveredSeq: isCount(args.last_delivered_seq) ? args.last_delivered_seq : binding.deliveredSeq,
            detail,
          })
        } catch (error) {
          throw toolError('room_status', error)
        }
        binding.deliveryState = state
        return {
          ok: true,
          bound: true,
          server: binding.server,
          room: binding.room,
          memberId: binding.memberId,
          memberName: binding.memberName,
          deliveryState: state,
          targetLoaded: TARGET_LOADED,
          lastSeq: binding.deliveredSeq,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'room_leave',
      description: 'Leave the bound room and stop its event stream. The server membership token stays valid until the owner kicks the member.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            left: { type: 'boolean', required: true },
            room: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.left ? `left room ${value.room}` : 'not bound to a room' }],
      },
      async execute(_args, exec) {
        const sessionId = sessionIdOf(exec)
        const binding = bindings.get(sessionId)
        if (!binding || binding.closed) return { ok: true, left: false, room: '' }
        try {
          await binding.client.status({
            connectorOnline: false,
            deliveryState: 'idle',
            targetLoaded: TARGET_LOADED,
            lastDeliveredSeq: binding.deliveredSeq,
            detail: null,
          })
        } catch (error) {
          log.warn(`chat-room: offline status report failed: ${describeError(error)}`)
        }
        detachBinding(binding, 'leave')
        await Promise.resolve(binding.worker).catch(() => undefined)
        return { ok: true, left: true, room: binding.room }
      },
    }))

    ctx.effect(() => () => {
      if (disposed) return
      disposed = true
      persistNow()
      const active = [...bindings.values()]
      for (const binding of active) {
        binding.closed = true
        binding.controller.abort()
        binding.client.close()
      }
      bindings.clear()
      return Promise.allSettled(active.map((binding) => Promise.resolve(binding.worker)))
    })
  }

  return { name: PLUGIN_NAME, inject: [...INJECT], apply }
}

/**
 * @param {any} exec
 * @returns {string} The current DSH session id.
 */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('room tools require an agent session (exec.agent.session.id is missing)')
  }
  return id
}
