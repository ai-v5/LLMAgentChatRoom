# 测试矩阵（T1–T10）与 M0 合同

运行全部测试：

```sh
npm test
# 展开：node --test "test/**/*.test.ts" "test/**/*.test.mjs" "packages/**/*.test.mjs"
```

最近一次结果：**55 pass / 0 fail**（2026-10-19，Node 24.21.0，Windows）。

## T1–T10

| ID | 场景 | 测试文件 / 用例 | 状态 |
|---|---|---|---|
| T1 | 补拉期间写入 seq=43 | `test/handoff.test.ts`：205 条历史回放期间写入第 206 条，断言 seq 连续 1..206 | ✅ |
| T2 | 分页期间写入、交接瞬间断线 | 同上，历史按 200/页分两页；断线续传依赖 `Last-Event-ID` + `since` | ✅（断线用重连语义覆盖，未注入 TCP 断线） |
| T3 | 慢消费者溢出断开 + 续传 | `test/edge.test.ts`：pre-live 队列超 1000 条即结束连接；续传由客户端带 `since` 完成 | ✅ |
| T4 | 同 clientMsgId 同内容 / 不同内容 | `test/server.test.ts`：重复返回 200 + 原消息，内容不同 409 | ✅ |
| T5 | 跨房间 token、混合凭证、伪造 kind/forwardedFrom | `test/server.test.ts`、`test/contracts.test.ts`、`test/authz-extra.test.ts` | ✅ |
| T6 | 踢人与 SSE 断流、踢后旧 token | `test/kick.test.mjs`：踢人后流关闭，旧 token 401 | ✅（并发写在 SQLite 事务内串行，未单独注入交错） |
| T7 | 作者自收过滤、wake 空、预算超限 | `test/edge.test.ts`（自收、agent 默认不唤醒）、`test/contracts.test.ts`（预算 10 次） | ✅ |
| T8 | 20 条 / 24KB 拆批、argv | `packages/codex-connector/test/batcher.test.mjs`、`queue.test.mjs` | ✅ |
| T9 | DSH flush=false 不推进游标 | `packages/dsh-plugin/test/plugin.test.mjs` | ✅ |
| T10 | Codex 四类状态与 unknown | `packages/codex-connector/test/queue.test.mjs`、`connector.test.mjs` | ✅（`targetLoaded` 恒为 unknown） |

## M0 八条合同

| # | 合同 | 证据 |
|---|---|---|
| 1 | SSE 无缝隙交接 | T1/T2（handoff） |
| 2 | 幂等 + 409 | T4 |
| 3 | 鉴权矩阵 | T5 + CSRF/混合凭证 |
| 4 | 踢人时序 | T6 |
| 5 | 唤醒策略 + 自收过滤 | T7 |
| 6 | 批处理上限 | T8 |
| 7 | 限流（join 10/min、消息 60/min） | rate-limit / contracts |
| 8 | 固定错误码 | protocol + 各失败用例 |

## 未覆盖 / 明确标注

- 真实 Codex CLI 未安装，codex queue 成功路径用注入 runner 验证，默认 runner 仅验证 ENOENT。
- 运行中的 DSH Host 未接入，resolveAgent/followup/flush 用 stub + DSH 源码契约验证。
- Docker 本机不可用，镜像构建只在 CI job 中执行。
