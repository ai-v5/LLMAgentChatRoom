import { createHash, randomUUID } from 'node:crypto'

export const API_PREFIX = '/api/v1'
export const PROTOCOL_VERSION = 1

export const LIMITS = {
  textBytes: 8192,
  refs: 20,
  wake: 50,
  memberNameMax: 64,
  roomNameMax: 64,
  clientMsgIdMin: 8,
  clientMsgIdMax: 64,
  pageSize: 200,
  batchMessages: 20,
  batchBytes: 24 * 1024,
} as const

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'credential_conflict'
  | 'room_not_found'
  | 'member_revoked'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'version_unsupported'
  | 'invalid_request'

export type MemberKind = 'owner' | 'agent'
export type MessageKind = 'chat' | 'system'
export type DeliveryState =
  | 'idle'
  | 'queued'
  | 'retryable'
  | 'unknown'
  | 'error'
  | 'budget_exceeded'

export interface Author {
  memberId: string
  name: string
  kind: MemberKind
  platform: string | null
}

export interface Message {
  id: string
  room: string
  seq: number
  ts: string
  author: Author
  forwardedFrom: Author | null
  kind: MessageKind
  text: string
  refs: string[]
  replyTo: string | null
  wake: string[]
  clientMsgId: string
  contentHash: string
}

export interface JoinInput {
  invite: string
  name: string
  platform: string
}

export interface MessageInput {
  clientMsgId: string
  text: string
  refs: string[]
  replyTo: string | null
  wake: string[]
  forwardedFrom: string | null
}

export interface StatusInput {
  connectorOnline: boolean
  deliveryState: DeliveryState
  targetLoaded: 'true' | 'false' | 'unknown'
  lastDeliveredSeq: number
  detail: string | null
}

export interface ValidationOk<T> {
  ok: true
  value: T
}

export interface ValidationErr {
  ok: false
  code: ErrorCode
  message: string
}

export type Validation<T> = ValidationOk<T> | ValidationErr

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, max: number): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  if (value.length > max) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (trimmed.length === 0) return null
    if (utf8Bytes(trimmed) > 1024) return null
    out.push(trimmed)
  }
  return out
}

export function validateJoin(value: unknown): Validation<JoinInput> {
  if (!isRecord(value)) return { ok: false, code: 'invalid_request', message: 'body must be an object' }
  const invite = value.invite
  const name = value.name
  const platform = value.platform
  if (typeof invite !== 'string' || invite.length < 8 || invite.length > 128) {
    return { ok: false, code: 'invalid_request', message: 'invite is invalid' }
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > LIMITS.memberNameMax) {
    return { ok: false, code: 'invalid_request', message: 'name is invalid' }
  }
  if (typeof platform !== 'string' || platform.length === 0 || platform.length > 32) {
    return { ok: false, code: 'invalid_request', message: 'platform is invalid' }
  }
  return { ok: true, value: { invite, name: name.trim(), platform } }
}

export function validateMessage(value: unknown): Validation<MessageInput> {
  if (!isRecord(value)) return { ok: false, code: 'invalid_request', message: 'body must be an object' }
  const clientMsgId = value.clientMsgId
  if (
    typeof clientMsgId !== 'string' ||
    clientMsgId.length < LIMITS.clientMsgIdMin ||
    clientMsgId.length > LIMITS.clientMsgIdMax ||
    !/^[A-Za-z0-9._-]+$/.test(clientMsgId)
  ) {
    return { ok: false, code: 'invalid_request', message: 'clientMsgId is invalid' }
  }
  const text = value.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, code: 'invalid_request', message: 'text is required' }
  }
  if (utf8Bytes(text) > LIMITS.textBytes) {
    return { ok: false, code: 'payload_too_large', message: 'text exceeds limit' }
  }
  const refs = stringArray(value.refs, LIMITS.refs)
  if (refs === null) return { ok: false, code: 'invalid_request', message: 'refs is invalid' }
  const wake = stringArray(value.wake, LIMITS.wake)
  if (wake === null) return { ok: false, code: 'invalid_request', message: 'wake is invalid' }
  const replyTo = value.replyTo === undefined || value.replyTo === null ? null : value.replyTo
  if (replyTo !== null && (typeof replyTo !== 'string' || replyTo.length > 64)) {
    return { ok: false, code: 'invalid_request', message: 'replyTo is invalid' }
  }
  const forwardedFrom = value.forwardedFrom === undefined || value.forwardedFrom === null ? null : value.forwardedFrom
  if (forwardedFrom !== null && (typeof forwardedFrom !== 'string' || forwardedFrom.length > 64)) {
    return { ok: false, code: 'invalid_request', message: 'forwardedFrom is invalid' }
  }
  return {
    ok: true,
    value: { clientMsgId, text, refs, replyTo, wake, forwardedFrom },
  }
}

export function validateStatus(value: unknown): Validation<StatusInput> {
  if (!isRecord(value)) return { ok: false, code: 'invalid_request', message: 'body must be an object' }
  const states: DeliveryState[] = ['idle', 'queued', 'retryable', 'unknown', 'error', 'budget_exceeded']
  const loaded = value.targetLoaded === undefined ? 'unknown' : value.targetLoaded
  if (loaded !== 'true' && loaded !== 'false' && loaded !== 'unknown') {
    return { ok: false, code: 'invalid_request', message: 'targetLoaded is invalid' }
  }
  if (typeof value.deliveryState !== 'string' || !states.includes(value.deliveryState as DeliveryState)) {
    return { ok: false, code: 'invalid_request', message: 'deliveryState is invalid' }
  }
  if (typeof value.connectorOnline !== 'boolean') {
    return { ok: false, code: 'invalid_request', message: 'connectorOnline is invalid' }
  }
  const lastDeliveredSeq = value.lastDeliveredSeq === undefined ? 0 : value.lastDeliveredSeq
  if (typeof lastDeliveredSeq !== 'number' || !Number.isInteger(lastDeliveredSeq) || lastDeliveredSeq < 0) {
    return { ok: false, code: 'invalid_request', message: 'lastDeliveredSeq is invalid' }
  }
  const detail = value.detail === undefined || value.detail === null ? null : value.detail
  if (detail !== null && (typeof detail !== 'string' || detail.length > 500)) {
    return { ok: false, code: 'invalid_request', message: 'detail is invalid' }
  }
  return {
    ok: true,
    value: {
      connectorOnline: value.connectorOnline,
      deliveryState: value.deliveryState as DeliveryState,
      targetLoaded: loaded,
      lastDeliveredSeq,
      detail,
    },
  }
}

export function canonicalRefs(refs: string[]): string {
  return [...refs].map((item) => item.trim()).sort().join('\n')
}

export function contentHash(kind: MessageKind, text: string, refs: string[], replyTo: string | null): string {
  const material = [kind, text, canonicalRefs(refs), replyTo ?? ''].join('\u0000')
  return 'sha256:' + createHash('sha256').update(material, 'utf8').digest('hex')
}

export function newId(prefix: string): string {
  return prefix + '_' + randomUUID().replaceAll('-', '').slice(0, 20)
}
