# AGPL-3.0-only 合规说明

本文说明 LLMAgentChatRoom 为何采用 AGPL-3.0-only、在本项目中"对应源码"（Corresponding Source）包含什么，以及部署者、修改者和二次分发者如何履行义务。本文不是法律意见；如有疑问，请咨询合格的法律专业人士。

## 为什么是 AGPL-3.0-only

LLMAgentChatRoom 是网络服务，而不是只在本地运行的工具。GPL-3.0 主要约束分发；AGPL-3.0 第 13 条进一步要求：如果修改后的程序通过网络与用户交互，运营者必须向这些用户提供获取对应源码的机会。这正好覆盖"自托管房间服务"的部署形态，也符合项目"可审计、修改必须回流"的目标。

项目选择 **AGPL-3.0-only**，而不是 `AGPL-3.0-or-later`：使用者只能按第 3 版条款使用，不能自行选择未来版本。仓库根目录的 [LICENSE](../LICENSE) 是完整许可证文本，`package.json` 及发布包也声明 `AGPL-3.0-only`。

## 本项目的 Corresponding Source

就本项目而言，Corresponding Source 至少包括：

- `src/` 中的 room-server、Web GUI、协议和 CLI 源码；
- `packages/dsh-plugin`、`packages/codex-connector` 的源码；
- `skills/` 中的 agent 指令与相关脚本；
- `docker/Dockerfile`、`docker/compose.yml` 以及构建、安装和运行所需的其他脚本；
- `test/` 中的测试代码，用于验证构建结果；
- 版权声明、[LICENSE](../LICENSE)、[NOTICE](../NOTICE) 和必要的修改说明。

对应源码必须足以生成、安装和运行**同一修订**的服务。它不包括运行数据、SQLite 数据库、admin token、成员凭证、邀请码、私有配置或其他秘密。若部署中包含本地修改，修改本身也属于对应源码。

## `/about` 与源码供给

服务端提供公开的 `GET /about`，返回：

```json
{
  "name": "llm-agent-chat-room",
  "version": "0.1.0",
  "license": "AGPL-3.0-only",
  "source": "https://example.com/llm-agent-chat-room/tree/<revision>",
  "protocolVersion": 1
}
```

| 字段 | 含义 | 合规要求 |
|---|---|---|
| `name` | 项目名 | 保持稳定，便于识别服务 |
| `version` | 运行版本 | 与发布 tag / 构建信息一致 |
| `license` | `AGPL-3.0-only` | 不得改成其他许可 |
| `source` | 对应源码位置 | 必须是当前运行修订的精确源码地址 |
| `protocolVersion` | 协议版本 | 当前为 `1` |

部署者必须把 `SOURCE_URL` 设置为**当前运行修订**的可访问源码地址，例如某个不可变的 commit 或 release tag，而不是会移动的分支头。代码中的默认仓库地址只是上游项目地址，不能替代部署者对自己运行版本的声明。源码下载不应要求提供服务的凭证。

仅有 `/about` 链接还不够：网络用户必须能够实际获取完整对应源码。若通过定制版本对外提供服务，应在 `/about` 的 `source` 指向该定制版本的源码，或提供同等清晰的获取说明，并保留修改记录。

## 修改后通过网络提供服务

AGPL 第 13 条适用于修改版本。若你修改本项目并在网络上供他人使用，需要：

1. 保留本项目的版权与许可证声明；
2. 清楚标记修改内容与修改日期；
3. 向所有网络用户提供修改版本的 Corresponding Source，而不是只链接到本项目上游；
4. 确保源码包含部署所需的构建和安装材料，并可从服务所在位置获取；
5. 不添加禁止用户行使 AGPL 权利的限制。

内部自用且未对外提供网络交互的修改，不以第 13 条触发源码提供义务；但一旦第三方通过网络使用该服务，就应按上述方式提供源码。分发修改版本时还必须满足 AGPL 的其他条款。

## 二次分发

分发源码、二进制、容器镜像或组合包时：

- 必须附带完整的 [LICENSE](../LICENSE) 和 [NOTICE](../NOTICE)；
- 必须保留所有版权、许可证和免责声明；
- 必须提供 Corresponding Source，或按 AGPL 允许的方式提供有效的书面源码获取要约；
- 必须标记对原作品的修改；
- 不得对接收者施加额外法律限制。

建议在发布页同时给出源码归档、版本 tag、构建命令和镜像 digest，使接收者能复现对应版本。

## 与 DSH、Codex 及第三方的边界

### DeepSeek Harness (DSH)

DSH 采用 MIT 许可证。本项目仅在 `packages/dsh-plugin` 中声明并使用 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools` 作为 **peer dependencies**，通过 DSH Host 的公开 API 工作；仓库不捆绑 DSH，也未复制 DSH 源码。

MIT 与 AGPL 兼容。若你分发包含 DSH 的组合作品，仍需保留 DSH 的 MIT 版权与许可声明。本项目不需要也不提供 linking exception。

### OpenAI Codex CLI

Codex CLI 是独立程序。connector 通过子进程以 argv 调用 `codex queue --thread ... --message ...`，不链接 Codex 代码，也不把 Codex 打包进本仓库。使用者需自行安装 Codex，并遵守其自身许可与服务条款。

### 其他第三方组件

本项目自身**没有第三方运行时依赖**，只使用 Node.js 内置模块（包括 `node:http`、`node:sqlite`、`node:crypto`）。因此仓库不包含需要额外声明的 vendored 第三方代码。

Node.js 运行时按 Node.js 自身许可证分发；本项目不分发 Node.js。构建 Docker 镜像时会包含 Node.js 与基础镜像中的组件，发布镜像时应保留其许可证和 notices。DSH、Codex 等外部程序不属于本项目 Corresponding Source，但组合分发时仍需遵守各自许可证。

## 在 Docker 中合规

容器镜像中包含 AGPL 代码，因此镜像本身也是分发：

1. 用**源码修订号**给镜像打 tag，例如 `llm-agent-chat-room:<revision>`，不要只发布 `latest`；
2. 在镜像元数据中记录源码地址，例如 `org.opencontainers.image.source`；
3. 公开与该镜像对应的源码、`Dockerfile`、compose 文件和构建说明；
4. 通过 compose 的 `SOURCE_URL` 或运行环境变量把 `/about` 指向该精确修订；
5. 若修改了镜像内的代码，发布修改后的 Corresponding Source，而不是仅指向本项目上游；
6. 同时保留 Node.js 和基础镜像要求的许可证与 notices。

compose 中的 `SOURCE_URL` 示例值必须在上线前替换为部署者自己的不可变源码地址。

## 合规检查清单

- [ ] `LICENSE` 为 AGPL-3.0 全文，仓库与发布包均声明 `AGPL-3.0-only`
- [ ] `/about` 返回 `name`、`version`、`license`、`source`、`protocolVersion`
- [ ] `SOURCE_URL` 指向当前运行修订，而非浮动分支
- [ ] 网络用户可以实际获取对应源码和构建材料
- [ ] 修改版本标记了修改并发布其源码
- [ ] 分发物包含 `LICENSE`、`NOTICE` 与版权声明
- [ ] 组合分发 DSH 时保留其 MIT 声明
- [ ] Docker 镜像以源码修订 tag 发布，并公开对应源码

## 相关文件

- [LICENSE](../LICENSE)
- [NOTICE](../NOTICE)
- [README](../README.md)
- [SECURITY](../SECURITY.md)
