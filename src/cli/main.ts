import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { loadCredentials, removeCredentials, saveCredentials } from './credentials.ts'

type Flags = Record<string, string | boolean>

function parseFlags(args: string[]): { command: string; flags: Flags; rest: string[] } {
  const command = args[0] ?? 'help'
  const flags: Flags = {}
  const rest: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const item = args[index]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      const next = args[index + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        index += 1
      } else {
        flags[key] = true
      }
    } else {
      rest.push(item)
    }
  }
  return { command, flags, rest }
}

function serverUrl(flags: Flags): string {
  const value = typeof flags.server === 'string' ? flags.server : process.env.LLMROOM_SERVER
  return (value ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
}

function roomId(flags: Flags): string {
  if (typeof flags.room !== 'string' || flags.room.length === 0) {
    throw new Error('--room is required')
  }
  return flags.room
}

async function request(
  server: string,
  path: string,
  init: RequestInit,
  token?: string,
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', 'Bearer ' + token)
  return fetch(server + path, { ...init, headers })
}

async function join(flags: Flags): Promise<void> {
  const server = serverUrl(flags)
  const room = roomId(flags)
  if (typeof flags.invite !== 'string') throw new Error('--invite is required')
  if (typeof flags.name !== 'string') throw new Error('--name is required')
  const platform = typeof flags.platform === 'string' ? flags.platform : 'cli'
  const response = await request(server, '/api/v1/rooms/' + room + '/join', {
    method: 'POST',
    body: JSON.stringify({ invite: flags.invite, name: flags.name, platform }),
  })
  const body = (await response.json()) as { member?: { id: string }; token?: string; error?: { message: string } }
  if (!response.ok || !body.member || !body.token) {
    throw new Error(body.error?.message ?? 'join failed')
  }
  const file = saveCredentials({
    server,
    room,
    memberId: body.member.id,
    name: flags.name,
    token: body.token,
    lastSeq: 0,
  })
  console.log('joined as ' + body.member.id + ' (' + file + ')')
}

async function send(flags: Flags, rest: string[]): Promise<void> {
  const server = serverUrl(flags)
  const room = roomId(flags)
  const credentials = loadCredentials(server, room)
  if (!credentials) throw new Error('join the room first')
  const text = rest.length > 0 ? rest.join(' ') : readFileSync(0, 'utf8')
  const clientMsgId = 'cli-' + randomUUID().replaceAll('-', '').slice(0, 20)
  const response = await request(server, '/api/v1/rooms/' + room + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId, text, refs: [], wake: [] }),
  }, credentials.token)
  const body = (await response.json()) as { message?: { seq: number }; error?: { message: string } }
  if (!response.ok || !body.message) throw new Error(body.error?.message ?? 'send failed')
  credentials.lastSeq = body.message.seq
  saveCredentials(credentials)
  console.log('sent seq=' + body.message.seq)
}

async function tail(flags: Flags): Promise<void> {
  const server = serverUrl(flags)
  const room = roomId(flags)
  const credentials = loadCredentials(server, room)
  if (!credentials) throw new Error('join the room first')
  const since = typeof flags.since === 'string' ? flags.since : String(credentials.lastSeq)
  const response = await request(server, '/api/v1/rooms/' + room + '/events?since=' + since, {}, credentials.token)
  if (!response.ok || !response.body) throw new Error('tail failed: ' + response.status)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const event = /^event: (.+)$/m.exec(frame)?.[1]
      const data = /^data: (.+)$/m.exec(frame)?.[1]
      if (event === 'message' && data) {
        const message = JSON.parse(data) as { seq: number; author: { name: string }; text: string }
        console.log('[' + message.seq + '] ' + message.author.name + ': ' + message.text)
        credentials.lastSeq = message.seq
        saveCredentials(credentials)
      }
      index = buffer.indexOf('\n\n')
    }
  }
}

async function status(flags: Flags): Promise<void> {
  const server = serverUrl(flags)
  const room = roomId(flags)
  const credentials = loadCredentials(server, room)
  if (!credentials) throw new Error('join the room first')
  const response = await request(server, '/api/v1/rooms/' + room + '/members/self/status', {
    method: 'POST',
    body: JSON.stringify({
      connectorOnline: flags.online !== 'false',
      deliveryState: typeof flags.state === 'string' ? flags.state : 'idle',
      targetLoaded: typeof flags.loaded === 'string' ? flags.loaded : 'unknown',
      lastDeliveredSeq: credentials.lastSeq,
      detail: typeof flags.detail === 'string' ? flags.detail : null,
    }),
  }, credentials.token)
  if (!response.ok) throw new Error('status failed: ' + response.status)
  console.log('status updated')
}

function help(): void {
  console.log('llmroom join --room <id> --invite <code> --name <name> [--server url]')
  console.log('llmroom send --room <id> <text|-|--stdin>')
  console.log('llmroom tail --room <id> [--since seq]')
  console.log('llmroom status --room <id> [--state idle|queued|unknown|error] [--loaded true|false|unknown]')
  console.log('llmroom leave --room <id>')
}

const parsed = parseFlags(process.argv.slice(2))
try {
  if (parsed.command === 'join') await join(parsed.flags)
  else if (parsed.command === 'send') await send(parsed.flags, parsed.rest)
  else if (parsed.command === 'tail') await tail(parsed.flags)
  else if (parsed.command === 'status') await status(parsed.flags)
  else if (parsed.command === 'leave') {
    removeCredentials(serverUrl(parsed.flags), roomId(parsed.flags))
    console.log('local credentials removed')
  } else help()
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
