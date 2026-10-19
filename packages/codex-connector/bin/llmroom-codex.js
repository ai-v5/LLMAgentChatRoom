#!/usr/bin/env node
/**
 * llmroom-codex: run a LLMAgentChatRoom connector for one Codex thread.
 *
 * Configuration comes from the environment so the daemon can be launched from
 * a service manager without a config parser:
 *   LLMROOM_SERVER, LLMROOM_ROOM, LLMROOM_INVITE, LLMROOM_NAME, CODEX_THREAD,
 *   CODEX_BIN (optional, defaults to `codex`).
 *
 * @module @llmagentchatroom/codex-connector/bin
 */

import { createConnector } from '../src/connector.js'

const PREFIX = 'llmroom-codex'
const REQUIRED = [
  ['LLMROOM_SERVER', 'server'],
  ['LLMROOM_ROOM', 'room'],
  ['LLMROOM_INVITE', 'invite'],
  ['LLMROOM_NAME', 'name'],
  ['CODEX_THREAD', 'target'],
]

/**
 * @param {string} name
 * @returns {string | null}
 */
function env(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

const logger = {
  /** @param {string} message */
  info(message) {
    console.log(`[${PREFIX}] ${message}`)
  },
  /** @param {string} message */
  warn(message) {
    console.error(`[${PREFIX}] ${message}`)
  },
}

const missing = REQUIRED.filter(([variable]) => env(variable) === null).map(([variable]) => variable)
if (missing.length > 0) {
  logger.warn(`missing required environment variables: ${missing.join(', ')}`)
  logger.warn(
    'usage: LLMROOM_SERVER=... LLMROOM_ROOM=... LLMROOM_INVITE=... LLMROOM_NAME=... CODEX_THREAD=... llmroom-codex',
  )
  process.exit(2)
}

const config = {
  server: env('LLMROOM_SERVER'),
  room: env('LLMROOM_ROOM'),
  invite: env('LLMROOM_INVITE'),
  name: env('LLMROOM_NAME'),
  target: env('CODEX_THREAD'),
  codexBin: env('CODEX_BIN') ?? 'codex',
  logger,
}

/** @type {import('../src/connector.js').ConnectorHandle | null} */
let handle = null
let stopping = false

/**
 * @param {string} signalName
 */
async function shutdown(signalName) {
  if (stopping) return
  stopping = true
  logger.info(`received ${signalName}; stopping`)
  try {
    await handle?.stop()
  } catch (error) {
    logger.warn(`stop failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})

try {
  handle = await createConnector({
    server: config.server,
    room: config.room,
    invite: config.invite,
    name: config.name,
    target: config.target,
    codexBin: config.codexBin,
    logger,
  }).start()
  logger.info(
    `joined room ${config.room} as ${handle.memberId}; delivering wake messages to codex thread ${config.target}`,
  )
} catch (error) {
  logger.warn(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
