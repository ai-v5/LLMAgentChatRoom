import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import { AdminStore, clearCookieHeader, cookieHeader, hashToken, newToken } from './auth.ts'
import { findMember, findRoom, listMessages, maxSeq, openDatabase, type Db } from './db.ts'
import {
  API_PREFIX,
  PROTOCOL_VERSION,
  contentHash,
  newId,
  validateJoin,
  validateMessage,
  validateStatus,
  type Message,
  type MessageInput,
} from '../protocol/index.ts'
import { HttpError, RateLimiter, clientIp, header, readJson, requestId, sendError, sendJson } from './http.ts'
import {
  SESSION_COOKIE,
  enforceWriteGuards,
  requireAgent,
  requireOwner,
  resolvePrincipal,
  sessionId,
  type Principal,
} from './authz.ts'
import {
  authenticate,
  createRoom,
  getOwnerMember,
  history,
  joinRoom,
  kickMember,
  listRooms,
  membersOf,
  postMessage,
  rotateInvite,
  updateStatus,
  type RoomView,
} from './store.ts'
import { Connection, RoomHub, type OutboundEvent } from './sse.ts'

export interface AppConfig {
  dataDir: string
  adminTokenFile: string
  version: string
  sourceUrl: string
  limits?: { messagesPerMinute?: number; joinsPerMinute?: number }
}

export interface AppContext {
  db: Db
  admin: AdminStore
  hub: RoomHub
  limiter: RateLimiter
  config: AppConfig
  wakeBudget: Map<string, number[]>
  roomBudget: Map<string, number[]>
  startedAt: number
}

const STATIC_ASSETS = new Map<string, { body: Buffer; contentType: string }>([
  [
    '/',
    {
      body: readFileSync(new URL('../web/index.html', import.meta.url)),
      contentType: 'text/html; charset=utf-8',
    },
  ],
  [
    '/app.js',
    {
      body: readFileSync(new URL('../web/app.js', import.meta.url)),
      contentType: 'text/javascript; charset=utf-8',
    },
  ],
  [
    '/style.css',
    {
      body: readFileSync(new URL('../web/style.css', import.meta.url)),
      contentType: 'text/css; charset=utf-8',
    },
  ],
])

export function createContext(config: AppConfig): AppContext {
  const db = openDatabase(config.dataDir + '/llmroom.db')
  return {
    db,
    admin: new AdminStore(config.adminTokenFile),
    hub: new RoomHub(),
    limiter: new RateLimiter(),
    config,
    wakeBudget: new Map(),
    roomBudget: new Map(),
    startedAt: Date.now(),
  }
}

function ownerAuth(req: IncomingMessage, ctx: AppContext): { via: 'admin' | 'cookie'; csrf: string | null } {
  const auth = header(req, 'authorization')
  const cookie = sessionId(req)
  if (auth && cookie) throw new HttpError(400, 'credential_conflict', 'send either bearer or cookie')
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (!match || !ctx.admin.verify(match[1].trim())) {
      throw new HttpError(401, 'unauthorized', 'invalid admin token')
    }
    return { via: 'admin', csrf: null }
  }
  if (cookie) {
    const session = ctx.admin.getSession(cookie)
    if (!session) throw new HttpError(401, 'unauthorized', 'owner session expired')
    return { via: 'cookie', csrf: session.csrf }
  }
  throw new HttpError(401, 'unauthorized', 'owner authentication required')
}

function ownerWriteGuard(req: IncomingMessage, method: string, csrf: string | null): void {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  if (csrf === null) return
  const token = header(req, 'x-csrf-token')
  if (!token || token !== csrf) throw new HttpError(403, 'forbidden', 'csrf token mismatch')
}

function mapMessage(row: Message): Message {
  return row
}

function activeAgents(db: Db, roomId: string): string[] {
  const rows = db
    .prepare('SELECT id FROM members WHERE room_id = ? AND kind = ? AND status = ?')
    .all(roomId, 'agent', 'active') as Array<{ id: string }>
  return rows.map((row) => row.id)
}

function budgetAllow(ctx: AppContext, map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now()
  const list = (map.get(key) ?? []).filter((time) => now - time < 10 * 60 * 1000)
  if (list.length >= limit) {
    map.set(key, list)
    return false
  }
  list.push(now)
  map.set(key, list)
  return true
}

function computeWake(ctx: AppContext, roomId: string, author: Principal, requested: string[]): string[] {
  const agents = activeAgents(ctx.db, roomId)
  const candidates = requested.length > 0 ? requested.filter((id) => agents.includes(id)) : []
  const base = candidates.length > 0 ? candidates : author.member.kind === 'owner' ? agents : []
  const out: string[] = []
  for (const id of base) {
    if (id === author.member.id) continue
    if (!budgetAllow(ctx, ctx.wakeBudget, roomId + ':' + id, 10)) continue
    if (author.member.kind === 'agent' && !budgetAllow(ctx, ctx.roomBudget, roomId, 6)) break
    out.push(id)
  }
  return out
}

export function createApp(ctx: AppContext): Server {
  return createServer((req, res) => {
    void handle(req, res, ctx)
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  try {
    const asset = method === 'GET' ? STATIC_ASSETS.get(path) : undefined
    if (asset) {
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': asset.body.byteLength,
        'Cache-Control': 'no-cache',
      })
      res.end(asset.body)
      return
    }
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true, uptime: Date.now() - ctx.startedAt })
      return
    }
    if (method === 'GET' && path === '/about') {
      sendJson(res, 200, {
        name: 'llm-agent-chat-room',
        version: ctx.config.version,
        license: 'AGPL-3.0-only',
        source: ctx.config.sourceUrl,
        protocolVersion: PROTOCOL_VERSION,
      })
      return
    }
    if (method === 'GET' && path === '/login') {
      autoLogin(res, ctx, url)
      return
    }
    if (path === API_PREFIX + '/session') {
      if (method === 'POST') return await login(req, res, ctx)
      if (method === 'GET') return await whoami(req, res, ctx)
      if (method === 'DELETE') return await logout(req, res, ctx)
    }
    if (path === API_PREFIX + '/rooms') {
      if (method === 'GET') return listRoomsRoute(req, res, ctx)
      if (method === 'POST') return await createRoomRoute(req, res, ctx)
    }
    const match = /^\/api\/v1\/rooms\/([^/]+)(\/.*)?$/.exec(path)
    if (!match) {
      throw new HttpError(404, 'invalid_request', 'route not found')
    }
    const roomId = decodeURIComponent(match[1] as string)
    const rest = match[2] ?? ''
    if (rest === '/join' && method === 'POST') return await joinRoute(req, res, ctx, roomId)
    if (rest === '/invite/rotate' && method === 'POST') return await rotateRoute(req, res, ctx, roomId)
    if (rest === '/messages') {
      if (method === 'GET') return listMessagesRoute(req, res, ctx, roomId, url)
      if (method === 'POST') return await postMessageRoute(req, res, ctx, roomId)
    }
    if (rest === '/events' && method === 'GET') return openEvents(req, res, ctx, roomId, url)
    if (rest === '/members' && method === 'GET') return listMembersRoute(req, res, ctx, roomId)
    if (rest === '/members/self/status' && method === 'POST') return await statusRoute(req, res, ctx, roomId)
    const memberMatch = /^\/members\/([^/]+)$/.exec(rest)
    if (memberMatch && method === 'DELETE') {
      return await kickRoute(req, res, ctx, roomId, decodeURIComponent(memberMatch[1] as string))
    }
    throw new HttpError(404, 'invalid_request', 'route not found')
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.code, error.message)
      return
    }
    console.error('request failed', requestId(), error)
    sendError(res, 500, 'invalid_request', 'internal error')
  }
}

function autoLogin(res: ServerResponse, ctx: AppContext, url: URL): void {
  const token = url.searchParams.get('token') ?? ''
  if (!ctx.admin.verify(token)) {
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end('invalid token')
    return
  }
  const created = ctx.admin.createSession(12 * 60 * 60 * 1000)
  res.writeHead(303, {
    Location: '/',
    'Set-Cookie': cookieHeader(SESSION_COOKIE, created.session, 12 * 60 * 60),
    'Cache-Control': 'no-store',
  })
  res.end()
}

async function login(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const body = (await readJson(req)) as { token?: unknown }
  if (typeof body.token !== 'string' || !ctx.admin.verify(body.token)) {
    throw new HttpError(401, 'unauthorized', 'invalid admin token')
  }
  const created = ctx.admin.createSession(12 * 60 * 60 * 1000)
  res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, created.session, 12 * 60 * 60))
  sendJson(res, 200, { csrf: created.csrf, expiresAt: created.expiresAt })
}

async function whoami(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const session = sessionId(req)
  const found = ctx.admin.getSession(session)
  if (!found) throw new HttpError(401, 'unauthorized', 'owner session required')
  sendJson(res, 200, { csrf: found.csrf, expiresAt: found.expiresAt })
}

async function logout(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const session = sessionId(req)
  ctx.admin.dropSession(session)
  res.setHeader('Set-Cookie', clearCookieHeader(SESSION_COOKIE))
  sendJson(res, 200, { ok: true })
}

function listRoomsRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext): void {
  const auth = ownerAuth(req, ctx)
  ownerWriteGuard(req, req.method ?? 'GET', auth.csrf)
  sendJson(res, 200, { rooms: listRooms(ctx.db) })
}

async function createRoomRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const auth = ownerAuth(req, ctx)
  ownerWriteGuard(req, req.method ?? 'POST', auth.csrf)
  const body = (await readJson(req)) as { name?: unknown; topic?: unknown }
  if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 64) {
    throw new HttpError(400, 'invalid_request', 'name is invalid')
  }
  const topic = typeof body.topic === 'string' && body.topic.length <= 200 ? body.topic : null
  const created = createRoom(ctx.db, body.name.trim(), topic)
  sendJson(res, 201, created)
}

async function joinRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext, roomId: string): Promise<void> {
  if (!ctx.limiter.allow('join:' + clientIp(req), ctx.config.limits?.joinsPerMinute ?? 10, 60 * 1000)) {
    throw new HttpError(429, 'rate_limited', 'too many join attempts')
  }
  const body = await readJson(req)
  const parsed = validateJoin(body)
  if (!parsed.ok) throw new HttpError(400, parsed.code, parsed.message)
  const result = joinRoom(ctx.db, roomId, parsed.value.invite, parsed.value.name, parsed.value.platform)
  if ('error' in result) {
    if (result.error === 'room_not_found') throw new HttpError(404, 'room_not_found', 'room not found')
    if (result.error === 'name_taken') throw new HttpError(409, 'invalid_request', 'name already taken')
    throw new HttpError(403, 'forbidden', 'invite is invalid')
  }
  const owner = getOwnerMember(ctx.db, roomId)
  ctx.hub.broadcast(roomId, {
    event: 'member.joined',
    data: { memberId: result.member.id, name: result.member.name, platform: result.member.platform },
  })
  sendJson(res, 201, {
    member: { id: result.member.id, name: result.member.name, kind: result.member.kind, platform: result.member.platform },
    token: result.token,
    room: { id: roomId, name: findRoom(ctx.db, roomId)?.name ?? '' },
    owner: owner?.id ?? null,
  })
}

async function rotateRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext, roomId: string): Promise<void> {
  const auth = ownerAuth(req, ctx)
  ownerWriteGuard(req, req.method ?? 'POST', auth.csrf)
  const invite = rotateInvite(ctx.db, roomId)
  if (!invite) throw new HttpError(404, 'room_not_found', 'room not found')
  sendJson(res, 200, { invite })
}

async function postMessageRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext, roomId: string): Promise<void> {
  const principal = resolvePrincipal(req, ctx.db, ctx.admin, roomId)
  enforceWriteGuards(req, principal, req.method ?? 'POST')
  if (principal.kind === 'member' && !ctx.limiter.allow('msg:' + principal.member.id, ctx.config.limits?.messagesPerMinute ?? 60, 60 * 1000)) {
    throw new HttpError(429, 'rate_limited', 'message rate limit exceeded')
  }
  const body = await readJson(req)
  const parsed = validateMessage(body)
  if (!parsed.ok) throw new HttpError(parsed.code === 'payload_too_large' ? 413 : 400, parsed.code, parsed.message)
  const input = parsed.value as MessageInput
  if (input.forwardedFrom && principal.kind !== 'owner') {
    throw new HttpError(403, 'forbidden', 'only the owner can forward')
  }
  input.wake = computeWake(ctx, roomId, principal, input.wake)
  const result = postMessage(ctx.db, roomId, principal.member, input)
  if ('error' in result) {
    if (result.error === 'idempotency_conflict') {
      throw new HttpError(409, 'idempotency_conflict', 'clientMsgId reused with different content')
    }
    throw new HttpError(403, 'forbidden', 'member cannot post')
  }
  if (!result.duplicate) {
    const event: OutboundEvent = { event: 'message', id: result.message.seq, data: result.message }
    ctx.hub.broadcast(roomId, event, principal.member.id)
  }
  sendJson(res, result.duplicate ? 200 : 201, { message: mapMessage(result.message), duplicate: result.duplicate })
}

function listMessagesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  roomId: string,
  url: URL,
): void {
  resolvePrincipal(req, ctx.db, ctx.admin, roomId)
  const since = Number(url.searchParams.get('since') ?? '0')
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '200'), 200)
  if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit <= 0) {
    throw new HttpError(400, 'invalid_request', 'since/limit are invalid')
  }
  sendJson(res, 200, { messages: history(ctx.db, roomId, since, limit) })
}

function listMembersRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext, roomId: string): void {
  resolvePrincipal(req, ctx.db, ctx.admin, roomId)
  const members = membersOf(ctx.db, roomId).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    platform: row.platform,
    status: row.status,
    connectorOnline: row.connector_online === 1,
    deliveryState: row.delivery_state,
    targetLoaded: row.target_loaded,
    lastDeliveredSeq: row.last_delivered_seq,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  }))
  sendJson(res, 200, { members, connections: ctx.hub.count(roomId) })
}

async function statusRoute(req: IncomingMessage, res: ServerResponse, ctx: AppContext, roomId: string): Promise<void> {
  const principal = resolvePrincipal(req, ctx.db, ctx.admin, roomId)
  const agent = requireAgent(principal)
  const parsed = validateStatus(await readJson(req))
  if (!parsed.ok) throw new HttpError(400, parsed.code, parsed.message)
  updateStatus(ctx.db, roomId, agent.member.id, parsed.value)
  ctx.hub.broadcast(roomId, {
    event: 'member.status',
    data: {
      memberId: agent.member.id,
      connectorOnline: parsed.value.connectorOnline,
      deliveryState: parsed.value.deliveryState,
      targetLoaded: parsed.value.targetLoaded,
      lastDeliveredSeq: parsed.value.lastDeliveredSeq,
    },
  })
  sendJson(res, 200, { ok: true })
}

async function kickRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  roomId: string,
  memberId: string,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx.db, ctx.admin, roomId)
  const owner = requireOwner(principal)
  enforceWriteGuards(req, owner, req.method ?? 'DELETE')
  const ok = kickMember(ctx.db, roomId, memberId)
  if (!ok) throw new HttpError(404, 'invalid_request', 'member not found')
  ctx.hub.closeMember(roomId, memberId)
  ctx.hub.broadcast(roomId, { event: 'member.removed', data: { memberId } })
  sendJson(res, 200, { ok: true })
}

function openEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  roomId: string,
  url: URL,
): void {
  const principal = resolvePrincipal(req, ctx.db, ctx.admin, roomId)
  const rawSince = url.searchParams.get('since') ?? header(req, 'last-event-id') ?? '0'
  const since = Number(rawSince)
  if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'invalid_request', 'since is invalid')
  const connection = new Connection(res, roomId, principal.member.id)
  void ctx.hub.withLock(roomId, () => {
    ctx.hub.add(connection)
    return maxSeq(ctx.db, roomId)
  }).then((high) => {
    let cursor = since
    while (cursor < high) {
      const rows = listMessages(ctx.db, roomId, cursor, 200)
      if (rows.length === 0) break
      for (const row of rows) {
        const author = findMember(ctx.db, roomId, row.author_member_id)
        if (!author) continue
        const forwarded = row.forwarded_from_member_id
          ? findMember(ctx.db, roomId, row.forwarded_from_member_id) ?? null
          : null
        connection.write({
          event: 'message',
          id: row.seq,
          data: {
            id: row.id,
            room: row.room_id,
            seq: row.seq,
            ts: row.ts,
            author: { memberId: author.id, name: author.name, kind: author.kind, platform: author.platform },
            forwardedFrom: forwarded
              ? { memberId: forwarded.id, name: forwarded.name, kind: forwarded.kind, platform: forwarded.platform }
              : null,
            kind: row.kind,
            text: row.text,
            refs: JSON.parse(row.refs_json),
            replyTo: row.reply_to,
            wake: JSON.parse(row.wake_json),
            clientMsgId: row.client_msg_id,
            contentHash: row.content_hash,
          },
        })
        cursor = row.seq
      }
    }
    connection.flush()
  })
  const heartbeat = setInterval(() => {
    connection.write({ event: 'heartbeat', data: { ts: new Date().toISOString() } })
  }, 15000)
  res.on('close', () => {
    clearInterval(heartbeat)
    ctx.hub.remove(connection)
  })
}
