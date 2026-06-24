# WeChat Gateway 设计：单进程 · 多通道 · 实时广播

> 状态：设计草案（自研最小 Hub，不引入完整 AHP）
> 目标读者：本仓库维护者
> 关联文档：[`wechat-acp-mvp-design.md`](./wechat-acp-mvp-design.md)、[`wechat-ahp-migration-design.md`](./wechat-ahp-migration-design.md)、[`wechat-richview-publish-html-design.md`](./wechat-richview-publish-html-design.md)

## 1. 目标

把现状的“单通道、一次性文本回复”升级为 **一个 gateway 进程：多个前端通道同时在线、共享同一条 live session、实时同步**。

落地诉求：
- **网页为主**的富交互（实时流式 markdown / diff / tool / plan）。
- **WeChat 为辅**（摘要 + 进度 + 深链，不刷屏）。
- **agent 仍在本机**经 ACP 驱动 Copilot CLI（保留本地账号优势）。
- 不引入完整 AHP，自研最小“订阅 + 广播 + 补帧”。

## 2. 现状（原始 gateway 雏形）

```
入口(bin) 二选一注入 transport(WeChat | Local)
   channel ──IncomingMessage──► WorkspaceManager.handleIncoming()
   manager ──sendReply(整段文本)──► 单个 transport
```

三个局限（对应痛点）：
1. **一次只能一个通道**（`src/bin/wechat-acp-manager.ts:45-75`：WeChat 或 Local 二选一）。
2. **回复一次性**：`AcpClient` 把流式 chunk 攒起来最后 `flush`（`src/acp/client.ts:39-96`），不实时外吐。
3. **无“多端共享 session”概念**：`sendReply` 只发给发起者 `ReplyTarget`（`src/types.ts:8-16`）。

## 3. 目标架构

```
   WeChat adapter ─┐                         ┌─► WeChat: 摘要/进度/深链
   Web adapter   ──┤   inbound(消息)         ├─► Web: 实时流式富渲染
   Terminal      ──┤        ▼                │
                   │   ┌──────────┐  events  │
                   └──►│ Gateway  │──────────┘  outbound(广播)
                       │  core    │
                       │ +事件总线 │
                       │ +订阅表   │
                       └────┬─────┘
                            │ 驱动本机 agent(ACP)
                            ▼
                       AcpSession ──► Copilot CLI(本地账号)
```

核心三件事：**① 多 channel 同时在线；② core 持有 session 并经 ACP 驱动本地 agent；③ 一条事件总线，把 agent 实时更新按 session 广播给所有订阅通道。**

## 4. 核心接口

### 4.1 Channel（把现有 `MessageTransport` 升级为双向）

```ts
interface Channel {
  id: string;                       // "wechat" | "web" | "terminal"
  // 入站:用户消息进来(等价现在 onMessage → handleIncoming)
  onInbound(handler: (msg: IncomingMessage) => void): void;
  // 出站:消费"会话事件流",而非一次性 sendReply
  deliver(event: SessionEvent, sub: Subscription): Promise<void>;
}
```

> 现在的 `MessageTransport.sendReply(target, text)` = `deliver` 的退化版（只支持“最终文本”这一种事件、只发一个人）。

### 4.2 SessionEvent（把 `AcpClient.sessionUpdate` 已有的更新变成可广播事件）

```ts
type SessionEvent =
  | { type: "chunk";   sessionId: string; text: string }                 // agent_message_chunk
  | { type: "thought"; sessionId: string; text: string }                 // agent_thought_chunk
  | { type: "tool";    sessionId: string; toolCallId: string; title: string; status: string }
  | { type: "plan";    sessionId: string; entries: PlanEntry[] }
  | { type: "turnEnd"; sessionId: string; stopReason?: string }
  | { type: "summary"; sessionId: string; text: string };                // 给 WeChat 的凝练摘要
```

这些事件 `AcpClient` **现在已经实时收到**（`src/acp/client.ts:39-78`），只是被 buffer 掉。**改造点：每收到一个就 `emit` 给 Gateway，而不是攒到最后**——这是“实时”的核心一刀。

### 4.3 Subscription / 订阅表

```ts
interface Subscription {
  channel: Channel;
  sessionId: string;
  clientId: string;         // 同一 channel 可有多个连接(多个网页标签)
  lastSeq?: number;         // 已收到的最后事件序号,供补帧
  filter?: (e: SessionEvent) => boolean;  // WeChat 只要 summary/turnEnd
}
```

### 4.4 Gateway core

```ts
class Gateway {
  private channels: Channel[] = [];
  private subs = new Map<string /*sessionId*/, Subscription[]>();
  private log = new Map<string /*sessionId*/, SessionEvent[]>();  // 每会话事件日志(补帧/重连)
  private seq = new Map<string, number>();

  register(ch: Channel) {
    ch.onInbound((m) => this.handleInbound(m));
    this.channels.push(ch);
  }

  // 用户消息 → 交给 manager/AcpSession 跑(沿用现有编排)
  private async handleInbound(m: IncomingMessage) { /* → WorkspaceManager.handlePrompt */ }

  // agent 事件 → 编号、落日志、广播给订阅者
  private onAgentEvent(e: SessionEvent) {
    const n = (this.seq.get(e.sessionId) ?? 0) + 1;
    this.seq.set(e.sessionId, n);
    (this.log.get(e.sessionId) ??= []).push(e);
    for (const sub of this.subs.get(e.sessionId) ?? []) {
      if (sub.filter && !sub.filter(e)) continue;
      void sub.channel.deliver(e, sub);
    }
  }

  // 晚加入/重连:从 lastSeq 之后补发
  subscribe(sub: Subscription) {
    (this.subs.get(sub.sessionId) ??= []).push(sub);
    const backlog = (this.log.get(sub.sessionId) ?? []).slice(sub.lastSeq ?? 0);
    for (const e of backlog) void sub.channel.deliver(e, sub);
  }
}
```

## 5. 同一事件流，不同通道不同消费

“网页为主、WeChat 为辅”的落地方式 = **广播同一份事件流，各 channel 自己决定如何呈现**：

| Channel | 订阅 | 呈现 |
|---|---|---|
| **Web** | 全部事件 | 实时渲染流式 markdown / tool / plan / diff，可发 prompt、可取消 |
| **WeChat** | 仅 `summary` + `turnEnd`（`filter`） | 发「摘要 + 深链」，不刷屏 |
| **Terminal** | `chunk` | 直接打印流式输出 |

## 6. Web channel 的最小 WS 协议（草案）

自定义、轻量，不背 AHP 全套（channel/reducer/serverSeq）。

**客户端 → 服务端**
```jsonc
{ "t": "hello",     "clientId": "web-x", "sessionId": "...", "lastSeq": 12 }  // 连接/重连
{ "t": "prompt",    "sessionId": "...", "text": "..." }                       // 发消息
{ "t": "cancel",    "sessionId": "..." }                                      // 取消当前轮
{ "t": "subscribe", "sessionId": "..." }
```

**服务端 → 客户端**（即 `SessionEvent` 加 `seq`）
```jsonc
{ "t": "event", "seq": 13, "event": { "type": "chunk", "text": "..." } }
{ "t": "backlog-done", "seq": 13 }   // 补帧结束
```

重连语义：客户端带 `lastSeq` → 服务端从日志 `slice(lastSeq)` 补发；日志超限则发一份当前快照（迷你版 AHP `reconnect` 重放）。

## 7. 对现有代码的改造点

| 现有 | 改成 |
|---|---|
| `bin` 二选一注入 transport（`wechat-acp-manager.ts:45-75`） | 注册多个 channel 到 `Gateway` |
| `MessageTransport.sendReply(整段)`（`types.ts:13-16`） | `Channel.deliver(event, sub)`（流式、可多端） |
| `AcpClient` buffer + flush（`client.ts:39-96`） | `AcpClient` 实时 `emit(SessionEvent)` |
| `WorkspaceManager` 回发单人 | `Gateway` 维护订阅表 + 事件日志，按 session 广播 |
| 无 Web | 新增 Web channel（WS server + 静态网页），远程经 tunnel 暴露 |

> 注意：`AcpClient` 改成 emit 后，现有“攒成整段回复”的逻辑（如 WeChat 单条文本）可在 **WeChat channel** 内部用 `turnEnd` 时拼接/凝练实现，行为可向后兼容。

## 8. 与其它方案的归位

- **Gateway core = 之前说的 Session Hub**（自研最小版，不上完整 AHP）。
- **事件总线 + 订阅广播 = AHP 的一小片**（subscribe/broadcast/replay），自定 wire 格式，不背全套。
- **`publish-html` plugin = Web channel 未就绪前的轻量替代**：agent 主动渲染静态页发链接；Web channel 上线后退化为可选。
- **不依赖 Hermes**：只借“单进程 + 多 channel + 中间 core”这一架构骨架，不引入其内置工具/学习逻辑。

## 9. 分阶段

- **阶段 1**：`AcpClient` 改 emit；`Gateway` core（订阅表 + 事件日志）；保留 WeChat/Terminal 两个 channel（行为不变,验证广播）。
- **阶段 2**：新增 Web channel（WS + 网页实时渲染），本地起,自己用。
- **阶段 3**：tunnel 暴露 Web 给远程；WeChat 改为 `summary + 深链` 模式。
- **阶段 4**：重连补帧加固、取消/turn 归属、错误处理。

## 10. 待确认

1. 一条 session 是否允许 **多个 web client 同时写**（发 prompt）？还是单写多读？（建议先单写多读，turn 串行）
2. WeChat 的 `summary` 由谁生成——agent 产出，还是 gateway 对 `turnEnd` 做截断/LLM 凝练？
3. Web channel 鉴权（远程暴露后）：先用不可猜 token，后续再做登录。

## 11. 参考

- 现有入口/通道：`src/bin/wechat-acp-manager.ts`、`src/adapters/local.ts`、`src/wechat/transport.ts`
- 现有流式来源：`src/acp/client.ts:39-78`
- 现有编排：`src/manager/workspace-manager.ts`
- 终态标准化方向：`wechat-ahp-migration-design.md`
