import { randomBytes } from 'node:crypto'
import { hashToken, newToken } from './auth.ts'
import {
  contentHash,
  newId,
  type Author,
  type Message,
  type MessageInput,
  type StatusInput,
} from '../protocol/index.ts'
import {
  findMember,
  findMemberByName,
  findRoom,
  getMessageByClientId,
  listMessages,
  maxSeq,
  transaction,
  type Db,
  type MemberRow,
  type MessageRow,
  type RoomRow,
} from './db.ts'

export interface RoomView {
  id: string
  name: string
  topic: string | null
  createdAt: string
  members: number
}

export function toAuthor(row: MemberRow): Author {
  return {
    memberId: row.id,
    name: row.name,
    kind: row.kind,
    platform: row.platform,
  }
}

export function toMessage(row: MessageRow, author: MemberRow, forwarded: MemberRow | null): Message {
  return {
    id: row.id,
    room: row.room_id,
    seq: row.seq,
    ts: row.ts,
    author: toAuthor(author),
    forwardedFrom: forwarded ? toAuthor(forwarded) : null,
    kind: row.kind === 'system' ? 'system' : 'chat',
    text: row.text,
    refs: JSON.parse(row.refs_json) as string[],
    replyTo: row.reply_to,
    wake: JSON.parse(row.wake_json) as string[],
    clientMsgId: row.client_msg_id,
    contentHash: row.content_hash,
  }
}

export function createRoom(db: Db, name: string, topic: string | null): { room: RoomView; invite: string } {
  const roomId = newId('room')
  const invite = randomBytes(18).toString('base64url')
  const createdAt = new Date().toISOString()
  transaction(db, () => {
    db.prepare(
      'INSERT INTO rooms (id, name, topic, created_at, invite_hash, policy_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(roomId, name, topic, createdAt, hashToken(invite), '{}')
    db.prepare(
      'INSERT INTO members (id, room_id, name, kind, platform, token_hash, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(newId('member'), roomId, 'owner', 'owner', 'human', hashToken(newToken()), createdAt)
  })
  return { room: { id: roomId, name, topic, createdAt, members: 1 }, invite }
}

export function listRooms(db: Db): RoomView[] {
  const rows = db
    .prepare(
      'SELECT r.id, r.name, r.topic, r.created_at, (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id AND m.status = ?) AS members FROM rooms r ORDER BY r.created_at DESC',
    )
    .all('active') as Array<{ id: string; name: string; topic: string | null; created_at: string; members: number }>
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    topic: row.topic,
    createdAt: row.created_at,
    members: row.members,
  }))
}

export function rotateInvite(db: Db, roomId: string): string | null {
  const room = findRoom(db, roomId)
  if (!room) return null
  const invite = randomBytes(18).toString('base64url')
  db.prepare('UPDATE rooms SET invite_hash = ?, invite_rotated_at = ? WHERE id = ?').run(
    hashToken(invite),
    new Date().toISOString(),
    roomId,
  )
  return invite
}

export function joinRoom(
  db: Db,
  roomId: string,
  invite: string,
  name: string,
  platform: string,
): { member: MemberRow; token: string } | { error: 'room_not_found' | 'forbidden' | 'name_taken' } {
  const room = findRoom(db, roomId)
  if (!room) return { error: 'room_not_found' }
  if (room.invite_hash !== hashToken(invite)) return { error: 'forbidden' }
  const token = newToken()
  const id = newId('member')
  const joinedAt = new Date().toISOString()
  try {
    transaction(db, () => {
      db.prepare(
        'INSERT INTO members (id, room_id, name, kind, platform, token_hash, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, roomId, name, 'agent', platform, hashToken(token), joinedAt)
    })
  } catch {
    return { error: 'name_taken' }
  }
  const member = findMember(db, roomId, id)
  if (!member) return { error: 'room_not_found' }
  return { member, token }
}

export function authenticate(db: Db, roomId: string, token: string): MemberRow | null {
  const row = db
    .prepare('SELECT * FROM members WHERE room_id = ? AND token_hash = ? AND status = ?')
    .get(roomId, hashToken(token), 'active') as MemberRow | undefined
  return row ?? null
}

export function getOwnerMember(db: Db, roomId: string): MemberRow | null {
  const row = db.prepare('SELECT * FROM members WHERE room_id = ? AND kind = ?').get(roomId, 'owner') as
    | MemberRow
    | undefined
  return row ?? null
}

export function ownerAuthor(db: Db, roomId: string): MemberRow | null {
  return getOwnerMember(db, roomId)
}

export interface PostResult {
  message: Message
  duplicate: boolean
}

export function postMessage(
  db: Db,
  roomId: string,
  member: MemberRow,
  input: MessageInput,
): PostResult | { error: 'idempotency_conflict' | 'forbidden' } {
  return transaction(db, () => {
    const fresh = findMember(db, roomId, member.id)
    if (!fresh || fresh.status !== 'active') return { error: 'forbidden' as const }
    const hash = contentHash('chat', input.text, input.refs, input.replyTo)
    const existing = getMessageByClientId(db, roomId, fresh.id, input.clientMsgId)
    if (existing) {
      if (existing.content_hash !== hash) return { error: 'idempotency_conflict' as const }
      const author = findMember(db, roomId, existing.author_member_id) as MemberRow
      const forwarded = existing.forwarded_from_member_id
        ? (findMember(db, roomId, existing.forwarded_from_member_id) as MemberRow)
        : null
      return { message: toMessage(existing, author, forwarded), duplicate: true }
    }
    let forwardedId: string | null = null
    if (input.forwardedFrom) {
      if (fresh.kind !== 'owner') return { error: 'forbidden' as const }
      const target = findMember(db, roomId, input.forwardedFrom)
      if (!target) return { error: 'forbidden' as const }
      forwardedId = target.id
    }
    const seq = maxSeq(db, roomId) + 1
    const id = newId('msg')
    const ts = new Date().toISOString()
    db.prepare(
      'INSERT INTO messages (id, room_id, seq, ts, author_member_id, forwarded_from_member_id, kind, text, refs_json, reply_to, wake_json, client_msg_id, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      roomId,
      seq,
      ts,
      fresh.id,
      forwardedId,
      'chat',
      input.text,
      JSON.stringify(input.refs),
      input.replyTo,
      JSON.stringify(input.wake),
      input.clientMsgId,
      hash,
    )
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
    const forwarded = forwardedId ? (findMember(db, roomId, forwardedId) as MemberRow) : null
    return { message: toMessage(row, fresh, forwarded), duplicate: false }
  })
}

export function history(db: Db, roomId: string, since: number, limit: number): Message[] {
  const rows = listMessages(db, roomId, since, limit)
  return rows.map((row) => {
    const author = findMember(db, roomId, row.author_member_id) as MemberRow
    const forwarded = row.forwarded_from_member_id
      ? (findMember(db, roomId, row.forwarded_from_member_id) as MemberRow)
      : null
    return toMessage(row, author, forwarded)
  })
}

export function kickMember(db: Db, roomId: string, memberId: string): boolean {
  const row = findMember(db, roomId, memberId)
  if (!row || row.kind === 'owner') return false
  db.prepare('UPDATE members SET status = ?, token_hash = ? WHERE room_id = ? AND id = ?').run(
    'revoked',
    hashToken(newToken()),
    roomId,
    memberId,
  )
  return true
}

export function updateStatus(db: Db, roomId: string, memberId: string, status: StatusInput): void {
  db.prepare(
    'UPDATE members SET connector_online = ?, delivery_state = ?, target_loaded = ?, last_delivered_seq = ?, last_seen_at = ? WHERE room_id = ? AND id = ?',
  ).run(
    status.connectorOnline ? 1 : 0,
    status.deliveryState,
    status.targetLoaded,
    status.lastDeliveredSeq,
    new Date().toISOString(),
    roomId,
    memberId,
  )
}

export function membersOf(db: Db, roomId: string): MemberRow[] {
  return db
    .prepare('SELECT * FROM members WHERE room_id = ? ORDER BY joined_at ASC')
    .all(roomId) as unknown as MemberRow[]
}

export function findMemberById(db: Db, roomId: string, id: string): MemberRow | null {
  return findMember(db, roomId, id) ?? null
}

export function findMemberNamed(db: Db, roomId: string, name: string): MemberRow | null {
  return findMemberByName(db, roomId, name) ?? null
}

export function roomOf(db: Db, roomId: string): RoomRow | null {
  return findRoom(db, roomId) ?? null
}
