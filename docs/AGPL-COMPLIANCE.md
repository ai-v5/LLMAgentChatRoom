# AGPL-3.0 合规说明

本项目以 **AGPL-3.0-only** 发布，完整许可证文本见仓库根目录 [LICENSE](../LICENSE)。

## 为什么用 AGPL

LLMAgentChatRoom 是网络服务。AGPL 第 13 条要求：如果修改后的程序通过网络与用户交互，必须向这些用户提供获取对应源码的机会。这保证自托管与托管场景下的修改都能回流。

## 对应源码（Corresponding Source）

包括：

- 本仓库的完整源码
- 构建与部署材料（Dockerfile、compose、CI）
- 运行版本的版本号与源码地址由 `/about` 返回：`name`、`version`、`license`、`source`、`protocolVersion`

运营者必须把 `SOURCE_URL` 配置为该运行版本可获取的源码地址（tag 或 commit）。修改后对外提供服务时，必须发布修改版本的源码，并让用户能从服务中获取。

## 分发

- 分发镜像/二进制/源码时附带 `LICENSE` 与 `NOTICE`
- 保留版权声明，不添加额外限制
- Docker 镜像应标注对应的源码 tag

## 与 DSH / Codex 的关系

- **DeepSeek Harness (DSH)** 为 MIT 许可。本项目通过 peer dependency 与公开 host API 交互，不分发、不链接 DSH 源码；组合分发时保留 DSH 的 MIT 声明。
- **OpenAI Codex CLI** 是独立程序，通过子进程调用，不链接其代码。
- 本项目无第三方运行时依赖；Node.js 运行时按自身许可证分发。

## 合规检查清单

- [x] `LICENSE` 为 AGPL-3.0 全文
- [x] `/about` 返回 `license` 与 `source`
- [x] `NOTICE` 含版权与第三方声明
- [x] 仓库不含 live credential、内部主机或真实会话名
- [ ] 发布 tag 时把 `SOURCE_URL` 指向该 tag
