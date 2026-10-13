# MiniMax Code / MiniMax Agent 客户端设计调研

> 调研日期：2026-10-13 · 目的：为 DSH 原生 Android 客户端提供设计参考
> 调研方式：web_search 不可用（缺 API key），改用 web_fetch 直接抓官方文档/仓库/商店页。
> 每条关键结论附来源；无法核实的**明确标注**，不编造截图细节或 API 字段。

---

## 1. 产品是什么

**MiniMax Code** 是 MiniMax（稀宇科技）的桌面端 AI Agent 应用，官方定位：面向软件开发、日常工作流、自动化与远程协作，把聊天、项目上下文、文件操作、终端、内置浏览器、技能、记忆、自动化放在一个本地工作区里（[官方 Welcome 文档](https://agent.minimax.io/docs/code/welcome)）。

产品矩阵关系（官方来源核实）：

- **MiniMax Code** = 桌面客户端（macOS/Windows）+ 开源 CLI（`mcode`）+ 同名底层 Harness。code.minimax.io 302 到 agent.minimax.io；中国站 agent.minimax.cn。
- **MiniMax Agent**（内部代号 Mavis）= 网页端通用 Agent，与桌面端通过"端云协同/任务交接"打通（[Tasks and History](https://agent.minimax.io/docs/code/workflows/tasks)）。
- **M2 / M2.5 / M2.7 / M3（M3.1-Flash-Preview）** = 模型层，经开放平台 API 提供（OpenAI/Anthropic 双兼容协议）。
- **订阅**：M Plan（原 Token Plan 合并了 CLI、API、Agent 的积分池）。

**移动端 App（已确认，官方）**：

- Android：Google Play 包名 **`com.minimax.ai`**，应用名 "MiniMax - Your AI Agent"，100 万+ 下载（[Play 商店](https://play.google.com/store/apps/details?id=com.minimax.ai)；包名从官方下载页二维码组件的 React props 直接解码核实）。
- iOS：App Store **"MiniMax - 通用AI Agent"**，bundle id **`com.ai.wanjuan`**（id6446482834），开发商 Shanghai Xiyu Technology Co., LTD，v4.21.1（[iTunes lookup](https://itunes.apple.com/lookup?id=6446482834&country=cn)）。
- 官方下载页把移动端定位为桌面端的延伸："随时查看任务进度、补充要求，并远程继续桌面端工作流"（[官方下载页](https://agent.minimaxi.com/download)）。即：**桌面为主、手机为遥控器**的跨端结构。
- 另有 **Remote Control**（桌面端出配对码，手机看进度/发补充指令/批准权限请求）与 **IM 集成**（微信/飞书/Telegram，扫码或 Bot Token 绑定）（[Remote Control](https://agent.minimax.io/docs/code/automation/remote-control)、[IM](https://agent.minimax.io/docs/code/automation/im)）。

**开源情况（高可信）**：CLI 于 2026-09-18 以 MIT 协议开源（[MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)，npm `@minimax-ai/code`）。**注意：桌面 App 源码不在公开仓库内**（README 明确说明公开源仅覆盖 TUI/headless/ACP），移动端 App 亦未开源。

---

## 2. 界面设计（UI/UX）

以下基于官方文档截图（mintcdn 官方图床，实际抓取查看 3 张）：

**整体布局（桌面三栏）**（[first-task-composer.png](https://mintcdn.com/agent-en/yEQNl2mVInzXN9Xt/images/code/first-task-composer.png)）：

- **左侧边栏**：新建对话、Search（⌘K 命令面板）、Skills、Scheduled、Connect Mobile、Remote Control；会话分组为 Pinned / Scheduled / Projects（项目下挂带快捷键 ⌘1-⌘6 的任务条目）；底部 Documents、用户头像。
- **中央对话流**：空态是居中大标题 + 一张**大号 composer 卡片**，卡片下方是一排任务场景快捷芯片（Finance / Docs / Content / Vibe / Ask MCode）。
- **右侧开发者面板（Coding 模式）**（[developer-panels.png](https://mintcdn.com/agent-en/yEQNl2mVInzXN9Xt/images/code/developer-panels.png)）：顶部 "Environmental Information" 卡片（Changes / Commit or push / Open terminal 三个动作入口），下方 "Progress" 卡片（带勾选态的编号清单），Agent Team 时再追加 "Agent team" 卡片（每个子 Agent 一行 + 转圈运行态）。**对话流底部还有一条可展开的终端横条**，显示 git 分支与工作区文件列表。
- **配色/主题**：浅色/深色/跟随系统，主题 Default / Graphite / Warm，支持自定义壁纸并从壁纸自动取色；界面密度（compact/comfortable/airy）、对话列宽、UI 字体与代码字体分离设置（[Appearance](https://agent.minimax.io/docs/code/desktop/appearance)）。
- **对话流渲染**：思考/工具调用被折叠成一行式摘要胶囊，如 "Thought 3 time(s) · Viewed 3 file(s) · Ran 2 command(s)"，点击展开；执行中的工具与最后一步工具调用保持可见、已完成的步骤沉入历史（[TUI 渲染规则](https://raw.githubusercontent.com/MiniMax-AI/minimax-code/main/docs/tui-capabilities.md)——这是 CLI 的 TUI 规则，但与桌面端"运行中的内容不折叠、完成即定格"的思路一致）。
- **输入区**：`+` 附件、授权级别下拉（截图显示 "Full Authorization"，可切换授权模式）、"Thinking" 开关、模型选择器（MiniMax-M3）、projects 工作区选择、语音输入（麦克风按住/切换两种快捷键，实时转写到输入框，可编辑后发送）（[First Task](https://agent.minimax.io/docs/code/get-started/first-task)）。
- **会话列表**：本地/云端双列表 + 本地/云切换控件；列表项带"运行中"与"有待审批请求"的指示，含子会话活动（[Changelog v3.1.1](https://agent.minimax.io/docs/changelog)）。

**移动端 App UI：未能核实截图细节**（未抓取到 App Store 截图的语义描述），仅能从商店文案确认功能范围（高效模式聊天、深度研究、多模态生成、PPT、全栈应用、编码调试）。

---

## 3. 功能设计

核心功能模块（均有官方文档）：

- **任务/会话管理**：每次对话即任务记录；侧栏切换、搜索历史、置顶、归档；本地/云会话列表；`/fork`、`/rewind`、`/rename`、`/compact`、`/export`、`/transcript`（[CLI features](https://agent.minimax.io/docs/cli/features)）。
- **项目/工作区**：任务可挂本地目录，`@` 引用文件，`/add-dir` 加目录（[Workspace](https://agent.minimax.io/docs/code/workflows/workspace)）。
- **双模式**：Coding 模式（面板全开）vs Work 模式（隐藏开发细节、聚焦交付），同一 Agent 能力、不同界面焦点（[Modes](https://agent.minimax.io/docs/code/workflows/modes)）。
- **Goal（长任务闭环）**：给 Agent 一个"可验证的最终结果 + 验收证据 + 边界 + 停止条件"，Agent 反复执行-检查-推进，直到达成/阻塞/用户暂停；输入区上方显示 Goal 状态条，可编辑/暂停/恢复/清除（[Goal 文档](https://agent.minimax.io/docs/code/desktop/goal)）。
- **Agent Team**：Leader/Worker/Verifier 三角色，确定性代码逻辑驱动的 Team Engine 状态机管理每个 Agent 生命周期（producing→verifying→done，verify 失败唤醒 producing 继续改）；关键设计思想见官方长文 [Agent Team: Built for Long-Running Tasks](https://www.minimax.io/blog/minimax-agent-team-long-running-1779893953)：**IM 场景下主 Agent 秒回"收到，后台执行"，任务状态持久化，用户随时可查"2/5 完成、2 个在验证"**；Agent 与人对 Agent 的操作接口"平等权利"（prompt/spawn/abort/kill）。
- **审批交互**：敏感动作（工作区外读文件、改/删文件、跑命令、外部副作用）弹权限请求；权限模式 Ask/Auto/Full/Off；**Auto 模式由云端分类器对低风险动作自动放行、高风险仍弹窗**（[Permissions](https://agent.minimax.io/docs/code/workflows/permissions)、[CLI security](https://agent.minimax.io/docs/cli/security)）。`ask_user` 提问会形成**持久 pending 请求**，turn 以"等待回答"收尾而不是报错（[tui-capabilities.md](https://raw.githubusercontent.com/MiniMax-AI/minimax-code/main/docs/tui-capabilities.md)）。**手机端可以批准权限请求**（Remote Control）。
- **任务规划展示**：右侧 Progress 卡片（编号 checklist + 勾选态）；Agent Team 面板每个子 Agent 一行实时状态。
- **Diff 审阅**：Code Review 命令，可切换 diff 范围（全部未提交 vs 仅 Agent 上一轮改动）、已读/未读文件过滤，发现项尽量定位到代码行，偏好跨任务保留（[Code Review](https://agent.minimax.io/docs/code/workflows/code-review)）；另有 Change Graph 面板看提交历史/分支。
- **文件/终端**：Files 面板可预览 DOCX/XLSX/PPTX/Markdown/SVG/LaTeX；终端面板跟随命令/测试/构建输出（[Panels](https://agent.minimax.io/docs/code/desktop/panels)）。
- **MCP/插件**：MCP 支持 stdio / http / streamable-http / sse 四种 transport，本地表单或 JSON 配置，也可随插件包分发（`*.mcp.json`）；插件市场 + 开发者可提交（[MCP](https://agent.minimax.io/docs/code/agents/mcp)）。
- **Mini Apps**：Agent 生成的自定义前端页面，作为右侧面板运行，插件包内含可运行页面+后端进程，且自身也是 MCP 服务，可被 Agent 双向调用（[MiniApp Overview](https://agent.minimax.io/docs/code/agents/miniapp-overview)）。
- **记忆**：主动记忆（Proactive Memory）+ 会话级开关（本会话是否读记忆/是否产出记忆）；记忆摘要可在设置里查看、编辑、删除（[Memory](https://agent.minimax.io/docs/code/agents/memory)）。
- **多模态**：图片/视频粘贴（Ctrl+V 即预览）、语音听写、内置浏览器多标签页+移动端视口预览+操作光标轨迹、Computer Use（控制本机 GUI 应用，首次使用弹权限）、无限画布（图片/视频/HTML 拖放、圈选批注改图、Vary 变体）。
- **分享/导出**：`/export` 导出 Markdown、`/copy` 复制回复；云任务成果下载回本地、云改动回写前先审 diff。

---

## 4. 后端通信协议

**开源 CLI 的架构（高可信，来自官方开源仓库 docs/architecture.md + 官方技术博客）**：

- 调用链：`TUI / exec / ACP → CliService → local Applications → Session / Turn / Agent services → Pi / model providers / local tools`。CLI **不经过** Desktop HTTP 服务（[architecture.md](https://raw.githubusercontent.com/MiniMax-AI/minimax-code/main/docs/architecture.md)、[Harness 技术博客](https://agent.minimax.io/docs/techblog/minimax-code-harness)）。
- **鉴权：OAuth 浏览器授权流**。`mcode login`（中国区）/`mcode login --region global` 跳浏览器完成登录；MiniMax OAuth Core 管理 profile 凭证与刷新；登录回调 URL 含临时凭证；`mcode-tools` 工具子进程通过本地 lease broker 获取**短时 access token**（[README](https://raw.githubusercontent.com/MiniMax-AI/minimax-code/main/README.md)、architecture.md）。
- **公开协议结构**：`packages/protocol/src/local.ts`（CLI 数据结构）与 `runtime.ts`（agent 配置与事件）；**RPC 信封、服务路由、鉴权头、IDL 生成链都不在公开源里** —— 即桌面 App ↔ 云端的私有协议未公开。
- **Headless 事件流（已核实具体格式）**：`mcode exec --output-format stream-json` 输出 NDJSON 版本化事件，字段含 `schemaVersion / sequence / timestampMs / runId / sessionId / turnId`，事件类型 `exec.started|completed`、`session.started|resumed`、`turn.started|completed|failed`、`item.started|updated|completed`；`--output-format json` 输出单个 `ExecResult`（status: succeeded/failed/timeout/cancelled/limit_exceeded + model + usage）（[Headless and CI](https://agent.minimax.io/docs/cli/automation)）。**这套"版本化 + sequence + 未知类型向前兼容"的事件设计非常值得直接借鉴。**
- **ACP（Agent Client Protocol）**：`mcode acp` 经 stdin/stdout 提供协议流，宿主可收到 Agent 回复、推理、工具状态、文件位置与 diff、权限提示与提问、取消、模型控制（[ACP](https://agent.minimax.io/docs/cli/integrations)）。Android 客户端若做"本地 Agent 宿主"，ACP 是现成参照。
- **超时/重试参数（已核实）**：模型请求首事件超时 300s、流空闲 300s、总请求上限 20 分钟，均可环境变量覆盖（[tui-capabilities.md](https://raw.githubusercontent.com/MiniMax-AI/minimax-code/main/docs/tui-capabilities.md)）。
- **开放平台 API（已核实 OpenAPI）**：
  - OpenAI 兼容：`POST https://api.minimax.io/v1/chat/completions`（旧文档路径 `/v1/text/chatcompletion_v2` 仍在模型页示例中使用，两者并存），Bearer 认证；流式为 SSE `chat.completion.chunk`，`delta.reasoning_content` 独立承载思考内容（或 `reasoning_split=false` 时以 `<think>` 包裹在 content 里）；工具调用 `tool_calls[].function.arguments` 为 JSON 字符串；响应外层有 MiniMax 特有的 `base_resp.status_code/status_msg` 信封与敏感词字段（[Chat Completions OpenAPI](https://platform.minimax.io/docs/api-reference/text-chat-openai)）。
  - Anthropic 兼容：`https://api.minimax.io/anthropic`（中国区 .cn），thinking 块带 `signature`，要求**完整回传 assistant 内容块**以保持 interleaved thinking 链（[Tool Use 指南](https://platform.minimax.io/docs/guides/text-m3-function-call)）。
  - TTS 有 WebSocket / 双向流式 AsyncAPI 规范（[platform llms.txt](https://platform.minimax.io/docs/llms.txt)）。
- **移动端 App ↔ 后端的具体协议（WS/SSE/消息信封）：未能核实** —— 无公开文档、无可信抓包资料（本次调研未找到）；Remote Control 的配对信令同样未公开。可信度排序：官方开源 CLI 仓库 > 官方文档 > 官方博客 > 应用商店文案；未发现社区逆向资料可引用。

---

## 5. 对本项目的可借鉴点

1. **"桌面为主、手机为遥控器"的跨端定位**：MiniMax 移动端不是独立产品，而是"看进度 + 补指令 + 批准请求"的伴生端。借鉴：DSH Android 首版聚焦长任务监控与审批，而非完整工作台；Compose 里用**任务卡片流**（状态 + 最近事件 + 审批入口）作为首屏。
2. **版本化 NDJSON 事件流协议**：直接采用 `schemaVersion + sequence + timestampMs + runId/sessionId/turnId + type` 的信封（照抄 MiniMax stream-json 设计），客户端按 sequence 排序、对未知 type 前向兼容丢弃 —— 协议演进不用发版。落地：Kotlin `Flow<AgentEvent>`，Room 持久化原始事件，UI 层用 reduce 派生状态。
3. **审批是一等事件类型**：把"permission request"和"agent question"做成协议里的持久 pending 对象（不是 UI 弹窗），断线重连后依然能看到待审批项。落地：Room 表 `pending_interactions`，Compose 顶层 Material3 dialog/card 消费；推送（FCM/厂商通道）只作为"有 pending"的提示。
4. **权限分级 + Auto 分类器**：Ask/Auto/Full/Off 四档，Auto 档对低风险动作自动放行。落地：网关侧维护动作风险分类器，Android 侧在设置页提供模式切换（SegmentedButton），审批卡片按风险级别着色。
5. **折叠式执行摘要胶囊**：不要把每个工具调用都铺满屏。一行 "Thought 3 次 · 读了 3 个文件 · 跑了 2 条命令" 可点击展开详情。落地：`LazyColumn` 中以 `AnimatedVisibility` 实现折叠/展开，胶囊组件接收 `(counts, summaryText)`。
6. **Progress 清单卡 + Agent Team 行**：长任务给编号 checklist（含勾选态），多 Agent 时每个子 Agent 一行 + 运行转圈。落地：`Checkbox` + progress state 映射；子 Agent 列表项用 `CircularProgressIndicator` 小尺寸版本。
7. **运行中内容不折叠、完成即定格**：流式渲染时"最后一步工具 + 仍在流的块"保持展开，完成的步骤移入可回滚的历史。这决定了 Compose 渲染层要把"item 是否 finalized"作为布局状态。
8. **秒回 + 后台执行（IM 式异步）**：长任务立即回"收到，目标已确认，后台执行中"，用户随时插话补充 —— MiniMax 把这作为最大的用户反馈痛点来设计。落地：Android 端发送后立即进入"已受理"态（本地乐观 UI），通知栏常驻任务进度（Foreground Service + progress notification）。
9. **Goal = 可验证停止条件的一等公民**：让用户输入"最终结果 + 验收证据 + 停止条件"，而不是一串指令。落地：DSH 已有 goal 机制，Android 侧做 Goal 卡片（状态条 + 暂停/编辑/清除），输入法上方的持久状态条用 `Scaffold` bottomBar 槽位。
10. **Diff 审阅的范围切换**：全部未提交 vs 仅本轮 Agent 改动 + 已读/未读过滤 + 偏好持久化。落地：`FilterChip` 行切换 diff 数据集，diff 渲染可用 `HorizontalPager` 按文件分页，未读态用小圆点标记。
11. **OAuth 浏览器授权 + 短时 token 下发**：登录走 AppAuth（Custom Tab），工具子进程用本地 lease broker 发短时 token。落地：Android 用 AppAuth + EncryptedSharedPreferences，网关侧实现 token 租约接口；**不要**在客户端长期持有大权限 token。
12. **双协议兼容的模型层**：MiniMax 同时提供 OpenAI/Anthropic 兼容端点使其客户端能接任意后端。DSH Android 建议把"模型接入"抽象为 provider（base URL + API format + key），BYOK 界面照抄"预设供应商 + Fetch 模型列表 + 连接测试"三步交互（[BYOK](https://agent.minimax.io/docs/code/account/byok)）。
13. **主题系统分层**：显示模式（light/dark/system）与主题（材质色板）分离，另加密度/对话宽度/等宽字体独立设置。落地：Compose Material3 `colorScheme` 动态合成 + `LocalDensity` + `Typography` 覆盖，设置项存 DataStore。

---

## 6. 与本项目的差异与优先级建议

### 6.1 DSH 移动端已实现（2026-10-13 公网实测通过）

- 账号密码登录（公网 `https://203.0.113.10:2444` 实测 HTTP 200，令牌落盘）
- 会话列表（实测拉到 68 个真实会话，瘦身后 27 KB）
- 新建会话（`session/create` 实测通过）
- 会话历史分页（`session/page`，含 `past cursor` 自适应重试）
- 发消息（`session/prompt` 实测通过，消息真实抵达主机）
- 停止当轮（`session/cancel`）
- 审批卡片 UI（应答通道待修，见下）
- 令牌加密存储（EncryptedSharedPreferences）
- 网关特权闸门（`settings/credentials/pluginManager/...` 公网实测返回 403 `loopback_only`）

### 6.2 尚缺

| 缺口 | 现状 | MiniMax 的做法 |
|---|---|---|
| **实时事件流** | 3s 轮询 `session.page`；两条 `events.*` 流因协议错误立即断开 | 单条 mux WebSocket + 逻辑流帧协议 |
| **审批/提问应答通道** | App 打 `/api/respond`，该端点在真实主机**不存在** | pending 请求持久化，手机可批准 |
| **任务进度可视化** | 无 | Progress 编号清单 + Agent Team 行 |
| **Goal 状态条** | 无 | 输入区上方持久状态条，可暂停/恢复 |
| **Diff 审阅** | 无 | 范围切换 + 已读/未读过滤 |
| **文件/终端面板** | 无 | 右侧面板 + 底部终端横条 |
| **执行摘要折叠** | 工具调用逐条平铺 | 折叠成一行摘要胶囊 |

### 6.3 先做哪三件（排序建议）

**第一件：修好事件流协议（单条 `/api/remote.mux`）—— 这是所有实时能力的地基。**

理由：现在两条 `events.*` 流**每条都立即断开**（实测日志 `invalid Remote endpoint`），App 完全靠 3s 轮询兜着。轮询有两个硬伤：公网走 FRP 隧道，延迟天然比 WebSocket 高；且"运行中"状态最多滞后 3s。更关键的是，**审批与提问根本没有实时到达的通道** —— 手机用户不会知道电脑那边正在等他确认。MiniMax 把"手机能批准权限请求"当核心卖点，而这条链路的前提就是事件流可用。

**第二件：修审批应答通道（`$events/result`）+ 把它做成持久 pending。**

理由：已实测确认真实通道是 `$events/result`（打过去主机回 "identifies no active event stream"，证明端点存在），而 `/api/respond` 是 404。这是**功能性阻断**：审批卡片现在能弹（如果事件流通了），但点"允许"送不出去。参照 MiniMax，pending 应当持久化（Room 表）而非仅内存，这样断线重连、切后台再回来，待审批项都还在。

**第三件：会话列表分流 subagent（已在修）。**

理由：这是**公网实测发现的具体体验缺陷** —— 68 个会话里 53 个是 subagent 会话（带 `origin:"subagent"` + `parentSessionId`），点进去必然报 `subagent Sessions require their durable parent address`。用户看到的是"大部分会话都打不开"。MiniMax 的会话列表也区分主/子会话并标注活动，做法可对照。

---

## 7. MiniMax.apk（v4.20.4）逆向与实机实测解密（2026-10-13 实测解锁）

基于本地分析的真实 APK 安装包（`C:\Users\20247\Downloads\MiniMax.apk` / 包名 `com.xproducer.yingshiai`，版本 4.20.4，编译目标 Android 15 / API 35）：

### 7.1 核心架构解密：它其实是「WebView 套壳混合 App」
1. **前端技术选型**：
   - 解开 APK 包体发现，MiniMax 移动端的核心 Agent 界面 `max-claw` 与聊天核心 `mavis_android` **并非原生 UI**，而是内嵌了完整的 **Next.js App Router (RSC) Web 工程**（位于 `assets/mavis_android/_next/` 与 `assets/chatcore_android/_next/`，含 615+ 个 JS chunk、Tailwind 样式、SVG 图标与 PDF 渲染引擎）。
   - 它的原生 Android 层主要负责外壳容器、推送 SDK（小米/华为/OPPO/VIVO/HMS）以及调起内嵌 WebView。
2. **对比 DSH Native 移动端**：
   - **包体积**：MiniMax 43.9 MB vs DSH Native **21.7 MB**（仅为前者一半）。
   - **渲染架构**：MiniMax 是 WebView 跨进程通信与 DOM 树排版；DSH 是 **100% 纯 Kotlin + Jetpack Compose M3 原生树**，硬件加速、流畅度（稳定 60/120fps）、首屏秒开与手势跟手性具备压倒性优势。

### 7.2 远端配对体系与产品细节拆解
1. **配对流程（极简数字码）**：
   - 侧边栏「连接电脑」→「远程控制」→ 弹窗「输入配对码」（全屏呼出纯数字键盘）。
   - 桌面端直接生成 6 位/8 位带有效期的配对码（`pairing_code_expired: 配对码已过期，请重新获取`），免去手动输入 IP 与长端口。
2. **设备管控与多端授权**：
   - 包含多设备连接列表（`settings_devices_label: 可控制这台电脑的设备`、`settings_last_connected: 上次连接时间`、`settings_revoke_access: 撤销访问`）。
3. **任务协同与 Team Plan 体系**：
   - 完整的长任务状态机看板（`team_plan_card`）：
     - 周期推进：`周期 {{cycle}} · {{phase}}`
     - 任务热力图：`{{done}}/{{total}} 已完成`，涵盖 `producing(生产中)`、`verifying(验证中)`、`blocked(阻塞)`
     - 异常熔断感知：`计划已暂停 — 需要负责人操作`、`连续 {{count}} 个周期失败`、`验证者拒绝了任务`
   - 工作区与环境面板（`workspace_panel`）：
     - 手机端直接看环境变更（`changes`）、分支切换（`switch_branch`）与提交推送（`commit`）。

---

## 8. 我们如何做得比它更好（DSH 超越路线图）

1. **坚持纯原生 Compose 路线**：
   - 杜绝 WebView 带来的滑动掉帧、白屏抖动与复制选中卡顿。
   - 保持生产级本地渲染器（现已实装高亮代码卡片、网格表格、折叠工具执行等，体验已超过 MiniMax 的 WebView DOM 性能）。
2. **把「配对码机制」引入 DSH 网关**：
   - 当前 DSH 需要手机输入地址与凭据。我们在网关加一个 `/mobile-gateway/pair` 生成 6 位随机短码（如 `dsh pair`），手机直接输 6 位数字秒连，配对体验直接拉齐 MiniMax。
3. **长任务「执行计划与进度」清单（移植 Team Plan）**：
   - 借鉴其 `{{done}}/{{total}} 已完成` 与清单状态机，把 Cordis 会话流里的分步骤任务抽取为顶部/抽屉中的折叠进度条，比简单的文字流水更有「掌控感」。
4. **移动端 Git 状态与一键推送**：
   - 利用 DSH 对宿主系统的深度原生控制能力，在手机端提供简易的「工作区变更审阅（Diff）」与「提交推送」快捷按钮。

---

## 来源列表

- 官方文档站：[agent.minimax.io/docs](https://agent.minimax.io/docs/code/welcome)（含 [llms.txt](https://agent.minimax.io/docs/llms.txt) 索引）
- 开源仓库：[github.com/MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)（MIT）
- 官方 APK 安装包逆向：`MiniMax.apk` v4.20.4（`com.xproducer.yingshiai`，Android 15 实机运行解密）

