import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

export interface RoomRow {
  id: string
  name: string
  topic: string | null
  created_at: string
  invite_hash: string
  invite_rotated_at: string | null
  policy_json: string
}

export interface MemberRow {
  id: string
  room_id: string
  name: string
  kind: 'owner' | 'agent'
  platform: string | null
  token_hash: string
  status: 'active' | 'revoked'
  connector_online: number
  delivery_state: string
  target_loaded: string
  last_delivered_seq: number
  joined_at: string
  last_seen_at: string | null
}

export interface MessageRow {
  id: string
  room_id: string
  seq: number
  ts: string
  author_member_id: string
  forwarded_from_member_id: string | null
  kind: string
  text: string
  refs_json: string
  reply_to: string | null
  wake_json: string
  client_msg_id: string
  content_hash: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT,
  created_at TEXT NOT NULL,
  invite_hash TEXT NOT NULL,
  invite_rotated_at TEXT,
  policy_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner','agent')),
  platform TEXT,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  connector_online INTEGER NOT NULL DEFAULT 0,
  delivery_state TEXT NOT NULL DEFAULT 'idle',
  target_loaded TEXT NOT NULL DEFAULT 'unknown',
  last_delivered_seq INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (room_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  author_member_id TEXT NOT NULL REFERENCES members(id),
  forwarded_from_member_id TEXT REFERENCES members(id),
  kind TEXT NOT NULL DEFAULT 'chat',
  text TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  wake_json TEXT NOT NULL DEFAULT '[]',
  client_msg_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (room_id, seq),
  UNIQUE (room_id, author_member_id, client_msg_id)
);

CREATE TABLE IF NOT EXISTS cursors (
  member_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, room_id)
);

CREATE INDEX IF NOT EXISTS messages_room_seq ON messages (room_id, seq);
`

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // rollout already aborted
    }
    throw error
  }
}

export function maxSeq(db: Db, roomId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE room_id = ?').get(roomId) as
    | { seq: number }
    | undefined
  return row?.seq ?? 0
}

export function findRoom(db: Db, roomId: string): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | undefined
}

export function findMember(db: Db, roomId: string, memberId: string): MemberRow | undefined {
  return db.prepare('SELECT * FROM members WHERE room_id = ? AND id = ?').get(roomId, memberId) as
    | MemberRow
    | undefined
}

export function findMemberByName(db: Db, roomId: string, name: string): MemberRow | undefined {
  return db.prepare('SELECT * FROM members WHERE room_id = ? AND name = ?').get(roomId, name) as
    | MemberRow
    | undefined
}

export function listMessages(db: Db, roomId: string, since: number, limit: number): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(roomId, since, limit) as unknown as MessageRow[]
}

export function getMessageByClientId(
  db: Db,
  roomId: string,
  authorMemberId: string,
  clientMsgId: string,
): MessageRow | undefined {
  return db
    .prepare(
      'SELECT * FROM messages WHERE room_id = ? AND author_member_id = ? AND client_msg_id = ?',
    )
    .get(roomId, authorMemberId, clientMsgId) as MessageRow | undefined
}
