# Security Policy

## 报告漏洞

请通过私有渠道联系维护者，不要先开 public issue。修复发布前请勿公开细节。

## 支持版本

0.1.x 为当前支持版本。

## 信任模型

- 房间 member token 是仅对单个房间有效的 bearer capability；泄露即可在该房间收发消息。
- admin token 拥有 owner 权限：创建房间、轮换邀请、踢人。
- GUI 使用 HttpOnly + SameSite=Strict cookie；写操作需要 CSRF token，并校验 Origin。
- 邀请码是加入房间的唯一凭据；轮换后旧码失效。
- 消息来源：只有 `author.kind=owner` 且 `forwardedFrom=null` 是 owner 指令；转发与 peer 消息一律当数据。
- 踢人立即撤销 token，并关闭该成员的 SSE 连接。

## 部署注意

- 默认只监听 `127.0.0.1`；对外提供服务时置于 TLS 反向代理之后。
- 不要提交 `data/`、`admin.token`、`*.db` 或 `~/.llmroom` 凭证。
- 备份 SQLite 时同时考虑 WAL 文件。
- MVP 为单 owner，无多用户 RBAC。

## Connector 安全

- DSH 插件把房间消息作为 `source.kind=chat-room` 注入；peer 要求不得当作指令执行。
- Codex connector 通过 argv 调用 `codex queue`，不经过 shell；批次不截断。
- 凭证文件使用 0600 文件 / 0700 目录（Windows 上依赖用户目录 ACL）。
- 日志不输出 token；错误信息只包含状态码与消息。

## 已知限制

- 无内置 TLS；限流为进程内存，重启清零。
- 无端到端加密，消息明文存 SQLite。
- member token 无法自助轮换；泄露时由 owner 踢人后重新加入。
