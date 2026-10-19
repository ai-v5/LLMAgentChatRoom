import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createContext } from '../../../src/server/app.ts'
import { createRoomPlugin } from '../src/plugin.js'

const dataDir = mkdtempSync(join(tmpdir(), 'llmroom-plugin-test-'))
const ctx = createContext({
  dataDir,
  adminTokenFile: join(dataDir, 'admin.token'),
  version: 'test',
  sourceUrl: 'https://example.invalid/repo',
})
const server = createApp(ctx)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('no port')
const base = 'http://127.0.0.1:' + address.port

async function adminCall(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', 'Bearer ' + ctx.admin.token)
  if (init.body) headers.set('content-type', 'application/json')
  return fetch(base + path, { ...init, headers })
}

async function createRoom(name) {
  const response = await adminCall('/api/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

async function postOwnerMessage(roomId, text, wake, clientMsgId) {
  const response = await adminCall('/api/v1/rooms/' + roomId + '/messages', {
    method: 'POST',
    body: JSON.stringify({ clientMsgId, text, refs: [], wake }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

async function memberView(roomId, memberId) {
  const response = await adminCall('/api/v1/rooms/' + roomId + '/members')
  assert.equal(response.status, 200)
  const body = await response.json()
  return body.members.find((member) => member.id === memberId)
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function createAgent(sessionId) {
  const inbox = []
  return {
    session: { id: sessionId },
    inbox,
    followup(message) {
      inbox.push(message)
    },
  }
}

function createHarness() {
  const tools = new Map()
  const disposers = []
  const warnings = []
  const agents = new Map()
  let flushAllowed = true
  let flushCalls = 0
  const harness = {
    tools,
    warnings,
    agents,
    get flushCalls() {
      return flushCalls
    },
    setFlush(value) {
      flushAllowed = value
    },
    async dispose() {
      for (const disposer of disposers.reverse()) {
        if (typeof disposer === 'function') await disposer()
      }
    },
  }
  harness.ctx = {
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') return dispose()
      }
    },
    sessionController: {
      async resolveAgent(sessionId) {
        const agent = agents.get(sessionId)
        return agent ? { agent } : { error: new Error('session not found: ' + sessionId) }
      },
    },
    sessions: {
      async flush() {
        flushCalls += 1
        return flushAllowed
      },
    },
  }
  return harness
}

function createPlugin() {
  return createRoomPlugin({
    defineTool: (definition) => definition,
    createUserMessage: (input) => ({ role: 'user', ...input }),
  })
}

test('plugin exposes the DSH surface and registers the five room tools', () => {
  const plugin = createPlugin()
  assert.equal(plugin.name, 'llmagentchatroom')
  assert.deepEqual(plugin.inject, ['tools', 'sessionController', 'sessions'])
  assert.equal(typeof plugin.apply, 'function')

  const harness = createHarness()
  plugin.apply(harness.ctx, { server: base, room: 'room_x', invite: 'invite-0000', name: 'agent' })
  assert.deepEqual(
    [...harness.tools.keys()].sort(),
    ['room_join', 'room_leave', 'room_read', 'room_send', 'room_status'],
  )
})

test('room_join binds a session and wake messages are pushed with a chat-room source', async () => {
  const { room, invite } = await createRoom('plugin-happy')
  const plugin = createPlugin()
  const harness = createHarness()
  const agent = createAgent('session-happy')
  harness.agents.set('session-happy', agent)
  plugin.apply(harness.ctx, { server: base, room: room.id, invite, name: 'plugin-agent', platform: 'dsh' })
  const exec = { agent, signal: new AbortController().signal }
  try {
    const joined = await harness.tools.get('room_join').execute({}, exec)
    assert.equal(joined.ok, true)
    assert.equal(joined.alreadyJoined, false)
    assert.equal(joined.room, room.id)
    assert.equal(joined.memberName, 'plugin-agent')
    assert.equal(joined.lastSeq, 0)

    const again = await harness.tools.get('room_join').execute({}, exec)
    assert.equal(again.alreadyJoined, true)
    assert.equal(again.memberId, joined.memberId)

    const posted = await postOwnerMessage(room.id, 'please check the build', [joined.memberId], 'c-plugin-0001')
    await waitFor(() => agent.inbox.length >= 1, 3000, 'wake push')

    const injected = agent.inbox[0]
    assert.equal(injected.role, 'user')
    assert.deepEqual(injected.source, {
      kind: 'chat-room',
      roomId: room.id,
      messageId: posted.message.id,
    })
    assert.match(
      injected.content[0].text,
      /^\[chat-room msg=msg_[^ ]+ seq=1 from=owner \(human\) kind=instruction ts=[^\]]+\]\nplease check the build$/,
    )

    const online = await waitFor(
      async () => {
        const member = await memberView(room.id, joined.memberId)
        return member && member.connectorOnline ? member : null
      },
      3000,
      'connector status report',
    )
    assert.equal(online.deliveryState, 'idle')
    assert.equal(online.targetLoaded, 'unknown')

    const status = await harness.tools.get('room_status').execute({ delivery_state: 'queued', detail: 'test' }, exec)
    assert.equal(status.bound, true)
    assert.equal(status.deliveryState, 'queued')
    assert.equal(status.targetLoaded, 'unknown')

    const read = await harness.tools.get('room_read').execute({ since: 0 }, exec)
    assert.equal(read.count, 1)
    assert.equal(read.messages[0].kind, 'instruction')
    assert.equal(read.messages[0].from, 'owner (human)')
    assert.equal(read.messages[0].text, 'please check the build')

    const left = await harness.tools.get('room_leave').execute({}, exec)
    assert.deepEqual(left, { ok: true, left: true, room: room.id })

    await assert.rejects(harness.tools.get('room_read').execute({}, exec), /room_not_joined/)
  } finally {
    await harness.dispose()
  }
})

test('a failed flush keeps the cursor and the message is replayed', async () => {
  const { room, invite } = await createRoom('plugin-flush')
  const credentialsFile = join(dataDir, 'plugin-credentials.json')
  const plugin = createPlugin()
  const harness = createHarness()
  const agent = createAgent('session-flush')
  harness.agents.set('session-flush', agent)
  plugin.apply(harness.ctx, { server: base, room: room.id, invite, name: 'flush-agent', credentialsFile })
  const exec = { agent, signal: new AbortController().signal }
  const saved = () => JSON.parse(readFileSync(credentialsFile, 'utf8'))
  try {
    const joined = await harness.tools.get('room_join').execute({}, exec)
    assert.equal(existsSync(credentialsFile), true)
    assert.equal(saved().sessions['session-flush'].lastSeq, 0)

    harness.setFlush(false)
    await postOwnerMessage(room.id, 'needs a durable flush', [joined.memberId], 'c-plugin-0002')
    await waitFor(() => agent.inbox.length >= 1, 3000, 'first push attempt')
    assert.equal(harness.flushCalls >= 1, true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(saved().sessions['session-flush'].lastSeq, 0)

    harness.setFlush(true)
    await waitFor(() => saved().sessions['session-flush'].lastSeq === 1, 5000, 'cursor advance after replay')
    assert.equal(agent.inbox.length >= 2, true)
    assert.equal(agent.inbox[0].source.messageId, agent.inbox[1].source.messageId)
  } finally {
    await harness.dispose()
  }
})

test('autoStart joins on first use and room_status reports unbound sessions', async () => {
  const { room, invite } = await createRoom('plugin-autostart')
  const details = { server: base, room: room.id, invite, name: 'auto-agent', platform: 'dsh' }

  const plainPlugin = createPlugin()
  const plain = createHarness()
  const idleAgent = createAgent('session-idle')
  plain.agents.set('session-idle', idleAgent)
  plainPlugin.apply(plain.ctx, details)
  try {
    const unbound = await plain.tools.get('room_status').execute({}, {
      agent: idleAgent,
      signal: new AbortController().signal,
    })
    assert.equal(unbound.bound, false)
    assert.equal(unbound.deliveryState, 'unknown')
    await assert.rejects(
      plain.tools.get('room_read').execute({}, { agent: idleAgent, signal: new AbortController().signal }),
      /room_not_joined/,
    )
  } finally {
    await plain.dispose()
  }

  const autoPlugin = createPlugin()
  const auto = createHarness()
  const autoAgent = createAgent('session-auto')
  auto.agents.set('session-auto', autoAgent)
  autoPlugin.apply(auto.ctx, { ...details, autoStart: true })
  try {
    const sent = await auto.tools.get('room_send').execute(
      { text: 'autostarted' },
      { agent: autoAgent, signal: new AbortController().signal },
    )
    assert.equal(sent.ok, true)
    assert.equal(sent.seq, 1)

    const status = await auto.tools.get('room_status').execute({}, {
      agent: autoAgent,
      signal: new AbortController().signal,
    })
    assert.equal(status.bound, true)
    assert.equal(status.memberName, 'auto-agent')
  } finally {
    await auto.dispose()
  }
})

test('binds one room per session and a kick unbinds only the revoked session', async () => {
  const { room, invite } = await createRoom('plugin-sessions')
  const plugin = createPlugin()
  const harness = createHarness()
  const agentA = createAgent('session-a')
  const agentB = createAgent('session-b')
  harness.agents.set('session-a', agentA)
  harness.agents.set('session-b', agentB)
  plugin.apply(harness.ctx, { server: base, room: room.id, invite, platform: 'dsh' })
  const execA = { agent: agentA, signal: new AbortController().signal }
  const execB = { agent: agentB, signal: new AbortController().signal }
  try {
    const joinedA = await harness.tools.get('room_join').execute({ name: 'agent-a' }, execA)
    const joinedB = await harness.tools.get('room_join').execute({ name: 'agent-b' }, execB)
    assert.notEqual(joinedA.memberId, joinedB.memberId)

    await postOwnerMessage(room.id, 'both sessions', [joinedA.memberId, joinedB.memberId], 'c-plugin-0003')
    await waitFor(() => agentA.inbox.length >= 1 && agentB.inbox.length >= 1, 3000, 'both sessions woken')
    assert.match(agentA.inbox[0].content[0].text, /both sessions$/)
    assert.match(agentB.inbox[0].content[0].text, /both sessions$/)

    const kicked = await adminCall('/api/v1/rooms/' + room.id + '/members/' + joinedA.memberId, {
      method: 'DELETE',
    })
    assert.equal(kicked.status, 200)
    await waitFor(
      async () => {
        try {
          await harness.tools.get('room_send').execute({ text: 'after kick' }, execA)
          return false
        } catch (error) {
          return /room_not_joined/.test(String(error.message))
        }
      },
      5000,
      'revoked session unbound',
    )

    const read = await harness.tools.get('room_read').execute({ since: 0 }, execB)
    assert.equal(read.count, 1)
    assert.equal(read.messages[0].text, 'both sessions')
  } finally {
    await harness.dispose()
  }
})

test.after(() => {
  server.closeAllConnections()
  server.close()
  ctx.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
