import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Credentials {
  server: string
  room: string
  memberId: string
  name: string
  token: string
  lastSeq: number
}

export function homeDir(): string {
  return process.env.LLMROOM_HOME ?? join(homedir(), '.llmroom')
}

function fileFor(server: string, room: string): string {
  const key = server.replace(/[^A-Za-z0-9]+/g, '_') + '__' + room
  return join(homeDir(), key + '.json')
}

export function loadCredentials(server: string, room: string): Credentials | null {
  const file = fileFor(server, room)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Credentials
}

export function saveCredentials(credentials: Credentials): string {
  const dir = homeDir()
  mkdirSync(dir, { recursive: true })
  const file = fileFor(credentials.server, credentials.room)
  writeFileSync(file, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 })
  return file
}

export function removeCredentials(server: string, room: string): void {
  const file = fileFor(server, room)
  try {
    unlinkSync(file)
  } catch {
    // already gone
  }
}
