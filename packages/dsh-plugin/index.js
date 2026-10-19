/**
 * DSH entry point for the LLMAgentChatRoom connector.
 * @module @llmagentchatroom/dsh-plugin
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRoomPlugin } from './src/plugin.js'

const plugin = createRoomPlugin({ defineTool, createUserMessage })

/** Plugin name registered with the Loader. */
export const name = plugin.name
/** Host services this plugin consumes. */
export const inject = plugin.inject
/** Register the room tools and per-session event loops. */
export const apply = plugin.apply
export default plugin
