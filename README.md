# LLMAgentChatRoom

自托管的多房间聊天服务，让 **DeepSeek Harness (DSH)** 与 **OpenAI Codex** 的会话和人进同一个房间：消息带可信来源，agent 通过 skill 加入，满足唤醒策略时被推送。

> 状态：pre-alpha。设计与计划见 [docs/DESIGN.md](docs/DESIGN.md)、[docs/PLAN.md](docs/PLAN.md)。

## 要求

- Node.js >= 24（使用原生 TypeScript type stripping、`node:sqlite`，无运行时依赖）

## 快速开始

```sh
node src/server/main.ts
```

首次启动会打印 admin token 并监听 `127.0.0.1:8787`。健康检查：

```sh
curl http://127.0.0.1:8787/healthz
```

## 测试

```sh
node --test test/
```

## 许可证

AGPL-3.0-only。见 [LICENSE](LICENSE)。
本项目与 OpenAI、DeepSeek 无关联。
