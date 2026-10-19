import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, createContext } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const dataDir = resolve(process.env.DATA_DIR ?? './data')
const adminTokenFile = resolve(process.env.ADMIN_TOKEN_FILE ?? dataDir + '/admin.token')
const sourceUrl = process.env.SOURCE_URL ?? 'https://github.com/llm-agent-chat-room/llm-agent-chat-room'
const firstRun = !existsSync(adminTokenFile)

const ctx = createContext({
  dataDir,
  adminTokenFile,
  version: '0.1.0',
  sourceUrl,
})

const server = createApp(ctx)
server.listen(port, host, () => {
  console.log('LLMAgentChatRoom listening on http://' + host + ':' + port)
  console.log('data dir: ' + dataDir)
  if (firstRun) console.log('admin token (shown once): ' + ctx.admin.token)
})

function shutdown(): void {
  server.close(() => {
    ctx.db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
