# WeChat ACP MVP 设计草案

## 背景

目标是借鉴 `formulahendry/wechat-acp` 的核心思路，实现一个更小范围的 WeChat ACP 接入：通过一个微信 bot 入口，把私聊消息路由到本机运行的 ACP agent 子进程，例如 Copilot CLI 或 OpenCode。

当前阶段不追求完整复刻 `wechat-acp` 的所有能力，而是先建立一个可运行、可扩展、方便后续接入 memory 的最小闭环。

## MVP 目标

MVP 只关注这些能力：

1. 一个微信 bot 入口，处理一对一私聊消息。
2. 一个常驻 manager，负责启动、停止、切换 ACP agent 子进程。
3. 仅支持两个 agent preset：
   - `copilot`
   - `opencode`
4. 支持在不同工作目录下启动独立 ACP workspace instance。
5. 同一时间只允许一个 active ACP 子进程处理当前上下文。
6. 支持基础 memory/context 存储，为后续 MCP memory 接入留接口。
7. 支持基础 transcript 保存和 session summary。

## 非目标

这些功能暂时不做：

| 功能 | 暂不做原因 |
|---|---|
| 多 agent preset | 先只支持 Copilot 和 OpenCode，减少测试矩阵 |
| telemetry | 当前阶段不需要使用统计和 crash 上报 |
| 群聊 bot | 微信 bot 入口先只处理私聊，群聊路由、@ 触发和权限较复杂 |
| 多微信账号/多 bridge 实例 | 当前假设只有一个微信 bot 接入 |
| 复杂多用户权限 | 如果先面向个人使用，可以后置 |
| 完整 local inject/cron | 对 MVP 主链路不是必要功能 |
| command alias | 先固定命令，等命令稳定后再加别名 |
| 高并发 memory | 微信入口天然串行，先用轻量锁和 SQLite 即可 |
| 完整 Graph/Vector memory | 先保存 transcript、summary、长期事实；后续再替换或增强 |

## 推荐架构

```text
WeChat Bot
  -> WeChat Bridge
      -> Manager
          -> activeWorkspaceId
          -> Workspace Instance: copilot/opencode ACP subprocess
          -> Memory Service
              -> transcript store
              -> summary store
              -> long-term memory store
              -> optional MCP facade
```

核心思想：

- WeChat Bridge 只负责微信侧登录、收消息、发消息。
- Manager 负责 workspace instance 生命周期和消息路由。
- Workspace Instance 是一个 ACP agent 子进程，绑定一个 `cwd`。
- Memory Service 独立于 agent 子进程，多个 workspace 可以共享同一份 memory。
- 当前只有一个 active workspace，所以可以先避免复杂并发模型。

## Agent 支持范围

MVP 只内置两个 preset：

```json
{
  "copilot": {
    "command": "npx",
    "args": ["@github/copilot", "--acp", "--yolo", "--enable-all-github-mcp-tools"]
  },
  "opencode": {
    "command": "npx",
    "args": ["opencode-ai", "acp"]
  }
}
```

后续如果需要支持 Claude、Gemini、Codex、Qwen 等，可以把 preset registry 扩展出来，但 MVP 不建议提前引入。

## Workspace Instance 模型

一个 workspace instance 表示“在某个目录下运行的一个 ACP agent 子进程”。

示例：

```json
{
  "id": "repo-a",
  "agent": "copilot",
  "cwd": "D:/code/repo-a",
  "status": "running",
  "pid": 12345,
  "createdAt": "2026-06-16T05:00:00Z",
  "lastActiveAt": "2026-06-16T05:20:00Z"
}
```

建议存储布局：

```text
~/.wechat-acp-manager/
  config.json
  manager.db
  logs/
    manager.log
    workspaces/
      repo-a.log
      repo-b.log
  workspaces/
    repo-a/
      instance.json
    repo-b/
      instance.json
  inbox/
```

`instance.json` 只作为可读元数据和恢复线索；真实运行状态仍以 manager 内存状态和进程探活结果为准。

## 微信端命令设计

MVP 建议先保留少量命令：

| 命令 | 作用 |
|---|---|
| `/workspace open <id> <agent> <cwd> [--create]` | 在目录下启动 workspace instance；目录不存在时默认先确认，带 `--create` 则直接创建 |
| `/workspace confirm-create` | 确认创建上一次 `/workspace open` 请求中的缺失目录 |
| `/workspace cancel-create` | 取消待确认的目录创建 |
| `/workspace use <id>` | 切换 active workspace |
| `/workspace list` | 列出已知 workspace |
| `/workspace stop <id>` | 停止某个 workspace |
| `/workspace current` | 查看当前 active workspace |
| `/cancel` | 取消当前 in-flight ACP turn |
| `/memory search <query>` | 搜索当前可见 memory |
| `/memory search --all <query>` | 跨 workspace 搜索 memory |
| `/memory topics [--all]` | 查看固定 memory 主题索引 |
| `/memory remember <text>` | 显式写入长期 memory |

可以暂时不做 `/acp-config`，因为它依赖 agent 的 `configOptions`，不是 MVP 主链路。

Copilot session 退出时如果在 stderr 输出 `--resume <id>` 或 `resume <id>`，manager 会捕获并保存到 workspace 记录中。之后 `/workspace list` 会显示 `resume=<id>`，`/workspace current` 会显示可在 PC terminal 使用的 resume 命令，方便从 WeChat 启动的 session 回到本地 Copilot CLI 继续。

外部能力通过 `pluginmarket` 挂载：manager 默认扫描启动目录上级的 `pluginmarket/*/plugin.json`，也可以用 `WECHAT_ACP_PLUGIN_DIR` 指定插件目录。每个插件可以同时提供：

| 插件能力 | 作用 |
|---|---|
| stdio MCP server | 作为 ACP `mcpServers` 自动挂到每个新 session 上 |
| `SKILL.md` | 注入 prompt 的 `[Plugin Skills]`，告诉 agent 何时、如何组合 MCP tools |

Memory 现在以 `pluginmarket/memory-mcp` 形式作为 stdio MCP server 自动挂到每个 ACP session 上。Agent 可在需要历史资料时调用：

| MCP tool | 作用 |
|---|---|
| `memory_search` | 按 query 检索 user/global/workspace/session memory，可启用跨 workspace 检索 |
| `memory_get` | 按 id 读取某条 memory |
| `memory_topics` | 列出固定 memory 主题、计数和样例 id，帮助 agent 在检索前选择上下文 |
| `memory_remember` | 写入稳定事实、用户偏好或 workspace 约定 |

## 消息处理流程

普通微信消息流程：

```text
收到微信私聊消息
  -> 判断是否为 manager 命令
  -> 如果是命令：manager 自己处理，不转发给 agent
  -> 如果不是命令：
      -> 获取 active workspace
      -> 加入该用户 turn queue
      -> 从 memory service 生成固定主题索引
      -> 从 memory service 自动检索相关上下文（默认覆盖当前用户、global、当前 workspace，并可召回其他 workspace）
      -> 组装 prompt
      -> 发送给 active ACP session（包含插件 skills、主题索引、自动召回 memory 和 MCP 使用提示）
      -> agent 可先看 Plugin Skills / Memory Topic Index，再按需调用 MCP tools 深挖历史资料
      -> 收集 agent 输出
      -> 回复微信
      -> 保存 transcript
      -> 需要时更新 session summary / memory
```

建议保留 per-user turn queue，即使当前只有一个微信 bot。原因是用户可能连续发送多条消息，或者后续加入本地注入/定时任务。

## Memory 设计

MVP 不建议一开始接入复杂 memory 框架。建议先做自己的轻量 memory service，并把接口设计成后续可用 MCP 暴露。

### Memory 分层

| 层级 | 内容 | 生命周期 |
|---|---|---|
| transcript | 原始对话轮次 | 长期保存，可清理 |
| session summary | 当前 session 的摘要 | workspace/session 级 |
| long-term memory | 稳定事实、偏好、项目约定 | 长期保存 |
| workspace memory | 某个 cwd/project 的构建命令、结构、约定 | workspace 级 |
| global/user memory | 用户偏好、跨项目习惯 | 跨 workspace |

### SQLite 表建议

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE session_summaries (
  workspace_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_id TEXT,
  user_id TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  source_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Memory Scope

```text
global      所有 workspace 可见
user        当前微信用户偏好
workspace   当前项目/目录相关记忆
session     当前 workspace session 摘要
```

### 写入策略

不要把每一轮聊天都无脑写入长期 memory。

建议策略：

1. 每轮对话都写入 transcript。
2. 用户明确说“记住...”时写入 long-term memory。
3. agent 通过 MCP 工具显式调用 `memory.remember` 时写入。
4. manager 可异步总结 session，并更新 session summary。
5. 长期 memory 尽量保存稳定事实，例如偏好、项目约定、构建命令、已知坑。

### Prompt 注入策略

不要只依赖 agent 主动调用 memory MCP。更稳的方式是 manager 在每次 prompt 前主动拼接上下文：

```text
[Workspace]
id: repo-a
cwd: D:/code/repo-a
agent: copilot

[Session Summary]
...

[Relevant Memories]
- ...
- ...

[User Message]
...
```

后续可以同时把 memory service 暴露成 MCP server，让 Copilot/OpenCode 在需要时主动搜索或写入同一份 memory。

## MCP Memory 接入思路

MVP 可以先只定义接口，不必马上完整实现 MCP server。

推荐工具形态：

```text
memory.search(query, scope?)
memory.remember(content, scope, tags?)
memory.get_context(workspaceId, userId)
memory.forget(memoryId)
```

可参考项目：

| 项目 | 借鉴点 |
|---|---|
| `modelcontextprotocol/server-memory` | 最小知识图谱 memory server，适合参考 MCP tool 设计 |
| Basic Memory | 本地优先、Markdown + SQLite、MCP-native，适合 coding workspace memory |
| mem0 | 产品化长期记忆、用户/会话/agent 多层 memory |
| Graphiti | 时间感知知识图谱，适合未来处理事实变化和实体关系 |

当前建议：先自建 SQLite memory service；等基础链路稳定后，再评估是否替换成 Basic Memory、mem0 或 Graphiti。

## 可以裁剪的 wechat-acp 功能

基于当前目标，可以暂时忽略这些 `wechat-acp` 里的能力：

| wechat-acp 能力 | MVP 是否需要 |
|---|---|
| 11 个 agent preset | 不需要，只保留 Copilot/OpenCode |
| telemetry | 不需要 |
| `/acp-config` | 可后置 |
| `/acp-prompt-start` / `/acp-prompt-done` | 可后置，先处理单条文本消息 |
| `inject` 本地注入 | 可后置 |
| command aliases | 可后置 |
| 多 instance bridge | 不建议照搬；应改为一个 bridge 管多个 workspace |
| 完整文件 inbox | 可先只保存二进制文件路径，图片/语音可后置 |
| 群聊支持 | 不做 |
| 复杂 daemon/status/stop CLI | 可以后置；MVP 先保证 manager 常驻运行 |

## MVP 优先级

建议按以下顺序实现：

1. WeChat 登录、收私聊、发文本回复。
2. Manager 启动一个 Copilot ACP 子进程。
3. 普通微信消息转发到 Copilot，并把回复发回微信。
4. 支持 OpenCode preset。
5. 支持 `/workspace open/use/list/stop/current`。
6. 支持 transcript 持久化。
7. 支持 session summary。
8. 支持 `memory.search` 和 `memory.remember`。
9. 再考虑 MCP memory server。
10. 再考虑文件、图片、多消息合并、本地注入等增强能力。

## 风险点

| 风险 | 建议 |
|---|---|
| Agent 子进程异常退出 | manager 监听 exit，更新 workspace status，提示用户 |
| 用户连续发消息 | per-user turn queue 串行处理 |
| active workspace 未设置 | 回复用户先 `/workspace open` 或 `/workspace use` |
| cwd 不存在或无权限 | open workspace 时校验并拒绝 |
| Memory 污染 | 长期 memory 只写稳定事实，避免把临时对话全写进去 |
| 跨项目泄漏 | workspace memory 默认只对当前 workspace 可见 |
| 微信消息长度限制 | 回复需要分段发送，保持顺序 |

## 推荐的最小闭环

第一版可以只做到：

```text
启动 manager
  -> 微信扫码登录
  -> /workspace open repo-a copilot D:/code/repo-a
  -> 用户发送普通消息
  -> manager 注入基础 context
  -> Copilot ACP 回复
  -> 回复微信
  -> 保存 transcript
```

这个闭环跑通后，再加入：

```text
/workspace use repo-b
/memory remember ...
/memory search ...
session summary 自动回灌
```

这样可以避免一开始复制完整 `wechat-acp` 的复杂度，同时保留后续扩展到共享 memory、MCP server、多 workspace agent 的架构空间。
