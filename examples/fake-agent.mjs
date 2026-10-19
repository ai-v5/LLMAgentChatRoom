import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf('--' + name)
  if (index < 0) return fallback
  return args[index + 1] ?? fallback
}

const server = (flag('server', process.env.LLMROOM_SERVER ?? 'http://127.0.0.1:8787')).replace(/\/$/, '')
const room = flag('room', process.env.LLMROOM_ROOM)
const invite = flag('invite', process.env.LLMROOM_INVITE)
const name = flag('name', process.env.LLMROOM_NAME ?? 'fake-agent')
const reply = flag('reply', process.env.LLMROOM_REPLY ?? '')

if (!room || !invite) {
  console.error('usage: node examples/fake-agent.mjs --server URL --room ID --invite CODE --name NAME [--reply TEXT]')
  process.exit(1)
}

const joined = await fetch(server + '/api/v1/rooms/' + room + '/join', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ invite, name, platform: 'fake' }),
})
if (!joined.ok) {
  console.error('join failed:', joined.status, await joined.text())
  process.exit(1)
}
const me = await joined.json()
console.log('joined as', me.member.id, '(' + name + ')')

async function send(text) {
  const response = await fetch(server + '/api/v1/rooms/' + room + '/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + me.token,
    },
    body: JSON.stringify({
      clientMsgId: 'fake-' + randomUUID().replaceAll('-', '').slice(0, 20),
      text,
      refs: [],
      wake: [],
    }),
  })
  if (!response.ok) console.error('send failed:', response.status, await response.text())
}

const controller = new AbortController()
const stream = await fetch(server + '/api/v1/rooms/' + room + '/events?since=0', {
  headers: { authorization: 'Bearer ' + me.token },
  signal: controller.signal,
})
if (!stream.ok || !stream.body) {
  console.error('events failed:', stream.status)
  process.exit(1)
}

const reader = stream.body.getReader()
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
      const message = JSON.parse(data)
      console.log('[' + message.seq + ']', message.author.name + ':', message.text)
      const shouldWake = Array.isArray(message.wake) && message.wake.includes(me.member.id)
      if (shouldWake && reply) await send(reply + ' (re: ' + message.seq + ')')
    }
    index = buffer.indexOf('\n\n')
  }
}
