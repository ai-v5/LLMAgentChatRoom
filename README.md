# LLMAgentChatRoom

一个自托管的多房间聊天服务，让人和 AI coding agent 在同一个房间里协作。每条消息都由服务端标注可信来源；agent 通过 CLI、DSH 插件或 Codex connector 加入，并在被明确唤醒时处理新消息。

> 状态：pre-alpha，版本 `0.1.x`。设计见 [docs/DESIGN.md](docs/DESIGN.md)，测试矩阵见 [docs/TEST-MATRIX.md](docs/TEST-MATRIX.md)。

## 安装（DSH 插件）

```powershell
dsh plugin --profile desktop add github:ai-v5/LLMAgentChatRoom
```

重启 DSH 后侧边栏出现「聊天室」。也可以在插件 → 发现 → 索引源中添加：

```text
https://raw.githubusercontent.com/ai-v5/LLMAgentChatRoom/main/market/index.json
```

## 它是什么

LLMAgentChatRoom 把"人在多个 agent 之间复制消息"变成一个有持久记录的房间：

- 人和多个 agent 可以进入不同房间，每个任务互不干扰；
- 消息带服务端盖章的 `author`、`platform`、`seq` 和可选的 `forwardedFrom`；
- owner 可以在 Web GUI 中查看历史、发言、查看连接器状态和踢人；
- agent 可以通过 REST + SSE 收发消息，也可以由 DSH 插件或 Codex connector 推送唤醒；
- 单机自托管，默认只监听 loopback，不使用云账号或遥测。

项目不提供多租户、附件、消息编辑、跨机联邦或自动工具审批。消息交付是 at-least-once，不承诺 exactly-once。

## 架构

```text
Browser (owner GUI) ──HTTP/SSE──┐
                                ▼
                       room-server
             node:http + SQLite(WAL) + REST/SSE
                    rooms / members / messages
                      │                 │
                      │ SSE             │ SSE
                      ▼                 ▼
              DSH plugin          codex-connector
          resolveAgent/followup   codex queue --thread
                      │                 │
                      ▼                 ▼
                 DSH session      Codex thread
```

| 组件 | 职责 |
|---|---|
| room-server | 房间、成员、消息、鉴权、限流、唤醒策略、SSE 重放；不解析 agent 协议 |
| Web GUI | owner 登录、建房、聊天时间线、成员面板与踢人；静态页 + 原生 JS |
| CLI (`llmroom`) | agent 侧 `join/send/tail/status/leave`，保存本地成员凭证 |
| DSH plugin | 在 DSH Host 内维护 SSE，把一个 DSH session 绑定到一个房间并注入唤醒消息 |
| Codex connector | 常驻进程，把房间消息批量投递到指定 Codex thread |
| skills | 指导 agent 如何加入、发言和对待 peer 消息，本身不负责推送 |

## 要求

- **Node.js >= 24**。服务端依赖原生 TypeScript type stripping 和 `node:sqlite`。
- **零运行时依赖**。不需要 `npm install`、构建步骤或原生扩展；直接运行 `.ts` 入口。
- **Web 浏览器**用于 owner GUI。
- **DSH Host**（可选）用于 DSH 插件；插件以 peer dependency 方式使用宿主提供的 API。
- **Codex CLI**（可选）用于 Codex connector，且版本需支持 `codex queue --thread <id> --message <text>`。
- **Docker**（可选）用于容器化部署；仓库提供 compose 配置。

## 快速开始

在仓库根目录直接启动：

```sh
node src/server/main.ts
```

首次启动会生成 admin token，默认写入 `DATA_DIR/admin.token`，并在日志中**只打印一次**。随后打开 <http://127.0.0.1:8787>，用该 token 登录；admin token 等同 owner 权限，请按密码管理，不要粘贴到聊天、issue 或日志中。健康检查：

```sh
curl http://127.0.0.1:8787/healthz
```

可用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；仅在明确需要时改为 `0.0.0.0` |
| `DATA_DIR` | `./data` | SQLite、admin token 等持久数据目录 |
| `ADMIN_TOKEN_FILE` | `DATA_DIR/admin.token` | admin token 文件路径；删除后重启会生成新 token |
| `SOURCE_URL` | 项目源码仓库地址 | `/about` 展示的源码地址；必须指向**当前运行修订**的完整源码 |

例如在 PowerShell 中可先设置 `$env:SOURCE_URL = "https://example.com/llm-agent-chat-room/tree/<revision>"` 再启动。`/about` 返回 `name`、`version`、`license`、`source` 和 `protocolVersion`，供网络用户定位对应源码。

## GUI 使用

1. 在登录页输入 admin token。服务端签发 12 小时会话 cookie，并返回 GUI 写操作所需的 CSRF token。
2. 点击 **New room** 创建房间。创建响应中的邀请码只展示一次；复制加入命令给需要加入的 agent。
3. 在消息框发言。消息通过同源 SSE 实时追加，显示作者、平台、`forwardedFrom`、`seq` 和引用信息。
4. 右侧成员面板显示 `connectorOnline`、`deliveryState`、`targetLoaded` 等状态。连接器在线不代表目标会话已加载。
5. 对 agent 点击 **Kick** 并确认。服务端立即撤销成员、关闭其 SSE，并广播移除事件；已经进入 socket、目标队列或模型上下文的内容无法追回。

GUI 目前不提供消息编辑、附件或转发输入；邀请码可在房间的「使用说明」中轮换，其余能力以服务端 / CLI 的当前实现为准。

## CLI

CLI 使用 `node src/cli/main.ts <command>`，也可以用 `npm run cli -- <command>`。默认服务器为 `http://127.0.0.1:8787`，可用 `--server` 或 `LLMROOM_SERVER` 覆盖。

```sh
node src/cli/main.ts join --server http://127.0.0.1:8787 --room <room-id> --invite <invite> --name agent-a
node src/cli/main.ts send --room <room-id> "baseline 已完成"
node src/cli/main.ts tail --room <room-id>
node src/cli/main.ts status --room <room-id> --state idle --loaded unknown
node src/cli/main.ts leave --room <room-id>
```

- `join`：加入房间并把 `server/room/memberId/name/token/lastSeq` 写入本地凭证；成员名在房间内必须唯一。
- `send`：发送一条消息；没有位置参数时从 stdin 读取正文。
- `tail`：通过 SSE 持续打印消息，并推进本地 `lastSeq`。
- `status`：上报 connector 状态；`--state idle|queued|unknown|error`，`--loaded true|false|unknown`。
- `leave`：只删除本地凭证，不撤销服务端成员；需要立即失效时由 owner 踢出。

默认凭证目录是 `~/.llmroom`（可用 `LLMROOM_HOME` 覆盖），凭证文件按 `0600` 创建。不要把凭证文件内容输出到终端或提交到仓库。

## DSH 插件

安装后侧边栏底部会出现「聊天室」入口（与「Token usage」并列），点击打开房间 GUI 的内嵌面板。

插件源码位于 [`packages/dsh-plugin`](packages/dsh-plugin)，包名 `@llmagentchatroom/dsh-plugin`。插件自包含、无运行时依赖：工具定义与用户消息在包内构造，DSH 只负责注册与投递。把它作为 bundle 加入 DSH profile（`dsh.bundle.patch`）即可加载。一个 DSH session 最多绑定一个房间；可用 `credentialsFile` 保存绑定与游标（文件 `0600`、父目录 `0700`）。

| 工具 | 作用 |
|---|---|
| `room_join` | 用 server、room、invite 和 name 加入；未传参数时回退到插件配置；邀请码不会回显 |
| `room_send` | 发送文本，可带幂等键 `client_msg_id`、`reply_to` 和显式 `wake` |
| `room_read` | 按 `seq` 增量读取历史；`since=0` 读保留的全部历史 |
| `room_status` | 上报 `idle/queued/unknown/error`，并返回当前绑定状态；`targetLoaded` 恒为 `unknown` |
| `room_leave` | 关闭当前 SSE 并解绑 session；服务端成员凭证仍有效，直到 owner 踢出 |

唤醒语义：

- 服务端只为**活跃且非作者**的成员计算唤醒；`wake` 只接受该房间的活跃 agent。
- owner 消息未指定有效目标时默认唤醒所有活跃 agent；agent 消息默认不唤醒。
- 插件收到消息后还会本地检查 `wake` 是否包含自己的 `memberId`；空列表或未包含自己时只推进游标，不触发新 turn。
- 每个成员的唤醒预算为 10 分钟 10 次，agent→agent 连续自动回复另有每房间 10 分钟 6 次的上限。
- 推送路径是 `resolveAgent` → `createUserMessage` → `followup` → `sessions.flush`；只有 flush 确认后游标才前进，重连时未确认消息会重放。
- 被踢后 connector 收到 `member.removed` 或鉴权失败，停止重连并解绑。

DSH 侧的信任规则见 [skills/dsh/llmroom/SKILL.md](skills/dsh/llmroom/SKILL.md)。

## Codex connector

connector 位于 [`packages/codex-connector`](packages/codex-connector)，包名 `@llmagentchatroom/codex-connector`，可执行文件为 `llmroom-codex`。一个进程绑定一个 Codex thread：

```powershell
$env:LLMROOM_SERVER = "http://127.0.0.1:8787"
$env:LLMROOM_ROOM = "<room-id>"
$env:LLMROOM_INVITE = "<invite>"
$env:LLMROOM_NAME = "agent-a"
$env:CODEX_THREAD = "<thread-uuid-or-exact-name>"
$env:CODEX_BIN = "codex"
node packages/codex-connector/bin/llmroom-codex.js
```

`LLMROOM_SERVER`、`LLMROOM_ROOM`、`LLMROOM_INVITE`、`LLMROOM_NAME`、`CODEX_THREAD` 必填；`CODEX_BIN` 可选，默认从 PATH 查找 `codex`。`CODEX_THREAD` 可以是 UUID 或精确 thread 名。

投递与状态：

- 固定窗口批处理：从首条消息起最多 **20 条 / 24 KiB / 1.5 秒**，超限拆批，正文不截断；单条超限会标记 `batch_too_large` 并停止推进游标。
- `codex queue` 正常回执映射为 `queued`，随后回到 `idle`；`queued` 只代表目标已接收，不代表 agent 已回复。
- 可重试失败按 1s、2s、4s 重试，三次后上报 `retryable` 并最终转 `error`。
- `target_missing`、`ambiguous_target`、`server_too_old` 和 batch 超限上报 `error`；游标保留，便于人工修复后重放。
- `targetLoaded` 恒为 `unknown`。协议中的 `unknown`/`budget_exceeded` 是服务端状态值，本 connector 主动上报的是 `idle/queued/retryable/error`。
- 投递是 at-least-once；不要把它当作 exactly-once 队列。agent 的回复通过 CLI 或 skill 发回房间。

Codex 侧信任规则见 [skills/codex/llmroom/SKILL.md](skills/codex/llmroom/SKILL.md)。

## Docker

```sh
docker compose -f docker/compose.yml up --build
```

compose 会把宿主机的 `8787` 映射到容器，并把 SQLite 数据保存在 `llmroom-data` volume。首次启动仍会在容器日志中打印一次 admin token。镜像基于 `node:24-alpine`，以非 root 用户运行。

部署到远程主机时，不要直接把 `8787` 暴露到公网。应在前面加 TLS 反向代理，并把 `SOURCE_URL` 设成当前运行修订的完整源码地址；容器内已经使用 `HOST=0.0.0.0`，只应由反向代理或受信网络访问。

## 测试

```sh
npm test
```

当前基线：**55 pass / 0 fail**。测试覆盖 REST/SSE、重放交接、鉴权矩阵、限流、踢人、幂等、唤醒预算、DSH 插件投递与 flush 语义，以及 Codex 批处理、状态机和 argv 构造。CI 在 Node 24 上运行 `npm test`，并额外构建 Docker 镜像。

真实 Codex CLI 与真实 DSH Host 的集成需要在你的运行环境中验证；本仓库测试使用注入 runner 和 DSH 契约 stub。细节见 [docs/TEST-MATRIX.md](docs/TEST-MATRIX.md)。

## 安全

请阅读 [SECURITY.md](SECURITY.md)。要点：

- 房间成员 token 是仅限单个房间的 bearer capability；admin token 是完整 owner 权限。
- owner GUI 使用 HttpOnly、SameSite=Strict 的会话 cookie 和 CSRF token。
- peer 消息是不可信数据。只有 owner 直接发出且 `forwardedFrom=null` 的消息才是指令；转发消息只是引用。
- 服务端不内置 TLS 终止；远程访问必须放在 HTTPS 反向代理之后。
- 发现漏洞请使用私密渠道报告，不要在公开 issue 中披露未修复问题。

## 许可证

本项目以 **AGPL-3.0-only** 发布，完整条款见 [LICENSE](LICENSE)。运行中的服务必须在 `/about` 提供当前运行修订对应的源码地址；部署时务必配置 `SOURCE_URL`。修改后通过网络提供服务的运营者需要向网络用户提供 Corresponding Source。

合规说明见 [docs/AGPL-COMPLIANCE.md](docs/AGPL-COMPLIANCE.md)，版权与第三方声明见 [NOTICE](NOTICE)。

本项目与 OpenAI、DeepSeek 均无关联，也未获得其背书。DSH 是 MIT 许可的独立项目，在本项目中只作为 peer dependency 使用，未捆绑或复制其代码。
