import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface OwnerSession {
  csrf: string
  expiresAt: number
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class AdminStore {
  readonly token: string
  private readonly sessions = new Map<string, OwnerSession>()

  constructor(tokenFile: string) {
    if (existsSync(tokenFile)) {
      this.token = readFileSync(tokenFile, 'utf8').trim()
    } else {
      this.token = newToken()
      mkdirSync(dirname(tokenFile), { recursive: true })
      writeFileSync(tokenFile, this.token + '\n', { encoding: 'utf8', mode: 0o600 })
    }
    if (this.token.length < 16) throw new Error('admin token file is malformed')
  }

  verify(token: string): boolean {
    return safeEqual(token, this.token)
  }

  createSession(ttlMs: number): { session: string; csrf: string; expiresAt: number } {
    const session = newToken()
    const csrf = newToken()
    const expiresAt = Date.now() + ttlMs
    this.sessions.set(session, { csrf, expiresAt })
    return { session, csrf, expiresAt }
  }

  getSession(session: string | undefined): OwnerSession | undefined {
    if (!session) return undefined
    const found = this.sessions.get(session)
    if (!found) return undefined
    if (found.expiresAt <= Date.now()) {
      this.sessions.delete(session)
      return undefined
    }
    return found
  }

  dropSession(session: string | undefined): void {
    if (session) this.sessions.delete(session)
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    out[key] = decodeURIComponent(value)
  }
  return out
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSeconds
}

export function clearCookieHeader(name: string): string {
  return name + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
}
