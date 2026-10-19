import type { IncomingMessage } from 'node:http'
import { parseCookies, type AdminStore } from './auth.ts'
import { findMember } from './db.ts'
import { getOwnerMember } from './store.ts'
import type { Db, MemberRow } from './db.ts'
import { HttpError, header } from './http.ts'

export const SESSION_COOKIE = 'llmroom_session'

export interface OwnerPrincipal {
  kind: 'owner'
  member: MemberRow
  via: 'admin' | 'cookie'
  csrf: string | null
}

export interface MemberPrincipal {
  kind: 'member'
  member: MemberRow
}

export type Principal = OwnerPrincipal | MemberPrincipal

export function bearer(req: IncomingMessage): string | null {
  const value = header(req, 'authorization')
  if (!value) return null
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match ? match[1].trim() : null
}

export function sessionId(req: IncomingMessage): string | null {
  return parseCookies(header(req, 'cookie'))[SESSION_COOKIE] ?? null
}

export function resolvePrincipal(
  req: IncomingMessage,
  db: Db,
  admin: AdminStore,
  roomId: string,
): Principal {
  const token = bearer(req)
  const session = sessionId(req)
  if (token && session) {
    throw new HttpError(400, 'credential_conflict', 'send either a bearer token or a cookie, not both')
  }
  if (token) {
    if (admin.verify(token)) {
      const member = getOwnerMember(db, roomId)
      if (!member) throw new HttpError(403, 'forbidden', 'owner member is missing')
      return { kind: 'owner', member, via: 'admin', csrf: null }
    }
    const member = db
      .prepare('SELECT * FROM members WHERE room_id = ? AND token_hash = ?')
      .get(roomId, hashToken(token)) as MemberRow | undefined
    if (!member || member.status !== 'active') {
      throw new HttpError(401, 'unauthorized', 'invalid member token')
    }
    return { kind: 'member', member }
  }
  if (session) {
    const found = admin.getSession(session)
    if (!found) throw new HttpError(401, 'unauthorized', 'owner session expired')
    const member = getOwnerMember(db, roomId)
    if (!member) throw new HttpError(403, 'forbidden', 'owner member is missing')
    return { kind: 'owner', member, via: 'cookie', csrf: found.csrf }
  }
  throw new HttpError(401, 'unauthorized', 'authentication required')
}

export function requireOwner(principal: Principal): OwnerPrincipal {
  if (principal.kind !== 'owner') throw new HttpError(403, 'forbidden', 'owner role required')
  return principal
}

export function requireAgent(principal: Principal): MemberPrincipal {
  if (principal.kind !== 'member') throw new HttpError(403, 'forbidden', 'agent member required')
  return principal
}

export function enforceWriteGuards(
  req: IncomingMessage,
  principal: Principal,
  method: string,
): void {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  if (principal.kind !== 'owner' || principal.via !== 'cookie') return
  const csrf = header(req, 'x-csrf-token')
  if (!csrf || csrf !== principal.csrf) {
    throw new HttpError(403, 'forbidden', 'csrf token mismatch')
  }
  const origin = header(req, 'origin')
  if (origin) {
    const host = header(req, 'host')
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      throw new HttpError(403, 'forbidden', 'origin is invalid')
    }
    if (!host || originHost !== host) {
      throw new HttpError(403, 'forbidden', 'origin mismatch')
    }
  }
}

import { hashToken } from './auth.ts'
