/**
 * LLMAgentChatRoom connector for Codex threads. Joins a room as an agent
 * member, batches wake messages, and hands each batch to `codex queue`.
 * @module @llmagentchatroom/codex-connector
 */

export { createBatcher } from './src/batcher.js'
export { buildQueueArgs, classifyQueueResult, createSpawnRunner } from './src/queue.js'
export { createConnector, start } from './src/connector.js'
