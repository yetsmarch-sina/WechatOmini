# WeChat ↔ AHP 迁移设计（从 terminal restore WeChat session）

> 状态：设计草案（仅设计，暂不实现）
> 目标读者：本仓库维护者
> 关联文档：[`wechat-acp-mvp-design.md`](./wechat-acp-mvp-design.md)

## 1. 背景与目标

当前形态：本地运行 manager，经 **ACP**（Agent Client Protocol）拉起 agent 子进程（Copilot CLI 等），WeChat 作为唯一入口驱动会话。

诉求：**同一批 WeChat 会话，也能从 terminal 里 restore / 继续**，最好是“同时在线、状态同步”，而不仅是会话结束后的串行交接。

结论先行：

- 用 **AHP**（Agent Host Protocol，微软提出）正是为“**N 个 client 共享同一批 agent session**”而设计，恰好命中这个诉求。
- **AHP 不替代 ACP**。AHP 是 ACP 之上的**协调层**；一个 AHP host 对上用 AHP 跟多个 client 说话，对下仍用 ACP 跟 agent 说话。
- 因此本迁移是**增量加一层 host**，而非推翻现有 ACP 代码。现有 `AcpSession` 几乎原样保留，成为 host 的 agent 后端。

## 2. AHP 是什么 / 与 ACP 的关系

来源：<https://github.com/microsoft/agent-host-protocol>（规范当前为 **DRAFT，protocol version 1**，明确声明会有破坏性变更）。

| 关注点 | ACP | AHP |
|---|---|---|
| 定位 | 点对点：1 client ↔ 1 agent | 协调层：N client ↔ 1 host ↔ N agent |
| 传输 | stdio + ND-JSON | JSON-RPC 2.0，传输无关（参考实现走 WebSocket） |
| 状态权威 | agent 持有 session 状态 | **host 持有权威 state tree**，client 通过 reducer 同步 |
| 多 client | 不涉及 | 核心目的：状态同步 + 动作排序 |
| 断线重连/重放 | 协议层未规定 | **内建**：`reconnect` 携带 `lastSeenServerSeq` 重放缺失动作 |
| session 生命周期 | client 直接向 agent 建会话 | **host 管理 session，client 按 URI 订阅** |

官方原话可概括为：**“AHP 是 ACP 之上的一把 mutex”** —— 把 ACP 的 1:1 对话用协调机制包起来，让 N 个 client 能同时观察/参与而不互相踩踏（turn 归属、tool 确认仲裁、取消、乐观更新+对账）。

分层示意：

```
  WeChat adapter ──┐
  terminal (ahpx) ─┼── AHP ──►  AHP Host  ── ACP ──►  Copilot CLI / opencode
  VS Code ─────────┘            (权威状态/排序)        (现有 AcpSession)
```

### AHP 的几个关键概念

- **Channel**：一切推送都挂在 URI 标识的可订阅资源上。根目录 `ahp-root://`，会话 `ahp-session:/<uuid>`，另有 chat / terminal / changeset 等 channel。
- **Action + serverSeq**：状态只能通过服务端排序的 action 改变；每个 action 带单调递增 `serverSeq`，这是重放与对账的基础。
- **Session vs Chat**：session channel 管会话级元数据与 chat 目录；逐轮对话（turns / 流式 / tool call）在 **chat channel**（`ahp-chat:/<cid>`）上。
- **能力协商**：`initialize` 提供版本列表，server 选一个；版本即能力集合。

## 3. 现状架构梳理（ACP 版）

| 模块 | 文件 | 职责 |
|---|---|---|
| 入口 | `src/bin/wechat-acp-manager.ts` | 装配 store / transport / manager，启动 WeChat 或本地输入 |
| 编排 | `src/manager/workspace-manager.ts` | 路由消息、管理 workspace、起停 `AcpSession`、记忆/上下文 |
| ACP 会话 | `src/acp/session.ts` | spawn agent 子进程，`initialize` + `newSession` + `prompt`，捕获 resume 信息 |
| ACP client | `src/acp/client.ts` | 实现 `acp.Client`：收流式 chunk、自动授权、读写文件 |
| 传输抽象 | `src/types.ts` (`MessageTransport`) | `sendReply` / `sendTyping` |
| WeChat | `src/wechat/*` | 登录、轮询、收发消息 |
| 本地 | `src/adapters/local.ts` | 终端 stdin 驱动同一个 manager |
| 存储 | `src/memory/store.ts` | SQLite：workspace 记录、turns、记忆、resume 信息 |

现状的“restore”能力（见 `wechat-acp-mvp-design.md:141`）：从 agent stderr 捕获 `--resume <id>`，存进 workspace 记录，`/workspace current` 显示，可在 PC terminal 跑 `copilot --resume <id>`。**这是串行交接，不是多端共享。**

## 4. 目标架构（AHP host 包裹现有 ACP）

新增一个 **AHP Host 进程**（独立、可长驻），它：

1. 对上：监听 WebSocket，讲 AHP，向所有订阅 client 同步 session/chat 状态。
2. 对下：每个 AHP session 背后挂一个现有 `AcpSession`（agent 后端），用 ACP `session/prompt` 等驱动。
3. 维护权威 state tree + `serverSeq`，支持 `reconnect` 重放。

两端 client：

- **WeChat adapter** → 从“直接调 `WorkspaceManager`”改为“作为一个 AHP client 连 host”。
- **Terminal** → 直接用现成的 [`ahpx`](https://github.com/TylerLeonhardt/ahpx)（`@tylerl0706/ahpx`）连同一个 host，即可 `session list` / `-S <id> prompt` 恢复并继续会话，几乎零自研。

```
┌─────────────┐      ┌─────────────┐
│ WeChat       │      │ terminal     │
│ adapter      │      │ (ahpx)       │
└──────┬──────┘      └──────┬──────┘
       │ AHP/WS             │ AHP/WS
       └─────────┬──────────┘
                 ▼
          ┌──────────────┐
          │  AHP Host     │  权威 state tree + serverSeq + reducers
          │  (新增)       │  session/chat channels；reconnect 重放
          └──────┬───────┘
                 │ ACP (stdio)
                 ▼
          ┌──────────────┐
          │ AcpSession    │  现有代码，基本不动
          │ → Copilot CLI │
          └──────────────┘
```

## 5. 组件映射与改造点

| 现状 | 目标 | 改动量 |
|---|---|---|
| `AcpSession` / `AcpClient` | AHP host 的 **agent 后端**；新增 “ACP 事件 → AHP action” 的 mapper（把 `agent_message_chunk`/`tool_call` 等映射成 `session/delta`、`session/toolCallStart` 等） | 中：保留主体，加 mapper |
| `WorkspaceManager` 的会话编排 | 拆分：会话状态权威迁入 **AHP Host**；workspace 概念映射为 **session channel**（`ahp-session:/<uuid>`） | 大 |
| `MessageTransport`（WeChat/local） | WeChat 改写为 **AHP client**（订阅 session channel，渲染 action → 文本回 WeChat；用户消息 → `dispatchAction`/prompt） | 大 |
| `local.ts` 终端入口 | 直接由 `ahpx` 取代（或保留做调试） | 可删 |
| `MemoryStore`（resume/turns） | host 侧 session 持久化 + `serverSeq` 重放缓冲；记忆 MCP 仍可挂在 agent 后端 | 中 |
| resume 命令捕获逻辑 | 由 AHP 的 session URI + `reconnect` 取代 | 简化 |

> 注意：WeChat 是纯文本 IM，没有富 UI。它作为 AHP client 时只需消费 action 流并“拍平成文本”，乐观更新/对账这些主要服务于富客户端，对 WeChat 端可弱化。

## 6. Restore / 多端流程

### 6.1 终端恢复一条 WeChat 会话

```
1. WeChat 侧已有 session：ahp-session:/<uuid>（host 持久化）
2. 终端：ahpx server add local --url ws://localhost:<port> --default
3. ahpx session list           # host 返回 root 目录里的 session 列表
4. ahpx prompt -S <uuid> "..."  # 订阅该 session/chat，继续对话
   → host 经 ACP 把 prompt 发给同一个 AcpSession
   → action 广播：WeChat 端与终端同时看到同一轮输出
```

### 6.2 断线重连（host 仍在跑，client 掉线）

```
client reconnect(channel: ahp-root://, lastSeenServerSeq: N, subscriptions: [...session URIs])
  → host 若能从 N 重放：返回 { type: "replay", actions: [...] }
  → 超出重放缓冲：返回 { type: "snapshot", snapshots: [...] }
  → 已销毁的 session 列在 missing[]，client 丢弃
```

### 6.3 host 重启后恢复

需要 host 把 session 元数据 + 关联的 ACP resume id 落盘；重启时按需重建 `AcpSession`（沿用现有 `--resume` 把 agent 侧历史接回）。**这一步把现有 ACP resume 能力变成 host 内部实现细节。**

## 7. 关键技术取舍 / 现实约束

1. **没有现成的 host npm 包。** AHP 仓库发布的是 **client** 库（TS 为 `@microsoft/agent-host-protocol`，含 `AhpClient` / reducers / `WebSocketTransport`）。**host/server 的参考实现目前在 VS Code 里**（`src/vs/platform/agentHost/node/`）。所以 host 需要自研或从 VS Code 移植 —— 这是本迁移**最大的成本与风险点**。
2. **规范是 DRAFT。** protocol version 1，wire types/action/state 明确会有破坏性变更。短期落地需锁版本并接受跟进成本。
3. **WeChat client 的 reducer 工作量。** 需把 host 的 action 流映射成 IM 文本（turn 开始/结束、流式增量节流、tool 确认提示等）。
4. **权限/授权。** 现有 `AcpClient` 是“自动放行”。AHP 把 tool 确认提升为状态动作（任意 client 可解决、先到先得）。多端下要决定 WeChat 端是否暴露确认入口，还是继续 host 侧自动放行。
5. **认证。** AHP 有 `authenticate` / `AuthRequired(-32007)`；若 host 暴露在 localhost 以外（如 Dev Tunnel），必须接入鉴权。
6. **复用 `ahpx` 降低终端成本**，但要确认其支持的协议版本与自研 host 协商一致（`ahpx tunnel` 发现的是 `protocolv5` 标签，需核对版本约定）。

## 8. 分阶段实施建议（后续真正动手时）

- **阶段 0 — PoC（验证可行性）**：起一个最小 AHP host（单 session，固定后端 = 现有 `AcpSession`），实现 `initialize` / `subscribe` / `createSession` / prompt 透传 + action 广播。用 `ahpx` 连上验证 `session list` 与 `-S <id> prompt`。**目标：终端能看到并继续一条会话。**
- **阶段 1 — WeChat client 化**：把 WeChat adapter 改成 AHP client，与 `ahpx` 共享同一 host 的同一 session，验证“同时在线”。
- **阶段 2 — 多 session + 持久化 + reconnect**：root 目录、session 落盘、`reconnect`/`lastSeenServerSeq` 重放、host 重启恢复。
- **阶段 3 — 权限/认证/打磨**：tool 确认策略、鉴权、节流、错误处理、版本协商加固。

## 9. 未决问题（需拍板）

1. host 是**独立进程**还是嵌进现有 manager 进程？（推荐独立，利于多端长驻与重启恢复）
2. WeChat 端是否需要 tool 确认交互，还是维持 host 侧自动放行？
3. 是接受“自研/移植 host”的成本，还是先用阶段 0 PoC 评估后再决定是否全面迁移？
4. 是否要保留 ACP 串行 `--resume` 作为**降级方案**，在 AHP host 不可用时仍可终端续聊？

## 10. 参考

- AHP 仓库：<https://github.com/microsoft/agent-host-protocol>
- AHP × ACP 关系：`docs/guide/ahp-and-acp.md`
- 规范总览 / 生命周期 / 会话 channel：`docs/specification/{overview,lifecycle,session-channel,chat-channel}.md`
- TS client：`@microsoft/agent-host-protocol`
- 终端 client `ahpx`：<https://github.com/TylerLeonhardt/ahpx>（npm `@tylerl0706/ahpx`）
- host 参考实现：VS Code `src/vs/platform/agentHost/node/`
