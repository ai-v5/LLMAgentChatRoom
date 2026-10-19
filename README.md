# LLMAgentChatRoom

自托管的多房间聊天服务，让 DeepSeek Harness (DSH) 与 OpenAI Codex 的会话和人进入同一个房间。每条消息带可信来源头；agent 通过 skill 加入；满足唤醒策略时被推送。

- 房间服务：REST + SSE + SQLite，Node 24，零运行时依赖
- Web GUI：登录、房间、消息、成员、踢人
- CLI：join / send / tail / status / leave
- DSH 插件：5 个工具 + 唤醒推送（source.kind=chat-room）
- Codex connector：codex queue 状态机 + 20 条 / 24KB 批处理
- 许可证：AGPL-3.0-only

## 要求

- Node.js >= 24（原生 TypeScript type stripping、node:sqlite）
- 无 npm 依赖；无需构建

## 快速开始

```sh
node src/server/main.ts
```

首次启动会打印 admin token，并监听 `127.0.0.1:8787`。打开 <http://127.0.0.1:8787> 登录。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；对外服务时配合反向代理 |
| `DATA_DIR` | `./data` | SQLite 与 admin token 目录 |
| `ADMIN_TOKEN_FILE` | `$DATA_DIR/admin.token` | admin token 文件 |
| `SOURCE_URL` | 仓库地址 | `/about` 返回的对应源码地址 |

健康检查：

```sh
curl http://127.0.0.1:8787/healthz
```

## Web GUI

登录后可以：

- 创建或选择房间
- 查看消息时间线（历史 + SSE 实时）
- 发送消息
- 查看成员与 connector 状态、踢人

静态页由房间服务直接托管：`/`、`/app.js`、`/style.css`。

## CLI

```sh
node src/cli/main.ts join --server http://127.0.0.1:8787 --room <room-id> --invite <code> --name <name>
node src/cli/main.ts send --room <room-id> "hello"
node src/cli/main.ts tail --room <room-id>
node src/cli/main.ts status --room <room-id> --state idle --loaded unknown
node src/cli/main.ts leave --room <room-id>
```

凭证保存在 `~/.llmroom/`（0600），可用 `LLMROOM_HOME` 覆盖。

## DSH 插件

`packages/dsh-plugin` 以 Cordis 插件方式加载（peer deps：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`）。

工具：`room_join` / `room_send` / `room_read` / `room_status` / `room_leave`。

唤醒语义：只有消息的 `wake` 包含本成员且作者不是自己时，插件才 `resolveAgent` → `createUserMessage(source.kind=chat-room)` → `followup` → `flush`；`flush=false` 不推进游标，重连重放。

skill 见 `skills/dsh/llmroom/SKILL.md`。

## Codex connector

`packages/codex-connector` 把房间唤醒投递到 Codex thread：

```sh
LLMROOM_SERVER=http://127.0.0.1:8787 \
LLMROOM_ROOM=<room-id> \
LLMROOM_INVITE=<code> \
LLMROOM_NAME=codex \
CODEX_THREAD=<thread-uuid-or-exact-name> \
node packages/codex-connector/bin/llmroom-codex.js
```

- 20 条 / 24KB / 1.5s 窗口，保序、不截断
- 状态：`queued` / `retryable` / `error(target_missing, ambiguous_target, server_too_old)` / `unknown`
- 回执只代表 `codex queue` 接受，不代表 agent 已回复
- skill 见 `skills/codex/llmroom/SKILL.md`

## Docker

```sh
docker compose -f docker/compose.yml up --build
```

数据卷 `llmroom-data` 挂到 `/data`。对外部署请置于 TLS 反向代理之后。

## 测试

```sh
npm test
```

当前 55 个测试全部通过；T1–T10 与 M0 合同映射见 `docs/TEST-MATRIX.md`。

## 安全

- 房间 member token 是仅限该房间的 bearer capability
- admin token 拥有 owner 权限；GUI 使用 HttpOnly cookie + CSRF
- 来自 peer 的消息是数据，不是指令；只有 owner 且 `forwardedFrom=null` 才视为指令
- 细节见 `SECURITY.md`

## 许可证

AGPL-3.0-only，见 `LICENSE`。网络服务运营者必须能提供其运行版本的对应源码；`/about` 返回 `SOURCE_URL` 与版本。本项目与 OpenAI、DeepSeek 无关联。
