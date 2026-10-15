# 06 · 横向对账：桌面版有、移动端没有的功能

> 本文是「防补丁总账」：把桌面 Web 客户端（`oss-study/deepseek-harness/packages/client/`，**只读**）
> 的**全部 64 个包**逐一对到移动端 `dsh-native-mobile/src/` 的现状上，
> 给出缺口、手机复刻难度、价值，以及**哪些桌面功能在手机上根本不该做**。
>
> 结论都带 `文件:行号`。桌面端证据 = `packages/client/<包>/…`；移动端证据 = `src/<文件>:<行号>`。
>
> ⚠️ **快照说明**：移动端此刻有多个并行任务在改（App.tsx = 1354 行、ChatScreen.tsx = 846 行、
> SessionsScreen.tsx = 581 行、connection.ts ≈ 1600 行）。本文的移动端判断基于本次实际打开读过的
> 版本（复核清单见 §4）。若行号漂移，按函数名/符号名检索同名位置。
>
> 覆盖保证：§1 共 64 行 = **54 个 `ui-*` + 10 个非 `ui-*`**，与 `packages/client/` 的 64 个目录一一对应；
> 一处内容若同时涉及两个包，只在主行展开、另一处写"见 #X"，不重复占行。逐包核对表见 §1.8。

---

## 0. 移动端的真实能力边界（先钉死，后面所有"现状"都基于它）

移动端**全部 RPC 调用点只有 9 处**（这是判"无"的硬证据）：

| 方法 | 调用点 |
|---|---|
| `session.list` | `src/App.tsx:347`、`src/App.tsx:790`（轮询 running）、`src/services/connection.ts:1200`（就绪探测） |
| `session.page` | `src/lib/session-page.ts:357`、`:361`（`fetchChatPage`） |
| `session.rename` | `src/App.tsx:650` |
| `session.fork` | `src/App.tsx:666` |
| `session.cancel` | `src/App.tsx:679`、`src/App.tsx:963` |
| `session.create` | `src/App.tsx:687` |
| `session.search` | `src/App.tsx:713` |
| `session.prompt` | `src/App.tsx:849`（`sendOrQueue`，**固定 `mode:'queue'`**） |
| `$events/result` | `src/services/connection.ts`（审批/提问应答） |

实时通道：`$events`（`App.tsx:219-226`，只处理 `api-session/status`）+ `session/follow`（`App.tsx:563`）。

路由只有 4 个：`'hosts' | 'pair' | 'sessions' | 'chat'`（`src/App.tsx:34`）——
**没有设置页、没有侧栏、没有二级页面**。所有"桌面有设置/面板"的包，移动端现状基本是"无"。

---

## 1. 对账总表

约定：**有** = 用户能完成同一目的；**部分** = 有近似能力但缺关键环节；**无** = 完全没有；
**⚙️架构层** = 桌面专有实现方式，移动端有等价物、不构成缺口也不该照搬。
难度是**手机上**的复刻成本（低/中/高）；价值是**手机用户日常真会用**的程度。

### 1.1 会话与工作区

| # | 桌面包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 1 | `ui-workspace` | 工作区浏览器：分组/平铺会话行、行内动作插槽、pin 置顶、**宿主持久化归档**（`src/client/index.ts:102` inject `uiWorkspace`；`src/client/pin-order.ts:26`；`src/client/session-actions/ArchiveSession.tsx`；RPC `workspace.list/archiveSession/pinSession`，见 `packages/client/README.md:53`） | 🟡 **部分**：按工作区分组/折叠/组内限量 12/子代理子节 + **仅本机归档**（`SessionsScreen.tsx:29-38、167-176`；`lib/session-groups.ts:17-21`「真主机的 session 端点没有 archive」；`App.tsx:152-159、629-640`；免责文案 `lib/session-groups.ts:39`）。**无 pin/置顶，归档不落宿主** | 低 | 高 |
| 2 | `ui-sidebar` | 侧栏外壳：品牌行、新建会话、折叠控件、滚动感知区、底部 Settings 座位（`src/client/SidebarRoot.tsx:88`；`src/client/index.ts:40`） | 🟡 **部分**：抽屉 `AppDrawer.tsx:41`（320px 覆盖式）提供新建/会话流/管理主机；**无 Settings 座位**、无折叠态 | 低 | 中 |
| 3 | `ui-sidebar-documentpreview` | 右栏文档预览：Markdown/代码/图片/PDF/Office/HTML 渲染器（`src/client/code/CodeBody.tsx:14`；`README.md:49`） | ❌ **无**（无右栏；聊天气泡只有 `MarkdownView` 渲染文本 + 代码高亮，`MarkdownView.tsx:115`） | 中 | 中 |
| 4 | `ui-sidebar-files` | 工作区文件树（一次列一层，按 resource 地址开文件）（`src/client/definition.tsx:25`；`src/client/face.ts:152`） | ❌ **无**（全 src 无 `workspaceFiles`/`host.listDirectory` 调用） | 中 | 中高 |
| 5 | `ui-directory-picker-browse` | Miller 列目录选择器（`src/client/DirectoryBrowser.tsx:273`；`src/client/flow.ts:33`） | 🟡 **部分**：新建会话时**手打 cwd 或点已知工作区**（`SessionsScreen.tsx:503-554`；`App.tsx:687`），不能浏览主机目录 | 中 | 中 |
| 6 | `ui-directory-picker-native` | 驱动宿主 OS 原生目录选择器（`src/client/flow.ts:25`；RPC `host.pickDirectory` 仅回环） | ❌ **无**（且网关已拒 `host.pickDirectory`：`packages/dsh-mobile-gateway/lib/bridge.mjs:45`） | 高 | 低 |
| 7 | `ui-open-in-app` | 会话头"在 XX 里打开工作区" + 文件默认应用打开（`src/client/OpenInAppAction.tsx`；`src/client/open-path.ts:60,77,88`） | ❌ **无**（`host.openPath` 也被网关拒：`bridge.mjs:46`） | 高 | 低 |

### 1.2 聊天、输入、内容呈现

| # | 桌面包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 8 | `ui-chat` | 会话节点渲染 + **4 档工作步骤视图**（compact/standard/detailed/verbose）+ 折叠时机设置 + 性能/用量显示模式（`src/chat-settings.ts:24,21,47`；`src/client/chat/ChatView.tsx`） | 🟡 **部分**：消息/工具卡/步骤分隔线/注入上下文折叠/流式光标/自动跟随/长按操作（`ChatScreen.tsx:429-579,435-449,454-483`；`CollapsibleMessage.tsx`）；**无视图档位、无折叠时机设置**（展开状态仅按会话持久化，`ChatScreen.tsx:98,161-167`） | 低 | 中 |
| 9 | `ui-conversation` | 会话装配外壳：composer、草稿编辑器、**queue/steer 两种发送行为**、附件校验、上下文占用（`src/client/apply.ts:70,155`；`src/client/contract/input.ts`；locale `settings.enter.queue/steer` = `src/client/locales.ts:75-76`） | 🟡 **部分**：草稿落盘（`chat/draft-store.ts:96,101,127,140`）、运行中排队（`App.tsx:899-909`；`lib/message-queue.ts:2-13`）、离线落盘 outbox（`services/store.ts:282+`；`connection.ts:543+`）；**发送恒为 `mode:'queue'`（`App.tsx:853`），没有 steer/插话**；无附件校验 | 低 | 中高 |
| 10 | `ui-tool` | 工具调用树 + **每个工具的专用卡片**（终端/读写/diff/搜索/网页卡）+ 自动审核拒绝说明（`src/client/tool/components/ToolRow.tsx:120`、`ToolDetails.tsx:117`、`AskQuestionCard.tsx:11`、`models/auto-review-denial.ts:27`；`src/client/apply.ts:22`） | 🟡 **部分**：通用 `DisclosureToolCard`（参数/结果/耗时/错误）+ 40+ 条中文工具名映射（`ChatScreen.tsx:483-520`；`lib/tool-labels.ts:39,66,72-75,84,90,100`）；**无按工具定制的视图**（读文件/diff/搜索/终端网页卡）；`auto-review-denial`（`auto-review-denial.ts:27`）的拒绝原因本地化同样缺失 | 中 | 中 |
| 11 | `ui-primitives` | 基础控件 + 图标 + Markdown/数学渲染 + 终端/read/diff/search/web 输出卡（`src/Button.tsx:27`；`src/code-file-types.ts:2`；`src/ansi.ts:433`） | 🟡 **部分**：自研 Markdown（代码高亮、diff 语法高亮）（`lib/markdown.ts`；`lib/highlight.ts:296`）、复制、`DisclosureToolCard`；**无 ANSI 终端渲染、无 diff 卡** | 中 | 中 |
| 12 | `ui-attachment` | 附件轨：混合草稿附件、拖放目标、**历史图片画廊、原图灯箱**（`src/AttachmentRail.tsx:56`；`src/client/ComposerAttachments.tsx:21`；`src/client/drop-events.ts:30`；`src/client/MessageImages.tsx`） | ❌ **无**：composer 无附件入口（`ChatScreen.tsx:783-823` 只有 textarea+麦克风+发送）；历史消息里的图片内容会被**丢弃**（`lib/session-page.ts:99-132` 只收 text 段）；Markdown 图片只渲染占位卡不加载（`MarkdownView.tsx:322-345`） | 中 | 高 |
| 13 | `ui-commands` | `/` 命令源：命令目录、三种派发、popupSelect（`src/client/service.ts:108,406`；`src/client/PopupSelectView.tsx:42`） | ❌ **无**：只有 4 条硬编码"快捷指令"（`ChatScreen.tsx:338-343,588-600`）；全 src 无 `command.list`/`command.execute` | 中 | 高 |
| 14 | `ui-input-trigger` | 光标下 `/` 与 `@` 检测 + 分组候选菜单（`src/client/controller.ts:60`；`src/core/detect.ts:48`；`src/client/MenuView.tsx:47`） | ❌ **无**（无内联触发菜单） | 中高 | 中高 |
| 15 | `ui-reference` | `@file` / `@session` 原子引用与候选排序（`src/client/index.ts:90`；`src/client/FileReference.tsx:26`） | ❌ **无**（无 `fileReferences.list` 调用） | 中高 | 中 |
| 16 | `ui-skill` | `/` 技能源 + 技能调用卡 + 技能引用渲染（`src/client/index.ts:91`；`src/client/SkillReference.tsx:21`；`src/client/SkillRow.tsx:102`） | 🟡 **部分**：只把宿主注入的技能清单折叠成注记（`lib/session-page.ts:196-209`）；技能类工具名已中文化（`lib/tool-labels.ts:66`）；**无技能选择/引用** | 中 | 中 |
| 17 | `ui-model-selection` | `/model` 弹窗 + composer 模型座位（provider 分组目录）（`src/client/index.ts:107,115`；`src/client/ModelSelect.tsx:64`；`src/client/catalog.ts:56` `remote.session.modelCatalog()`；unary `session.models`/`session.selectModel`） | ❌ **无**：全 src 无 `session.models`/`session.selectModel`；只有**只读**模型名徽标（`ChatScreen.tsx:313,392`；`lib/session-activity.ts:278-280`） | 低 | 高 |
| 18 | `ui-secret-mask` | 已识别凭据在发送文本里脱敏 + 可逐条揭示（`src/client/SecretText.tsx`；`src/client/credential-scanner.ts`） | ❌ **无** | 中 | 低 |
| 19 | `ui-plan` | 计划模式状态芯片 + 退出控制 + 计划卡/审阅（`src/client/PlanModeControl.tsx`；`src/client/plan-resource.ts:37`；`src/client/index.ts:122` `commands.execute(sessionId,'/plan off')`） | ❌ **无**：`exit_plan_mode` 只作为工具名被中文化（`lib/tool-labels.ts:84`），无状态、无控制 | 低中 | 中高 |
| 20 | `ui-workflow-run` | 工作流运行面板：顶层 run 重建为独立节点 + 嵌套成员披露（`src/client/workflow-definition.ts:154`；`src/client/WorkflowRunPanel.tsx:351`） | ❌ **无**（工作流成员事件落进通用工具卡） | 中高 | 中 |
| 21 | `ui-trajectory` | 事件账本视图 + 交互式时间轴总览（`src/client/index.ts:41,48`；`src/client/layout.ts:176`） | 🟡 **部分**：只有一行轮次总结（`3 步 · 2 次工具调用 · 用时 42秒 · 输出 1.2k tokens`，`ChatScreen.tsx:315-319,399-406`；`lib/session-activity.ts:293-308`） | 高 | 低 |
| 22 | `ui-message-feedback` | 消息点赞/点踩 + 反馈弹窗（`/feedback` 与消息动作行）（`src/client/MessageFeedbackActions.tsx:25`；`src/client/index.ts:60`；`remote.messageFeedback.list/put/delete`） | ❌ **无**（全 src 无 `messageFeedback`） | 低 | 中 |
| 23 | `ui-deliverables` | 本轮改动文件卡 + 每文件 diff 审阅 + 交付卡 + 最终回答里的可点文件引用（`src/changes.ts:6,9,12` = `changes.summary` / `changes.diff` / `changes.open`；`src/client/ChangedFiles.tsx`；`src/client/FileDiff.tsx`） | ❌ **无**（全 src 无 `changes.`；只有代码块里的 diff 语法高亮 `lib/highlight.ts:296`） | 中 | 高 |

### 1.3 审批、提问、权限

| # | 桌面包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 24 | `ui-approval` | 审批面板：按 scoped interaction 路径回执（`src/client/ApprovalPanel.tsx:12`；`src/client/contract/slots.ts:74` `PendingApproval`） | ✅ **有**：允许一次/拒绝 + 4 词表（`ChatScreen.tsx:624-656`；`App.tsx:981-994`；`Envelopes.approvalOutcome`）；失败保持弹窗可重试；跨页待办横幅（`App.tsx:1230-1253`）；原生通知决定回灌（`App.tsx:1014-1022`、`native-bridge.ts:245-265`） | — | — |
| 25 | `ui-user-questions` | 提问卡：**定时等待、草稿、迟到回复、多选、plan-review 审批卡**（`src/client/index.ts:222,295` `attachWait/answer`；`src/client/contract/slots.ts:81` `planReviewOf`、`:226` `PendingQuestion`；`src/client/draft-store.ts:43`；`src/client/PlanReviewPanel.tsx:29`） | 🟡 **部分**：只取 `questions[0]`、**单选按钮**、无自定义输入、无多选、无迟到回复/plan-review（`App.tsx:252-273,996-1006`；`ChatScreen.tsx:657-670`） | 低中 | 高 |
| 26 | `ui-permission-presets` | `/permission` 会话级权限预设 + 通用设置默认行（`src/client/catalog.ts:134` `remote.permissionPresets.catalog()`；`src/client/settings-store.ts:122` `settings.mutate`；`src/client/index.ts:59,113`） | ❌ **无**（无权限预设 UI；且**改权限**走 `settings.*`，被网关整体拒绝：`bridge.mjs:57-59`；只读 `permissionPresets.*` 未被拦） | 中 | 中 |
| 27 | `ui-agent-preset` | 会话 agent preset 选择 + 新任务默认预设 + preset 内容阅读（`src/client/seat-store.ts:232` `remote.agentPresets.select()`；`src/client/section-store.ts:48,62`；`settings.update` 写默认值） | ❌ **无**：`session.create` 支持 `agentPreset` 参数但移动端未传（`App.tsx:687`）；无列表/切换；只读 `agentPreset.list/select` 网关未拦，`read/copy/remove` 被拦（`bridge.mjs:41-44`） | 低 | 中高 |

### 1.4 长任务可视化（移动端最痛的一块）

| # | 桌面包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 28 | `ui-jobs` | 会话头后台任务清单：可展开的流式输出面板、运行/已结束分区（`src/client/index.ts:27` inject `jobs`；`src/client/JobListAction.tsx:337`） | ❌ **无**（全 src 无 `jobs` 调用；`lib/tool-labels.ts:100` 只把 `job_*` 工具名中文化） | 中 | 中高 |
| 29 | `ui-goal` | 目标条：显示当前 goal 并编辑/暂停/恢复/清除（`src/client/index.ts:122-150` `remote.goals.get/edit/pause/resume/clear`；`src/client/GoalBar.tsx:42`） | ❌ **无**：`create_goal/update_goal/get_goal` 只作为工具名存在（`lib/tool-labels.ts:72-75`）；无 goal 状态与操作 | 中 | 中高 |
| 30 | `ui-schedule` | 跨会话任务管理 + 当前会话提醒目录 + 投递历史（`src/client/index.ts:93,124,134` `remote.schedule.list/update/history`；`src/client/session-schedule-state.ts:36`；`src/client/definition.ts:34`） | ❌ **无** | 中 | 中 |
| 31 | `ui-subagent` | 子代理目录、续跑路由、`@` 引用、只读 composer（`src/client/index.ts:34,55`；`src/client/sidebar-chat/index.tsx:51,64`；RPC `subagent.list/history/prompt/interrupt`，宿主校验见 `packages/subagent/subagent/src/control.ts:16,22`） | 🟡 **部分（几乎无）**：列表中能看到并折叠子代理（`App.tsx:372-389`；`SessionsScreen.tsx:33`），但**点进去读不了**，只给错误提示（`App.tsx:423-433`）；无 `subagent.*` 调用 | 中高 | 中 |

### 1.5 设置、主题、账号、插件（配置面）

| # | 桌面包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 32 | `ui-settings` | 设置域基础：配置表单、schema 服务、settings 插槽契约（`src/client/config-form.ts:236`；`src/client/schema.ts:39`；`src/client/index.ts:31`） | ❌ **无**（没有设置路由，`App.tsx:34`） | 高 | 低 |
| 33 | `ui-settings-general` | 通用设置区 + 版本行 + 桌面更新指示 + 开发者工具开关（`src/client/GeneralSection.tsx:14`；`src/client/DesktopUpdateIndicator.tsx:56`） | ❌ **无** | 中 | 低 |
| 34 | `ui-settings-models` | 模型 provider 配置、API key 管理、模型列表、DeepSeek 首次引导（`src/client/operations.ts:79,87,93`；`src/client/DeepSeekOnboardingDialog.tsx:58`） | ❌ **无**（且 `credentials.*`/`settings.*` 被网关拒绝：`bridge.mjs:32-59`） | 高 | 低 |
| 35 | `ui-settings-web-search` | 网页搜索 provider 的 API key/端点/预算（`src/client/web-search-card-controller.ts:128,172`） | ❌ **无**（同上被拒） | 中 | 低 |
| 36 | `ui-settings-shell` | shell 执行器设置：命令超时、单流输出上限（`src/client/shell-card-controller.ts:39`） | ❌ **无** | 低 | 低 |
| 37 | `ui-settings-agent-loop` | agent 循环设置：并行工具调用上限（`src/client/agent-loop-card-controller.ts:39`） | ❌ **无** | 低 | 低 |
| 38 | `ui-settings-subagent` | 子代理设置：委派深度/容量/可用模型（`src/client/index.ts:53`；`src/client/subagent-limits-card-controller.ts`） | ❌ **无** | 低 | 低 |
| 39 | `ui-settings-session-log` | 会话日志上传开关（`src/client/upload-preference.ts:18`；`src/client/UploadRow.tsx:26`） | ❌ **无** | 低 | 低 |
| 40 | `ui-settings-plugins` | 内置插件设置区外壳与 tab 扩展点（`src/client/PluginsSettingsSection.tsx:33`） | ❌ **无** | 低 | 低 |
| 41 | `ui-settings-plugin-inventory` | 只读插件清单（按作用域分组 + 搜索）（`src/client/PluginInventorySettingsTab.tsx:252`；`src/client/index.ts:38`） | ❌ **无**（`pluginManager.` 前缀被网关整段拒绝：`bridge.mjs:60`） | 中 | 低 |
| 42 | `ui-plugin-manager` | 侧栏插件面板：安装/启停/重试/组合（`src/client/manager-store.ts:660,988,1170`） | ❌ **无** | 高 | 低 |
| 43 | `ui-settings-account` | 账号设置：DeepSeek 登录态、浏览器授权、额度提示、侧栏账号菜单（`src/client/index.ts:44,72,104,110`） | ❌ **无**（移动端用"配对电脑"模型，不是账号模型：`services/pairing.ts`；`App.tsx:471-508`） | 高 | 低 |
| 44 | `ui-theme` | 主题 / 字号 / 字体族设置 + `--dsw-*` token + 启动注入（`src/client/index.ts:165,545`；`src/boot-theme.ts:55`；`src/client/FontSizeRow.tsx:49`） | ❌ **无**：固定深色主题（`src/index.css`），无字号/字体/主题切换 | 中 | 中 |

### 1.6 形态层（宽屏/多栏/拖拽/键盘）与架构层

| # | 桌面包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 45 | `ui-layout` | 三栏 AppFrame（中间列 + 边缘锚定右栏）+ 面板几何服务 + 主题呈现（`src/client/AppFrame.tsx:121`；`src/client/columns.ts:11-27`：`CENTER_MIN=400`/`SIDEBAR_MIN=264`/`SIDEBAR_AUTO_COLLAPSE=1024`） | ⚙️ **架构对应**：单页路由 + 覆盖式抽屉（`App.tsx:34,1198-1352`；`AppDrawer.tsx:41`）。三栏在手机上无意义（见 §3.1） | — | — |
| 46 | `ui-dockkit` | 分屏树 + 标签页 + 浮动窗 + 指针拖拽手势 + 布局历史（`src/components/DockSurface.tsx:300`；`src/components/FloatLayer.tsx:74` `useFloatGestures`） | ⚙️ **不复刻**（见 §3.1） | — | — |
| 47 | `ui-sidebar-right` | 右栏：每会话一个停靠面、两种呈现、tab 类型注册（`src/client/index.ts:83,101`；`src/client/contract/seed.ts:26`） | ⚙️ **不复刻**（见 §3.1） | — | — |
| 48 | `ui-sidebar-browser` | 右栏内嵌沙箱浏览器（含 loopback 服务）（`src/client/browser/BrowserController.ts:32`；`src/client/browser/IframeImpl.ts:10`） | ⚙️ **不复刻**（见 §3.1） | — | — |
| 49 | `ui-sidebar-terminal` | 右栏交互式终端 tab（打开/恢复/控制）（`src/client/terminal.tsx:24`；`src/client/index.ts:23`） | ⚙️ **不复刻**（见 §3.1） | — | — |
| 50 | `ui-shortcuts` | 快捷键参考面板 + 自定义编辑器（`src/client/Reference.tsx`；`src/client/Editor.tsx:25`） | ⚙️ **不复刻**（见 §3.1；正确替代 = 把命令目录做成可点列表，即 Top10 #3） | — | — |
| 51 | `ui-brand-official` | 官方品牌占位（侧栏品牌名/标记）（`src/client/Brand.tsx:9,17`） | ✅ **有**（自家实现）：`DeepSeekLogo.tsx`；`AppDrawer.tsx:50-52`；`ChatScreen.tsx:361` | — | — |
| 52 | `ui-slots` | 插槽注册表纯内核（`src/index.ts:991` `SlotCore`；`src/renderer.ts:42`） | ⚙️ **架构层**：移动端无插件体系，组件直连（无缺口） | — | — |
| 53 | `ui-renderer` | React 绑定与装配根（`src/client/app.tsx:19`；`src/client/bindings.tsx:21`） | ⚙️ **架构层**（移动端 `src/main.tsx` 直接挂 `App`） | — | — |
| 54 | `ui-session` | Session Controller → Slot 源的标准适配（`src/client/index.ts:282` `UiSession`；`src/client/session-provider.tsx:13`） | ⚙️ **架构层**：移动端用 `App.tsx` 显式状态（`sessions/chatLines/running/activity`，`App.tsx:109-122`） | — | — |

### 1.7 非 `ui-*` 的客户端包（10 个）

| # | 包 | 桌面能力（证据） | 移动端现状（证据） | 难度 | 价值 |
|---|---|---|---|---|---|
| 55 | `connection` | 浏览器↔宿主 RPC/事件交付：连接控制器、退避重连、`host.describe` 就绪握手、错误分类（`connection/README.md:2`；`src/client/connection.ts`；`src/client/socket.ts`） | ✅ **有（自研等价）**：`services/connection.ts`（含 401/403 分流、指数退避 + 抖动、90s 看门狗、落盘去重账本、离线 outbox）；**缺** `host.describe` 就绪握手（用 `session.list` 探测代替，`connection.ts:1200`） | 低 | 低 |
| 56 | `file-upload` | 在页面线程外发 Blob/字节流请求体（`file-upload/README.md:2`；`src/client/runtime.ts`） | ❌ **无**（无上传通道；`session.prompt` 只发 `{type:'text'}`，`App.tsx:854`） | 中 | 高 |
| 57 | `shortcuts` | 应用级键盘命令注册与持久化（`shortcuts/README.md:2`；默认键位如 `ui-workspace/src/client/shortcuts.ts:81,85,90,96,111`） | ❌ **无**（见 §3.1） | — | — |
| 58 | `store` | React-free 可观察/快照 store 原语（`store/README.md:2`） | ⚙️ **架构层**：移动端用 React state + ref（无缺口） | — | — |
| 59 | `hmr` | 开发期客户端插件热重载（`hmr/README.md:2`） | ⚙️ **无关**（移动端无插件体系） | — | — |
| 60 | `locale` | 本地化偏好与词典（`locale/README.md:2`；`src/locales/zh.ts`） | 🟡 **部分**：硬编码中文，无 i18n 层（`src/` 全中文文案） | 中 | 低 |
| 61 | `resources` | 统一资源模型（`useResource` 标准钩子 + protocol provider）（`packages/client/README.md:51`；`ui-plan/src/client/plan-resource.ts:37`；deliverables 的 `dsh-resource://` 地址 `ui-deliverables/src/changes.ts:27`） | ⚙️ **架构层**：移动端按需直接调 RPC；做 Top10 #2（改动卡）时需要引入轻量资源/缓存概念 | — | — |
| 62 | `product-analytics` | 匿名产品分析上报与策略（`product-analytics/src/client/index.ts:22,28`；`remote.productAnalytics.report`） | ❌ **无**（建议保持无，见 §3.2） | — | — |
| 63 | `modules` | 浏览器侧客户端模块加载（`packages/client/README.md:30`） | ⚙️ **架构层**（移动端 Vite 打单包） | — | — |
| 64 | `web` | 浏览器外壳启动（`packages/client/README.md:29`） | ⚙️ **架构层**（移动端 `src/main.tsx`） | — | — |

### 1.8 覆盖率核对表（54 + 10 = 64）

| 桌面包 | 行号 | 桌面包 | 行号 | 桌面包 | 行号 |
|---|---|---|---|---|---|
| ui-agent-preset | #27 | ui-approval | #24 | ui-attachment | #12 |
| ui-brand-official | #51 | ui-chat | #8 | ui-commands | #13 |
| ui-conversation | #9 | ui-deliverables | #23 | ui-directory-picker-browse | #5 |
| ui-directory-picker-native | #6 | ui-dockkit | #46 | ui-goal | #29 |
| ui-input-trigger | #14 | ui-jobs | #28 | ui-layout | #45 |
| ui-message-feedback | #22 | ui-model-selection | #17 | ui-open-in-app | #7 |
| ui-permission-presets | #26 | ui-plan | #19 | ui-plugin-manager | #42 |
| ui-primitives | #11 | ui-reference | #15 | ui-renderer | #53 |
| ui-schedule | #30 | ui-secret-mask | #18 | ui-session | #54 |
| ui-settings | #32 | ui-settings-account | #43 | ui-settings-agent-loop | #37 |
| ui-settings-general | #33 | ui-settings-models | #34 | ui-settings-plugin-inventory | #41 |
| ui-settings-plugins | #40 | ui-settings-session-log | #39 | ui-settings-shell | #36 |
| ui-settings-subagent | #38 | ui-settings-web-search | #35 | ui-shortcuts | #50 |
| ui-sidebar | #2 | ui-sidebar-browser | #48 | ui-sidebar-documentpreview | #3 |
| ui-sidebar-files | #4 | ui-sidebar-right | #47 | ui-sidebar-terminal | #49 |
| ui-skill | #16 | ui-slots | #52 | ui-subagent | #31 |
| ui-theme | #44 | ui-tool | #10 | ui-trajectory | #21 |
| ui-user-questions | #25 | ui-workflow-run | #20 | ui-workspace | #1 |
| connection | #55 | file-upload | #56 | hmr | #59 |
| locale | #60 | modules | #63 | product-analytics | #62 |
| resources | #61 | shortcuts | #57 | store | #58 |
| web | #64 | | | | |

---

## 2. Top 10 缺口（按"日常真会用 × 手机上可实现"排序）

每项给出**最小可用实现**（改哪些文件、加哪些 RPC）。

| 排名 | 缺口 | 为什么值 | 最小可用实现 |
|---|---|---|---|
| **1** | **模型选择** | 远程遥控时"换个更强的模型重跑"是最高频的一次点击；现在只能看着模型名不能改（`ChatScreen.tsx:392`） | 新增 `src/components/chat/ModelPicker.tsx`（底部弹层，复用 `SessionsScreen.tsx:490-578` 的 modal 样式）；RPC：`session.models`（读目录）+ `session.selectModel`（写，`{sessionId, provider, model, reasoningEffort?}`）；入口把 `ChatScreen.tsx:384-415` 的模型徽标改成可点；`App.tsx` 加 2 个 handler |
| **2** | **本轮改动文件卡（changed files / diff）** | "它到底改了我哪些文件"是遥控最核心的信任来源；现在只能从工具卡里猜 | 新增 `src/components/chat/ChangedFilesCard.tsx`；RPC：`changes.summary`（文件数/增删行）+ `changes.diff`（点开看文本 diff，复用 `lib/highlight.ts:296` 的 diff 高亮）；挂到 `ChatScreen.tsx:429-579` 时间线末尾（该轮结束后显示） |
| **3** | **斜杠命令 + 技能选择** | 手机上打 `/` 比打自然语言省事；命令/技能是宿主的真实能力入口 | 新增 `src/components/chat/CommandPalette.tsx`（按钮或输入 `/` 触发筛选）；RPC：`command.list`（列命令）+ `command.execute`（派发）；技能并入同一列表（`skill.list`）；入口放 `ChatScreen.tsx:783-823` composer 左侧加 `/` 按钮 |
| **4** | **审批/提问补齐：多选 + 自由输入 + 迟到回复** | 现在遇到多选题或"需要填一段话"的提问，手机用户**无法作答**（只能选第一个选项，`App.tsx:258,273`） | 改 `src/types/index.ts` 的 `PendingPrompt`（加 `multiSelect`/完整 options 结构）+ `App.tsx:252-273`（保留全部 questions）+ `App.tsx:996-1006`（`Envelopes.questionOutcome(questionId, selected[])` 已支持多选）+ `ChatScreen.tsx:657-670` 渲染多选与输入框；plan-review 卡片先用同一张卡兜（`ui-user-questions/src/client/contract/slots.ts:81`） |
| **5** | **附件：拍照/选图发给电脑** | 手机最大的先天优势（拍屏幕、拍白板、拍报错）；桌面端 `ui-attachment` 已验证流程 | RPC：`session.prompt` 的 `content` 追加 `{type:'image', mediaType, data:base64}`（`docs/api-contract.md:493`）；新增 `src/components/chat/AttachmentBar.tsx`（`<input type="file" accept="image/*" capture>` → base64 → 缩略图/删除）；改 `App.tsx:849-856` 的 content 拼装 |
| **6** | **宿主持久化归档 + 置顶** | 现在"归档"只存在这台手机里（`App.tsx:152-159`），换手机/清缓存就丢；桌面端是宿主持久化 | RPC：`workspace.list`（含 `archivedSessionIds`）+ `workspace.archiveSession` / `workspace.unarchiveSession`（+ `workspace.pinSession` 做置顶）；改 `App.tsx:629-640`（`applyArchive` 改调 RPC，失败回退本机）+ `lib/session-groups.ts`（读宿主的 archived 集合，删掉 `:17-21,39` 的"仅本机"免责说明）。网关**未拦** `workspace.*` |
| **7** | **计划模式状态与控制** | 计划模式开着却看不出来，是"以为它在干活其实在等批准"的经典误解 | 新增 `src/lib/plan-state.ts`（从 `session/follow` 事件/投影判定 plan 开/关）；退出用 `command.execute(sessionId, '/plan off')`（桌面同款，`ui-plan/src/client/index.ts:122`）；UI 放 `ChatScreen.tsx:384-415` 顶部可点芯片 |
| **8** | **后台任务（jobs）列表** | 长任务里"后台在跑什么、要不要杀掉"手机上看不到，只能等 | 新增 `src/components/chat/JobsSheet.tsx`；RPC：宿主 `jobs` 域的 list/kill（经 `ctx.jobs`，**方法名需按 `ui-jobs/src/client/index.ts:27` 的注入契约在集成时核对**）；入口与模型徽标并排（`ChatScreen.tsx:384-415`） |
| **9** | **子代理导航与续跑** | 真主机上多数会话是子代理（`App.tsx:423-431` 实测 8 种 address 形状全被拒），现在点进去是死页 | 短解：`subagent.list` + 只读 `subagent.history`，把"读不了"换成"能看到"；进阶：`subagent.prompt`（`mode:'continuable'`）续跑（宿主校验 `packages/subagent/subagent/src/control.ts:16,22`）；改 `App.tsx:400-435` 与子代理子节 `components/sessions/SessionGroupSection.tsx:168-191`（数据来自 `App.tsx:372-389`） |
| **10** | **定时提醒（schedule）** | "两小时后来提醒我看结果"是手机场景的自然需求 | RPC：`remote.schedule.list({sessionId})` / `update` / `delete` / `history`（`ui-schedule/src/client/index.ts:93,124,134`）；新增 `src/components/chat/ScheduleSheet.tsx`（时间选择 + 列表），入口与 #8 同处 |

**候补（随时可顶替 #9/#10）**：
- **目标条（goal）**：长任务遥控的核心状态（`remote.goals.get/edit/pause/resume/clear`，`ui-goal/src/client/index.ts:122-150`），成本与 #7 相当、价值更高 —— 若本轮只做 3 件事，建议它优先于 #10。
- **消息反馈**：`remote.messageFeedback.list/put/delete`（`ui-message-feedback/src/client/index.ts:60`），低成本、能标记"这次答得不对"。
- **工作步骤视图档位**：`ui-chat/src/chat-settings.ts:24` 四档 + 收起时机 `:21`；移动端折叠基础设施已就绪（`CollapsibleMessage.tsx`、`draft-store.ts` 的状态持久化），加一个本地设置项即可。

---

## 3. 明确**不该**在手机上复刻的桌面功能

### 3.1 依赖宽屏/多栏/拖拽/物理键盘（复刻 = 照搬桌面）

| 桌面功能 | 证据 | 不复刻的理由 |
|---|---|---|
| 三栏 `AppFrame` + 边缘锚定右栏 + 面板几何服务 | `ui-layout/src/client/AppFrame.tsx:121`；`src/client/columns.ts:11-27`（`CENTER_MIN=400`、`SIDEBAR_MIN=264`、`SIDEBAR_AUTO_COLLAPSE=1024`） | 常量本身就是按 ≥1024px 设计的：手机上 `CENTER_MIN=400` 已吃掉全部宽度。移动端已有正确形态（单页路由 + 覆盖式抽屉，`App.tsx:34`、`AppDrawer.tsx:41`），硬上三栏只会让聊天区归零 |
| 停靠布局套件：分屏树、标签页、浮动窗、指针拖拽手势、布局线性历史 | `ui-dockkit/src/components/DockSurface.tsx:300`；`FloatLayer.tsx:74`（`useFloatGestures`）；`measure.ts:90` | 依赖 hover、指针拖拽、最小 300px 面板（`ui-layout/columns.ts:25` `RIGHTBAR_MIN=300`）和"多任务并列"的桌面心智；手机上拖标签是反模式，浮动窗会被软键盘顶飞 |
| 右栏及其全部 tab 类型（右栏容器/文件树/文档预览/内嵌浏览器/终端） | `ui-sidebar-right/src/client/index.ts:83,101`；`ui-sidebar-files/src/client/definition.tsx:25`；`ui-sidebar-documentpreview/src/client/code/CodeBody.tsx:14`；`ui-sidebar-browser/src/client/browser/BrowserController.ts:32`；`ui-sidebar-terminal/src/client/terminal.tsx:24` | 右栏价值在"与对话并排看"，手机没有并排空间。**要复刻的是行为不是容器**：diff/文件预览做成**全屏页**（Top10 #2），终端需要物理键盘且几乎无人用，内嵌浏览器已有系统浏览器 |
| 快捷键参考与自定义编辑器 | `ui-shortcuts/src/client/Editor.tsx:25`、`src/client/Reference.tsx`；`shortcuts` 包；默认键位 `ui-workspace/src/client/shortcuts.ts:81-111` | 手机没有物理键盘，外接键盘是极少数场景。**正确替代**：把桌面快捷键目录当**命令目录**渲染成可点列表（数据源 `command.list`，即 Top10 #3），而不是复刻键位编辑器 |
| 拖放附件目标（document drop target） | `ui-attachment/src/client/drop-events.ts:30` | 手机上不存在拖放；用系统选择器/相机代替（Top10 #5） |

### 3.2 手机上做了也是负担（安全面/语境，且网关已拒绝）

| 桌面功能 | 证据 | 理由 |
|---|---|---|
| 插件管理（安装/启停/卸载） | `ui-plugin-manager/src/client/manager-store.ts:660,988,1170`；网关 `PRIVILEGED_PREFIXES` 含 `pluginManager.`（`packages/dsh-mobile-gateway/lib/bridge.mjs:60`） | 安装会执行构建脚本、变更宿主插件表；网关**已整段拒绝**。手机上做等于把最危险的操作放进最容易被社工的界面 |
| 设置与凭据面（模型 provider API key、web-search key、shell/agent-loop/subagent 配置） | `ui-settings/src/client/config-form.ts:236`；`ui-settings-models/src/client/operations.ts:79-93`；`ui-settings-web-search/src/client/web-search-card-controller.ts:172`；网关拒 `settings.` / `credentials.` 前缀（`bridge.mjs:57-59`） | 同样被网关拒绝，且手机输入长密钥体验极差；这类配置应在电脑上一次性完成 |
| "在电脑上用 XX 打开" / 宿主原生目录选择器 | `ui-open-in-app/src/client/open-path.ts:60`；`ui-directory-picker-native/src/client/flow.ts:25`；网关拒 `host.openPath` / `host.pickDirectory`（`bridge.mjs:45-46`） | 只有本机回环才有意义（网关已拦）；手机上"打开"的是另一台机器的桌面，语境不成立 |
| DeepSeek 账号登录 / 余额 / 额度 | `ui-settings-account/src/client/index.ts:44,72,104,110`；`remote.account.*` | 移动端安全模型是"**配对本机电脑** + 设备令牌"（`services/pairing.ts`、`docs/protocol.md`），不是"登录同一个云账号"。混入账号体系会同时破坏权限边界与用户心智 |
| 产品分析上报 | `product-analytics/src/client/index.ts:22,28` | 自建/私有部署场景不应默认回传遥测；要做也必须显式开关 |

### 3.3 低优先（可做，但不值得排在前面）

- `ui-trajectory` 事件账本与时间轴总览（`src/client/layout.ts:176`）：为桌面复盘设计；手机上的 `turnSummary` 一行（`ChatScreen.tsx:399-406`）已覆盖 80% 需求。
- `ui-workflow-run` 嵌套成员披露（`WorkflowRunPanel.tsx:351`）：先用通用工具卡兜住，等真有工作流使用场景再补。
- `ui-secret-mask` 凭据脱敏（`ui-secret-mask/src/client/SecretText.tsx`）：真实的展示层加固，但排在"看得懂任务状态"类缺口之后。
- `locale` 多语言（`locale/src/locales/zh.ts`）：当前全硬编码中文，先保持单一语言。
- `ui-settings-general` 的版本行/更新指示（`DesktopUpdateIndicator.tsx:56`）：桌面壳专属，Android 壳应走自己的更新通道。

---

## 4. 移动端"现状"复核清单（实际打开读过的文件）

- 路由与装配：`src/App.tsx`（1354 行：7 个 `session.*` 调用点、`$events`/`session/follow` 订阅、outbox/phase/横幅/深链/返回键）
- 组件：`src/components/screens/{ChatScreen,SessionsScreen}.tsx`、`src/components/drawer/AppDrawer.tsx`、
  `src/components/chat/{DisclosureToolCard,QueuedMessagesBar,CollapsibleMessage,VoiceRecordingOverlay}.tsx` + `chat/draft-store.ts`、
  `src/components/sessions/{SessionGroupSection,SessionCard,ArchivedSection,SessionActionMenu,CollapsibleSection}.tsx`、
  `src/components/common/{MarkdownView,StatusPill,ConnectionDot,DeepSeekLogo}.tsx`
- 纯逻辑：`src/lib/{session-page,session-groups,session-activity,tool-labels,message-queue,markdown,highlight}.ts`
- 服务：`src/services/{connection,store,device,native-bridge,pairing,envelopes,demo}.ts`
- 契约与类型：`src/types/index.ts`；`docs/api-contract.md`（RPC 名称/参数）；`packages/dsh-mobile-gateway/lib/bridge.mjs`（网关拒绝清单）
- 桌面端：`packages/client/` 全部 64 个目录的 README/`src/**` 代码扫描（54 个 `ui-*` + 10 个非 `ui-*`）

---

## 5. 结论

1. **移动端不缺"聊天"，缺"遥控一台正在干活的电脑"所需的上下文**：
   模型（#17）、改了什么（#23）、后台在跑什么（#28）、计划/目标状态（#19/#29）、子代理（#31）、
   审批可作答性（#25）。这六项是"看不懂 / 不敢信"的直接来源。
2. **54 个 `ui-*` 里只有约 14 个在手机上有真价值**；其余是形态层（不该搬）、配置面（网关已拒）或低频复盘视图。
3. **不要照搬的方式**：右栏 → 全屏页；快捷键目录 → 命令列表；拖放 → 系统选择器；
   三栏 → 单页 + 抽屉；插件管理/凭据面 → 只在电脑上做。