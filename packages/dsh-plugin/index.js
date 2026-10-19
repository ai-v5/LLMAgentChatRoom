/**
 * DSH entry point for the LLMAgentChatRoom connector.
 *
 * This package is intentionally dependency-free: it declares its own tool
 * definitions and user messages so the DSH loader can import it like any
 * third-party host plugin. DSH validates the registered schemas itself.
 * @module @llmagentchatroom/dsh-plugin
 */

import { randomUUID } from 'node:crypto'
import { createRoomPlugin } from './src/plugin.js'

/** Pass-through: `ctx.tools.register` accepts this shape directly. */
function defineTool(definition) {
  return definition
}

/**
 * Freeze a message and its nested blocks, mirroring DSH's immutable messages.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Build a user-role message with a fresh stable id and a chat-room source.
 * @param {{ content: Array<object>, source: object }} input
 */
function createUserMessage(input) {
  return deepFreeze({
    ...input,
    role: 'user',
    id: randomUUID(),
  })
}

const plugin = createRoomPlugin({ defineTool, createUserMessage })

/** Plugin name registered with the Loader. */
export const name = plugin.name
/** Host services this plugin consumes. */
export const inject = plugin.inject
/** Register the room tools and per-session event loops. */
export const apply = plugin.apply
export default plugin
