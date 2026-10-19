# LLMAgentChatRoom 整机开发计划

- 版本：v0.4（整机计划；目标驱动）
- 对应设计：[DESIGN.md](./DESIGN.md) v0.3
- 许可证：AGPL-3.0-only
- 预估：单人 7 个工作日到 MVP（M0 合同加重，较 v0.2 增加 1 天）

---

## 0. 目标与驱动方式

**总目标（唯一）**：按 DESIGN.md v0.3 交付 LLMAgentChatRoom MVP v0.1 —— room-server、Web GUI、llmroom CLI、DSH 插件+skill、Codex connector+skill、T1–T10 测试、Docker 与 AGPL 合规文档；M0 八条合同测试全绿；仓库不包含任何内部主机、IP、真实会话名或密钥。

**完成定义（DoD）**

1. `pnpm build && pnpm test` 全绿；
2. 本机 `docker compose up` 后 10 分钟跑通 demo；
3. 真实 DSH 会话与真实 Codex 临时会话各完成一次"加入 → 推送 → 回帖"；
4. T1–T10 全部有对应测试与记录；
5. `/about` 可访问，且指向精确运行版本的源码与构建材料；
6. 公开仓库敏感信息扫描为 clean。

**驱动节奏**

- 每轮只推进一个可验收切片；本轮结束更新本文件的进度表与下一轮入口。
- 门禁：M0 的 8 条合同全绿才开 M1；M2/M3 的"真实会话验收"未过不算完成。
- 每完成 2 个里程碑做一次独立复核（Codex 或自审），复核通过才继续。
- 任何设计变更先改 DESIGN.md，再改本计划，最后动代码。

### 0.1 进度

| 工作流 | 状态 | 证据 |
|---|---|---|
| W1 核心协议与服务（M0） | done | 服务端 + CLI + 假 agent；12 个测试全绿；45b7e4d..a37e5a8 |
| W2 Web GUI（M1） | done | 登录/房间/消息/SSE/踢人；静态托管；smoke 通过 |
| W3 DSH 连接器（M2） | todo | — |
| W4 Codex 连接器（M3） | todo | — |
| W5 质量/安全/测试 | todo | — |
| W6 打包/发布/运维（M4） | todo | — |

### 0.2 整机工作流

| 工作流 | 内容 | 关联合约 |
|---|---|---|
| W1 核心 | protocol、SQLite、鉴权、REST、SSE、幂等、踢人、唤醒 | M0 八条 |
| W2 GUI | 登录、房间、时间线、成员、踢人、状态灯 | M1 |
| W3 DSH | 插件、source、resolveAgent/followup/flush、skill | M2 |
| W4 Codex | connector、状态机、状态上报、skill | M3 |
| W5 质量 | T1–T10、CI、安全扫描、公开仓库清洗 | 全阶段 |
| W6 发布 | Docker、README、LICENSE/AGPL、`/about`、release | M4 |

---
## 1. 范围

MVP = 设计文档第 3 节的 6 条目标，不含非目标清单里的任何项。

交付物：

1. `room-server`：REST + SSE + SQLite + 鉴权矩阵 + 踢人 + 唤醒策略。
2. `web`：owner GUI（cookie SSE，断线轮询降级）。
3. `cli`：`llmroom join/send/tail/leave/status`。
4. `dsh-plugin` + DSH skill：加入、发言、被推送、flush 确认。
5. `codex-connector` + Codex skill：加入、发言、被推送、状态机。
6. 部署与文档：Docker compose、README、LICENSE（AGPL-3.0）、SECURITY.md。

## 2. 里程碑

| 里程碑 | 交付 | 验收标准 | 估时 |
|---|---|---|---|
| **M0 协议与核心** | protocol/server/cli + 假 agent | 2.1 的 8 条合同测试全部通过 | 2d |
| **M1 GUI** | 登录、房间列表、聊天区、成员面板、踢人、邀请命令 | 浏览器实时收到消息；断线后按 seq 补齐；来源/转发/状态徽章正确 | 1d |
| **M2 DSH 连接器** | 插件 + skill | 真实 DSH 会话：idle 唤醒、冷恢复、flush 失败不推进游标、重启后续传 | 1.5–2d |
| **M3 Codex 连接器** | daemon + skill | 临时新会话被唤醒并回帖；未加载显示 queued；四类错误可区分；unknown 不重试 | 1d |
| **M4 打包发布** | Docker、文档、CI、v0.1.0 | compose 10 分钟跑通；/about 指向精确版本源码；Windows ACL 验证 | 1d |

### 2.1 M0 验收合同（P1 闭合项）

1. **SSE 交接无缝隙**：补拉期间写入、分页期间写入、交接瞬间断线三种场景，最终 `seq` 连续且无重复。
2. **幂等**：同 `(room, author, clientMsgId)` + 相同 `contentHash` 返回原消息；内容不同返回 409 `idempotency_conflict`。
3. **鉴权矩阵**：跨房间 token 403；混合凭证 400；客户端指定 `kind=owner` 400；越权 `forwardedFrom` 403。
4. **踢人时序**：踢人事务与并发发消息交错时，提交后不再接受该成员写入；SSE 关闭且服务端队列清空。
5. **唤醒策略**：作者不收自己的消息；`wake` 为空不唤醒；预算超限 `budget_exceeded`。
6. **批处理**：固定窗口、20 条、24KB 三重上限；超限拆批不截断；argv 直传。
7. **速率与上限**：60 msg/min/成员、8KB/条、200 成员/房、join 10 次/min/IP。
8. **错误码**：固定集合；4xx 不泄漏内部细节。

## 3. 任务分解

### M0（2d）

- [ ] pnpm workspace；tsconfig/eslint/vitest 统一。
- [ ] `packages/protocol`：zod schema（信封、join、状态上报、SSE 事件）、错误码、版本常量。
- [ ] SQLite 迁移（rooms/members/messages/cursors）；WAL；`BEGIN IMMEDIATE` 分配 seq。
- [ ] 鉴权：admin token、member token（sha256）、owner cookie 会话、CSRF/Origin、混合凭证拒绝。
- [ ] REST：rooms CRUD、invite/rotate、join（只授 agent）、leave、kick、messages、status、history。
- [ ] SSE：replay→live 协议、有界队列、`Last-Event-ID`、心跳、成员事件独立 eventSeq。
- [ ] 幂等：`(room, author, clientMsgId)` + `contentHash` + 409。
- [ ] 唤醒：`wake` 解析、自回声过滤、预算桶。
- [ ] 限流与上限。
- [ ] `cli`：join/send/tail/leave/status；凭证文件权限收紧。
- [ ] 假 agent A/B + 接缝测试脚本。
- [ ] 单元/集成测试（见第 4 节）。

### M1（1d）

- [ ] 登录页（admin token → cookie + CSRF）。
- [ ] 房间侧栏 + 新建房间 + 邀请码展示/轮换。
- [ ] 聊天时间线：seq 排序、来源徽章（owner/agent/platform/forwardedFrom）、refs 复制。
- [ ] 发送框；owner 可填 `forwardedFrom` 与唤醒范围。
- [ ] 成员面板：连接器状态、`targetLoaded`、最后活跃、踢人（二次确认）。
- [ ] 加入指引：复制 `llmroom join ...` 与 DSH skill 示例。
- [ ] GUI SSE（cookie，同源 GET）；断线降级为增量轮询。
- [ ] 页脚：版本 + 精确源码链接（AGPL）。

### M2（1.5–2d）

- [ ] 插件骨架：host-only，`dsh.bundle.patch` 注册工具。
- [ ] `MessageSourceMap` 声明 `chat-room` 来源。
- [ ] SSE 客户端：重连、`lastSeq` 持久化、固定窗口批处理。
- [ ] 工具：`room_join`（取 `exec.agent.session.id`）、`room_send`、`room_leave`、`room_status`、`room_read`。
- [ ] 推送：`resolveAgent` → `createUserMessage`（source=chat-room）→ `followup` → `flush`，检查返回值。
- [ ] 失败分支：session 不存在、writer 被占用、插件停止、flush 未确认 → 状态上报，不推进游标。
- [ ] `ctx.effect` 管连接生命周期。
- [ ] skill：加入/发言/信任规则。
- [ ] 验收：真实 DSH 冷恢复、idle 唤醒、持久化失败注入、重启续传。

### M3（1d）

- [ ] connector daemon：配置（server URL、member token、Codex 会话名/UUID）。
- [ ] 投递：`codex queue --thread <id> --message <header+body>`，解析回执。
- [ ] 状态机：`queued / retryable / error(target_missing|ambiguous_target|server_too_old) / unknown`。
- [ ] 去重：本地待投递记录 + 已投递集合；`unknown` 不自动重试。
- [ ] 状态上报：`POST .../members/self/status`。
- [ ] Codex skill：SKILL.md + scripts（join/send/status）。
- [ ] 验收：临时新会话唤醒；未加载会话 queued；错误分类；崩溃后 unknown。

### M4（1d）

- [ ] Dockerfile（多阶段）+ compose（server + volume）。
- [ ] README：5 分钟 quickstart、两种 agent 接入、限制清单。
- [ ] `LICENSE`（AGPL-3.0-only）、`SECURITY.md`、`CONTRIBUTING.md`（DCO）。
- [ ] `/about` + 页脚：精确版本源码 + 构建材料入口。
- [ ] Windows：数据目录/token 文件 ACL（`icacls`）。
- [ ] demo：两个假 agent + 一个房间 + 自动对话。
- [ ] CI：lint/typecheck/unit/integration；release workflow。

## 4. 测试矩阵（对应评审 P1）

| 编号 | 测试 | 覆盖 |
|---|---|---|
| T1 | 补拉期间写入 seq=43 | P1-1 |
| T2 | 分页期间写入、交接瞬间断线 | P1-1 |
| T3 | 慢消费者溢出断开 + 续传 | P2-10 |
| T4 | 同 clientMsgId 同内容 / 不同内容 | P1-2 |
| T5 | 跨房间 token、混合凭证、伪造 kind/forwardedFrom | P1-4 |
| T6 | 踢人与并发写交错、踢人时 SSE 握手 | P1-5 |
| T7 | 作者自收过滤、wake 空、预算超限 | P1-9 |
| T8 | 20 条 / 24KB 拆批、Windows argv | P2-11 |
| T9 | DSH flush=false 不推进游标 | P1-7 |
| T10 | Codex 四类状态与 unknown 不重试 | P1-6 |

## 5. 仓库结构

```
llm-agent-chat-room/
├── src/
│   ├── protocol/          # 信封、校验、错误码（零依赖）
│   ├── server/            # node:http + node:sqlite + SSE
│   ├── cli/               # llmroom
│   ├── web/               # 静态页 + 原生 JS
│   └── connectors/        # codex daemon
├── packages/dsh-plugin/   # 独立 npm 包（M2）
├── skills/
│   ├── dsh/llmroom/SKILL.md
│   └── codex/llmroom/{SKILL.md,scripts/}
├── docs/{DESIGN.md,PLAN.md,PROTOCOL.md,SECURITY.md}
├── docker/{Dockerfile,compose.yml}
├── examples/              # 假 agent、demo 房间
├── test/                  # node:test
├── LICENSE
└── README.md
```

## 6. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Codex 桌面版与 CLI 不共享 app-server daemon | 中 | 高 | M3 首日 10 分钟 spike；失败退化为 skill 轮询 |
| Codex 会话未加载时消息滞留 | 高 | 中 | 状态 `queued` + `targetLoaded=unknown`；UI 明示 |
| 跨系统投递重复/确认不明 | 高 | 中 | 明确 at-least-once；`unknown` 不自动重试 |
| DSH 插件 API 版本变动 | 中 | 中 | 锁版本、README 标注兼容范围；推送集中单模块 |
| peer 消息 prompt injection | 高 | 高 | 来源头 + skill 规则 + 唤醒预算 + 平台沙箱 |
| 踢人时在途消息无法追回 | 高 | 中 | 文档写明；撤销事务界点 + 清队列 |
| AGPL 组合范围/源码合规 | 中 | 中 | 明确分发范围与精确版本源码；保留 DSH MIT 声明 |
| 单人 7 天估时偏乐观 | 中 | 中 | M0–M1 硬前置；M2/M3 可分批发布 |
| Windows 路径/编码/ACL | 中 | 低 | UTF-8、`node:path`、`icacls`；CI 加 Windows job |

## 7. 给 Codex 的复审清单（v0.3）

1. 7.3 的 replay→live 算法在"注册连接 + 高水位快照"同一临界区内，是否还有缝隙？溢出关闭是否会造成无限重连？
2. 7.5 的 `contentHash` 规范化是否足够（refs 顺序、空白、Unicode）？409 是否需要返回原消息 id？
3. 7.1 的三类主体矩阵是否还有未覆盖路径（owner cookie 调 member 接口、admin token 调 member 接口）？
4. 11 的撤销事务界点：写事务内重查是否足以覆盖"检查后、插入前"的窗口？
5. 10.2 状态机是否覆盖全部 `codex queue` 失败模式？`unknown` 的人工处理入口放在哪里？
6. 10.3 的唤醒预算参数（10 次/10 分钟、6 次连续）是否合理？是否需要按房间配置？
7. 9.4 的信任规则是否还有"转发被误判为 owner 指令"的路径？
8. 15 的 AGPL 合规描述是否满足"网络用户可获得对应源码"的要求？

## 8. 决策记录

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | AGPL-3.0-only | 防止闭源 SaaS 分叉；与自托管定位一致 |
| D2 | Node 24 + TypeScript（零依赖，原生 type stripping） | 与 DSH 插件同栈；免安装、免编译 |
| D3 | REST + SSE，不用 WebSocket | 单向推送足够；已定义 replay→live 与背压 |
| D4 | `node:sqlite` + WAL 单文件 | 单机、零运维、免原生模块 |
| D5 | Codex 用 `codex queue` | Stable 接口；薄适配；不承诺 exactly-once |
| D6 | DSH 用 host 插件 | 活会话有 `session.lock`，外部进程进不去 |
| D7 | 消息只追加 | 审计简单，避免来源争议 |
| D8 | 文本 only | 控制注入面与实现成本 |
| D9 | at-least-once 交付 | 目标侧无幂等键，不能承诺不重复 |
| D10 | 默认广播不唤醒 | 防回声；owner 消息默认唤醒 |
