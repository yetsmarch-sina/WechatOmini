# Hermes Agent — Harness Engineering 分析

> 状态：调研笔记（外部项目分析，用于借鉴）
> 对象：NousResearch [hermes-agent](https://github.com/NousResearch/hermes-agent) · 文档 <https://hermes-agent.nousresearch.com/docs/>
> 关联文档：[`wechat-gateway-design.md`](./wechat-gateway-design.md)、[`wechat-ahp-migration-design.md`](./wechat-ahp-migration-design.md)
> 说明：以下基于官方文档 + 部分 raw source 核对；未直接验证到源码的点已在「未证实」标注。

## 0. 一句话概括

Hermes 是个 **Python 3.11+ 的 agent harness**(uv 打包),核心是 `run_agent.py` 里的同步 **`AIAgent`** 类。它**自己就是 agent**(直接跑模型循环 + 工具调用),不是经 ACP 驱动外部 CLI——这是它和 WechatOmini 的根本区别。但它的 harness 工程(prompt 分层缓存、RPC 工具调用、上下文压缩、gateway 多平台、skills 按需注入)有大量可借鉴点。

## 1. Agent 主循环

- 核心:`run_agent.py` 的 `AIAgent.run_conversation()`,9 步 turn 生命周期。
- **不是经典 ReAct**:用标准 tool-calling 协议(assistant 消息里的 JSON `tool_calls`),循环直到没有 tool call 为止;不靠文本解析 Thought/Action。
- 历史统一 OpenAI 格式 dict,严格角色交替(不连续两条 assistant/user,只有 `tool` 可连续=并行工具结果)。
- **可中断 API 调用**:HTTP 跑在后台线程,主线程等 `threading.Event`;用户新消息/`/stop`/信号到来即丢弃响应,不把半截结果写进历史。
- **三种 API 模式**:`chat_completions`(默认 OpenAI 兼容)/ `codex_responses` / `anthropic_messages`;按 provider 自动选。
- 来源:`docs/developer-guide/agent-loop`、`/architecture`

## 2. 工具调用机制

- **import 期自注册**:每个 `tools/*.py` 顶层调 `registry.register(name, schema, handler, check_fn, requires_env)`。`tools/registry.py` 是依赖根,`discover_builtin_tools()` 启动时自动发现,无需手维护 import 列表。
- **schema = OpenAI JSON Schema**;handler 必须返回 JSON 字符串,错误以 `{"error": "..."}` 返回而非抛异常。
- **toolset 分组**(~28 个)+ 平台预设(`hermes-cli`/`hermes-telegram`/`hermes-acp`…)决定每个入口暴露哪些工具;`check_fn` 让缺 key 的工具静默从 schema 里排除。
- **agent 级拦截工具**:`todo`/`memory`/`session_search`/`delegate_task` 在进 registry 派发前由 `run_agent.py` 直接处理(改 per-session 状态)。

### ⭐ RPC 编程式工具调用(`execute_code`)——最值得抄的点
模型写一段 Python 脚本 `from hermes_tools import web_search, ...`,Hermes 生成 RPC stub,开 **Unix domain socket**,脚本在**子进程**跑,工具调用经 socket 回父进程派发,**只有脚本 `print()` 的内容返回给模型**——中间所有工具结果不进上下文。
- 把 N 步工具流水线压成**一次 LLM 推理**,中间结果零上下文开销。
- 子进程剥离含 `KEY/TOKEN/SECRET/...` 的环境变量;5 分钟超时、50KB stdout、50 次工具调用上限。
- **仅 Linux/macOS**(需 Unix socket),Windows 自动禁用退回顺序工具调用。
- 来源:`docs/.../code-execution`、`tools/code_execution_tool.py`

## 3. 上下文 / 记忆管理

### ⭐ 三层系统提示 + 严格缓存稳定性
| 层 | 内容 | 缓存 |
|---|---|---|
| stable | SOUL.md 身份、工具/模型指引、skills 索引、平台提示 | 是 |
| context | caller 的 system_message、项目上下文文件(.hermes.md/AGENTS.md/CLAUDE.md/.cursorrules) | 是 |
| volatile | MEMORY.md / USER.md 快照、外部记忆块、时间戳/session/model 行 | 是(会话开始冻结) |

关键洞见:**连"会话相关"的记忆也是以冻结快照进缓存的 system prompt**,中途写盘但不动已冻结的 prompt → 最大化前缀缓存命中。只有 API 调用时数据(预算警告、ephemeral 覆盖、`pre_llm_call` 插件上下文)绕过缓存。

### 记忆:有界、agent 自管
- `MEMORY.md`(2200 字符)/ `USER.md`(1375 字符),存 `~/.hermes/memories/`;`memory` 工具 add/replace/remove,满了报错让 agent **同轮整理**。
- 字符上限 → 有界高效;会话开始注入冻结快照。
- **"periodic nudges"** 其实是 system prompt 里的静态指引(提示主动用 `memory`/`session_search`),不是动态事件。
- 每轮后台 self-improvement review(可用更便宜的 `auxiliary.background_review` 模型)把经验沉淀进 memory/skills,可 `memory.write_approval` 门控。

### FTS5 跨会话检索
- 所有会话存 SQLite `~/.hermes/state.db`,FTS5 全文检索;`session_search` 返回带 `>>>match<<<` 标记的真实消息 + 前后 1 条上下文。
- schema v11 含 trigram 分词表(**CJK/子串检索**),靠 3 个触发器同步。

### ⭐ 双层压缩
- **层 1 Gateway 卫生(85% 阈值)**:`gateway/run.py`,处理消息前跑,粗略字符估算,兜底大会话。
- **层 2 Agent ContextCompressor(50% 阈值)**:`agent/context_compressor.py`(实现 `ContextEngine` ABC),有真实 token 数。4 阶段:① 清旧 tool 输出(>200 字符)② 定边界(护头 protect_first_n + 护尾 protect_last_n=20)③ 中段用 `auxiliary.compression` 模型按**结构化模板**(Goal/Constraints/Progress/Decisions/Files/Next Steps/Critical Context)总结 ④ 重组。**迭代再压缩时传入上一份摘要让 LLM 更新而非重写**。
- Anthropic 缓存:`system_and_3` 策略,4 个 `cache_control` 断点(system + 最近 3 条滚动窗),多轮省 ~75% input token。
- 来源:`docs/.../prompt-assembly`、`/context-compression-and-caching`、`/features/memory`

## 4. Skills 系统

- **Skills = Markdown 知识文档,不是代码插件**;**渐进披露**:system prompt 里只放紧凑索引(名+一行描述),`skill_view(name)` 才加载全文 → 常驻 token 极小。
- `SKILL.md` frontmatter:name/description/version/platforms + `metadata.hermes`(tags、`requires_toolsets/tools`、`fallback_for_toolsets/tools`、`config`、`blueprint`(=建议 cron)、`required_environment_variables`)。
- 存 `~/.hermes/skills/`;仓库带 ~90 个 bundled + ~60 optional;模板替换 `${HERMES_SKILL_DIR}`/`${HERMES_SESSION_ID}`。
- 三工具:`skills_list` / `skill_view` / `skill_manage`。
- **条件激活**:`requires_*` 缺依赖则隐藏;`fallback_for_*` 当主能力存在时隐藏(如 DuckDuckGo 兜底 skill 只在没有付费 web_search 时出现)。
- **自治创建/自改进**:后台 review 可自动建/`patch` skill,`skills.write_approval` 门控;`curator` 子系统管使用追踪/过期/归档。
- 兼容 agentskills.io;`hermes skills install owner/repo`,hub 安装过安全扫描。
- 来源:`docs/.../features/skills`、`/creating-skills`

## 5. 子代理 / 委派

- `delegate_task` 是 **agent 循环拦截工具**,spawn 全新 `AIAgent`。
- **完全上下文隔离**:子代理零知父历史,只有父显式填的 `goal`+`context`;**只有最终摘要回到父上下文**。
- 并行:`ThreadPoolExecutor(max_workers=delegation.max_concurrent_children)`(默认 3),按 task index 排序结果。
- 每子代理独立 terminal session、独立 `IterationBudget`(默认 50)。
- leaf 子代理禁用 `delegation/clarify/memory/code_execution/send_message`(防递归失控/副作用);`role="orchestrator"` 可建多层树(`max_spawn_depth` 默认 1)。
- **同步阻塞**:占父 turn 直到子完成;持久后台用 cron 或 `terminal(background=True)`。

## 6. 执行后端("terminal")

- 6 个后端在 `tools/environments/`:local/docker/ssh/modal/daytona/singularity;`tools/terminal_tool.py` 按 `terminal.backend` 调度。**未证实**:文档未给后端正式 ABC 接口签名。
- **Docker**:每进程一个**常驻容器**(`docker run -d ... sleep`,后续 `docker exec`),cwd/装包/env 跨工具调用持久;`container_persistent` 经 volume 跨重启;只读根 fs、丢全部 capability、PID 限 256。
- **Modal/Daytona**:serverless,空闲休眠几乎零成本、按需唤醒(README 的 hibernate/wake)。
- skill 声明的 `required_environment_variables` 自动透传给 `execute_code` 和 terminal 子进程(Docker/Modal 也是),但 Hermes 管的 key 名仍被剥离除非显式允许。

## 7. 模型抽象(provider 无关)

- **ProviderProfile 插件**:每 provider 一个 `plugins/model-providers/<name>/`,声明 `api_mode/base_url/env_vars/fallback_models`,load 时 `register_provider()`;resolver 不为新 provider 加分支,丢个目录即可。30+ provider 家族(含 Copilot、Anthropic、OpenRouter、Ollama、Bedrock…)。
- 解析优先级:显式请求 > `config.yaml`(`hermes model` 保存)> 环境变量 > provider 默认。**config 优先于 shell env**(防陈旧 `$OPENAI_API_KEY` 静默覆盖)。
- 主模型失败(429/5xx/401/403)→ `_try_activate_fallback()` 就地换 client/继续(一次性);子代理不继承 fallback。
- 辅助模型路由 `auxiliary.*`(vision/压缩/记忆 flush 可用更便宜模型)。
- 来源:`docs/developer-guide/provider-runtime`

## 8. Gateway / 消息架构(与 WechatOmini 最相关)

```
User ↔ 平台 ↔ Platform Adapter ↔ GatewayRunner ↔ AIAgent
```

- 单个长驻 `GatewayRunner`(`gateway/run.py`)同时管所有平台;adapter 把入站事件归一成 `MessageEvent`。
- **`BasePlatformAdapter` 接口**(`gateway/platforms/base.py`):必须实现 `connect()/disconnect()/send(chat_id, content, reply_to, metadata)`;可选 `send_typing()/get_chat_info()`;入站经 `self.handle_message(event)` → `GatewayRunner._handle_message()`。
- **session key**:`agent:main:{platform}:{chat_type}:{chat_id}`(用 `build_session_key()`,别手拼);各平台会话隔离,**默认不跨平台串号**;重启后按 key 从 `SessionStore`(SQLite)载历史喂新 `AIAgent`。
- **`ctx.register_platform()` 自动接通 20+ 集成点**(鉴权、cron 投递、工具路由、平台提示、消息分片、token lock…),新 adapter 作者只写 `connect/disconnect/send/handle_message`。
- **两级消息守卫**:agent 在跑时,新消息入队 + 触发 `interrupt()`;`/approve /deny /stop` 内联绕过避免竞态。
- 20+ adapter 分布在 `plugins/platforms/*`(telegram/discord/slack/feishu/wecom…)和 `gateway/platforms/`(signal/weixin/...)。
- 来源:`docs/developer-guide/gateway-internals`、`/adding-platform-adapters`

## 9. 调度(cron)

- 任务存 `~/.hermes/cron/jobs.json`;**gateway 常驻**每 60s tick(`.tick.lock` 防重叠)。
- 每个 due job 起**全新无历史 `AIAgent`**,可注入 attached skills 作上下文,跑完投递到目标平台。
- natural language → cron 表达式(`croniter`);cron 内**禁建 cron**(防失控)。
- **no-agent 模式**:跑脚本,stdout 原样投递,空=静默,非零退出=告警,零 token。
- `context_from` 串链(读上个 job 输出 prepend)、`[SILENT]` 抑制投递(只在异常时告警)。

## 10. 整体架构要点

- 入口统一:`AIAgent` 被 CLI / gateway / cron / **ACP adapter**(`acp_adapter/`,供 VS Code/Zed/JetBrains)/ batch 共用。
- 关键 ABC:`ContextEngine`(可插拔上下文)、`MemoryProvider`(单选外部记忆)、`BasePlatformAdapter`、`ProviderProfile`、Tool Registry。
- 插件发现三源:`~/.hermes/plugins/`、项目 `.hermes/plugins/`、pip entry points;类型:tools+hooks / memory(单选)/ context engine(单选)/ platform(多活)/ model-provider。
- **Profile 隔离**:`hermes -p <name>` 各自 `HERMES_HOME`/config/memory/sessions/PID,可并发;禁硬编码 `~/.hermes`,一律走 `get_hermes_home()`。
- SQLite `state.db`(WAL,schema v11),`sessions/messages/messages_fts/...`,压缩产生子会话经 `parent_session_id` 串血缘。

---

## 11. 对 WechatOmini 的可借鉴点(重点)

> 根本区别先记牢:**Hermes 自己是 agent;你是经 ACP 驱动 Copilot CLI 的瘦编排层。** 所以不要照搬它的模型循环/工具系统/执行后端,要借的是 harness 工程模式。

| Hermes 模式 | 对你的启发 | 优先级 |
|---|---|---|
| **`BasePlatformAdapter` + 单 `GatewayRunner`** | 正是你 `wechat-gateway-design.md` 里 Channel 接口的成熟参照;`connect/disconnect/send/handle_message` 四件套可直接对标你的 `Channel` | ★★★ |
| **session key = `{platform}:{chat_type}:{chat_id}`** | 你的多端订阅/会话路由可用同款 key 规则,天然支持多通道隔离 | ★★★ |
| **两级消息守卫 + `/stop` 内联绕过** | 解决"agent 在跑时用户又发消息"的并发,你 gateway 会遇到同样问题 | ★★ |
| **Skills = 渐进披露(索引常驻 + 按需 `skill_view`)** | 你的 plugin/SKILL.md 现在是整段注入(`workspace-manager.ts:553-560`);可改成"索引 + 按需加载",省 token | ★★★ |
| **`fallback_for_*`/`requires_*` 条件激活** | 你的 publish-html 这类 skill 可按"是否有 Web channel"条件出现 | ★ |
| **RPC `execute_code`(中间结果不进上下文)** | 概念可借:让 agent 用脚本批量调工具、只回结果摘要,省上下文(但你不控制 Copilot 内部循环,落地受限) | ★ |
| **cron `[SILENT]` + no-agent 模式** | 若将来加定时任务(日报/监控),这套投递语义很实用 | ★ |
| **结构化压缩摘要模板(Goal/Progress/Files/Next Steps)** | 你的 `setSessionSummary` 现在是裸截断(`workspace-manager.ts:468-472`),可换成结构化模板 | ★★ |

**最该先抄的三样**:① `BasePlatformAdapter` 形态(给你的 Channel 定型)② session key 路由规则 ③ Skills 渐进披露(索引+按需)。这三样都不依赖"自己是 agent",对你的 ACP 架构完全适用。

## 12. 未证实 / 需进一步核对

- `tools/environments/` 后端的正式接口签名(文档未公开)。
- `cron/jobs.json` 精确字段 schema、`delegate_tool.py` 精确实现、Honcho dialectic prompt 模板——均只有行为描述。
- `gateway/relay/` 中继 wire contract 在 repo 内 `docs/relay-connector-contract.md`,未在公开站。

## 13. 主要来源

- `docs/developer-guide/`:`agent-loop` / `architecture` / `prompt-assembly` / `context-compression-and-caching` / `provider-runtime` / `gateway-internals` / `adding-platform-adapters` / `adding-tools` / `creating-skills`
- `docs/user-guide/features/`:`code-execution` / `memory` / `memory-providers` / `skills` / `delegation` / `tools` / `cron` / `curator`
- raw source 核对:`pyproject.toml`、`toolsets.py`、`tools/registry.py`、`tools/code_execution_tool.py`
