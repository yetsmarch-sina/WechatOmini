# WeChat 富渲染 PoC 设计：`publish-html` plugin + ngrok

> 状态：设计草案（PoC 优先，先打通端到端）
> 目标读者：本仓库维护者
> 关联文档：[`wechat-acp-mvp-design.md`](./wechat-acp-mvp-design.md)、[`wechat-ahp-migration-design.md`](./wechat-ahp-migration-design.md)

## 1. 背景与目标

ACP 经现有链路回给 WeChat 的内容是**纯文本**（`src/wechat/types.ts` 只支持 `type:1` TEXT，`transport.ts` 按 3500 字切段），markdown / 代码 / diff / 表格在聊天气泡里**不渲染**，可读性差。

目标：**让复杂回复变成一个可滚动、语法高亮的 HTML 页面**，WeChat 只收「一句摘要 + 链接」，点开在内置浏览器看富渲染。

**本 PoC 范围**：用一个 `publish-html` plugin（MCP tool + SKILL.md）把内容渲染成静态 HTML，先用**本地静态目录 + ngrok** 暴露验证；对象存储为终态，留接口位。

非目标（本 PoC 不做）：对象存储正式接入、AHP 迁移、动态实时页、鉴权体系。

## 2. 端到端流程

```
用户在 WeChat 提问
        │
        ▼
WorkspaceManager → AcpSession.prompt()  （现有链路，不改）
        │
        ▼  agent 判断“内容复杂”，调用 MCP 工具
   publish_page(content, title?)         ← publish-html plugin 提供
        │  1) markdown/HTML → 渲染成完整 HTML（主题+代码高亮）
        │  2) 写入本地发布目录  <publishDir>/<randomId>.html
        │  3) 返回 { url: "<baseUrl>/<randomId>.html" }
        ▼
   agent 在文本回复里带上该 url
        │
        ▼  现有 AcpClient 收集 chunk → manager → WeChat
WeChat 收到「摘要 + https://xxx.ngrok.../<id>.html」
        │
        ▼ 用户点开 → ngrok → 本地静态服务 → 渲染页面
```

**关键设计点**：URL 通过 agent 的**普通文本回复**流回 WeChat，复用现有 chunk 通道（`src/acp/client.ts` → `WorkspaceManager` → `WeChatTransport`），**manager / transport 无需改动**。

## 3. 组件：`publish-html` plugin

照搬现有 plugin 形态（参考 `memory-mcp`：`plugin.json` 声明一个 stdio MCP server，env 由 `sessionPluginEnv` 注入；见 `src/manager/workspace-manager.ts:490-527`、`626-640`）。

```
pluginmarket/publish-html/
  ├─ plugin.json      # MCP server 声明
  ├─ server.(ts|js)   # 暴露 publish_page 工具
  ├─ render.ts        # markdown → HTML（主题 + highlight + diff）
  ├─ template.html    # 页面外壳（CSS/高亮样式内联）
  └─ SKILL.md         # 指引 agent 何时/如何调用
```

### 3.1 `plugin.json`

```json
{
  "name": "publish-html",
  "description": "Render a reply into a shareable static HTML page and return its URL.",
  "transport": "stdio",
  "command": "node",
  "args": ["server.js"],
  "skill": "SKILL.md",
  "env": [
    { "name": "PUBLISH_DIR",      "value": "${WECHAT_ACP_STORAGE_DIR}/published" },
    { "name": "PUBLISH_BASE_URL", "value": "http://127.0.0.1:8088" }
  ]
}
```

- `PUBLISH_DIR`：渲染产物落盘目录（PoC 走本地，复用注入的 `WECHAT_ACP_STORAGE_DIR`）。
- `PUBLISH_BASE_URL`：拼 URL 的前缀。PoC 启动 ngrok 后，把它换成 ngrok 的 HTTPS 域名（见 §6）。
- 终态：增加 `OSS_BUCKET` / `OSS_ENDPOINT` / 凭证等，env 注入方式不变（像 `WECHAT_ACP_MEMORY_DB` 一样在 `sessionPluginEnv` 加键）。

### 3.2 MCP 工具契约 `publish_page`

```
publish_page(input):
  input:
    content:  string          # markdown 或 HTML 片段（agent 产出）
    format?:  "markdown"|"html"   # 默认 markdown
    title?:   string          # 页面标题
  output:
    url:      string          # 可点击的页面地址
    id:       string          # 随机文件 id（便于日志/排查）
```

行为：
1. 生成不可猜的 `id`（如 16+ 字节 base62）。
2. `render(content, format, title)` → 完整 HTML 字符串。
3. 写 `PUBLISH_DIR/<id>.html`。
4. 返回 `{ url: `${PUBLISH_BASE_URL}/<id>.html`, id }`。

> **工具描述要自解释**：默认 `copilot-native` 模式下 **SKILL.md 不会注入到 prompt**（`loadPluginSkills` 仅在 `managed` 模式生效，`workspace-manager.ts:553`），agent 只能靠 MCP 工具的 `description` 知道何时用它。所以工具 description 必须写清“当回复较长 / 含代码 / diff / 表格时调用，并把返回的 url 附在简短回复里”。SKILL.md 是 `managed` 模式下的补充说明。

### 3.3 `SKILL.md`（managed 模式补充）

要点（伪内容）：
- 何时用：回复包含代码块、diff、表格、长列表、或超过约 N 行时。
- 怎么用：把完整富内容传给 `publish_page`，**给 WeChat 的回复只保留 2-3 句摘要 + 返回的 url**，不要把大段代码再贴进聊天。
- 短问答（一两句话）不要调用，直接文本回复。

### 3.4 渲染 `render.ts`

- markdown → HTML：用成熟库（如 `markdown-it`）。
- 代码高亮：`highlight.js` / `shiki`，样式内联进 `template.html`，避免外链被微信环境拦。
- diff：识别 ```diff 代码块做红绿着色。
- 移动端友好：`<meta viewport>`、合理字号、代码块横向滚动。
- 安全：对非可信 HTML 输入做 sanitize（防 XSS），PoC 阶段内容来自自家 agent，风险低但建议默认 escape。

## 4. 静态服务与暴露

### 4.1 本地静态服务
极简静态文件服务器，根目录 = `PUBLISH_DIR`，监听 `127.0.0.1:8088`。
- 可独立小脚本，或并进 manager 进程随启动拉起。
- 仅服务 `published/` 下文件，不暴露其它路径。

### 4.2 ngrok（PoC 期暴露）
```
ngrok http 8088
# 得到 https://<random>.ngrok-free.app  →  填回 PUBLISH_BASE_URL
```
- ngrok 自带 **HTTPS + 域名**，绕开“裸 IP + 证书”两个坑，适合验证渲染与打开。
- ⚠️ **已知限制**：ngrok 免费版首访有**风险警示中间页**，微信内置浏览器可能被它挡。因此：
  - ngrok 用来验证**“页面渲染对不对、能不能在手机上看”**；
  - **“微信是否拦链接 / 能否直接打开”这个关键结论，必须等终态对象存储真实域名再实测**，ngrok 结论不算数（见关联文档 AHP/部署讨论）。

## 5. 终态演进（PoC 之后）

| 维度 | PoC（本方案） | 终态 |
|---|---|---|
| 渲染产物 | 本地 `published/*.html` | 同样渲染，改为上传**对象存储** |
| 暴露方式 | ngrok | 对象存储自带 **HTTPS + 自定义域名 + CDN**，无中间页 |
| URL | ngrok 域名 + 文件名 | 对象存储**签名 URL**（带过期） |
| 访问控制 | 不可猜文件名 | 签名 URL / token + TTL |
| 改动点 | 仅 `publish_page` 的“存储+拼URL”那段 | 同一处替换为 OSS SDK，其余不变 |

`publish_page` 内部把“**渲染**”和“**发布(存储+URL)**”解耦，PoC→终态只换发布实现，工具契约和 agent 用法都不变。

## 6. PoC 落地步骤（实现时）

1. 写 `pluginmarket/publish-html/`（`plugin.json` + `server` + `render` + `template` + `SKILL.md`）。
2. 起本地静态服务（`127.0.0.1:8088` → `PUBLISH_DIR`）。
3. `ngrok http 8088`，把 HTTPS 域名填进 `PUBLISH_BASE_URL`。
4. 让 manager 以 `managed` 模式加载该 plugin（或 `copilot-native` 模式靠工具 description）。
5. 在 WeChat 发一个“写段带代码的回答”类请求，确认：
   - agent 调到了 `publish_page`；
   - WeChat 收到「摘要 + 链接」；
   - 手机点开能看到富渲染页面。
6. 记录 ngrok 中间页对微信打开的实际影响，作为是否尽快切对象存储的依据。

## 7. 风险 / 待确认

1. **ngrok 中间页**：可能挡住微信打开 → 终态结论以对象存储域名为准。
2. **agent 是否稳定调用**：skill 是非确定性的（`copilot-native` 模式无 SKILL.md 注入，更依赖工具 description）。若需“每条复杂回复都出页面”，后续可加 **transport 层后处理**兜底（manager 在 `sendReply` 前统一渲染上传）。
3. **ilink bot 链接行为**：需实测 ilink 客户端点链接是直接打开还是走拦截/二次确认（影响最终域名选型）。
4. **XSS / sanitize**：渲染外来内容默认 escape。
5. **对象存储选型**：终态倾向对象存储静态托管（自带 HTTPS、免运维、签名 URL）。

## 8. 参考

- 现有 plugin 加载机制：`src/manager/workspace-manager.ts:490-527`、`553-560`、`626-640`
- 现有文本回复链路：`src/acp/client.ts`、`src/wechat/transport.ts`、`src/wechat/api.ts`
- 关联设计：`wechat-ahp-migration-design.md`（Web UI 作为 AHP client 的终态形态）
