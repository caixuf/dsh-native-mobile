# 01 · 桌面版会话界面拆解（供移动端 1:1 复刻）

> 源码（**只读**）：`C:\Users\20247\Downloads\oss-study\deepseek-harness`
> 本文所有结论都标注 `文件:行号`。**路径约定**：`ui-chat/...` = `packages/client/ui-chat/...`，其余同理（`ui-conversation`、`ui-tool`、`ui-input-trigger`、`ui-user-questions`、`ui-approval`、`ui-commands`、`ui-trajectory`）。
> 行号均为本次实际读取所得（每次引用都是先打开文件确认该行内容）；引用格式 `路径:行号`，不含"约/附近"类的模糊标注。
> 未读到出处的判断一律写成"未找到"或明确标注为推断。

---

## 0. 一分钟结论（先看这个）

| # | 结论 | 证据 |
|---|---|---|
| 1 | 会话界面**不是**"一个消息列表"，而是一套 **节点渲染器注册表**：`conversation.chat.node` 插槽按 `kind` 分发，共 **15 个 key**（14 个业务 kind + `unknown` 兜底） | `ui-chat/src/client/chat/register-node-renderers.ts:40-89` |
| 2 | 一条 assistant 回答 = **`assistant-step` 节点**，其数据是 `AssistantChatData{status,turn,step,blocks,time,usage?,finalNode?}`；正文/思考/工具/图片都是 `blocks[]` 里不同的 `kind` | `ui-chat/src/client/contract/chat-nodes.ts:38-46`、`ui-chat/src/client/conversation-nodes/assistant.ts:273-282` |
| 3 | 工具调用**不渲染在 assistant 节点里**：`tool-call` block 被 `AssistantMarkdown` 显式跳过，由 Chat 的分组过程渲染成独立工具行 | `ui-chat/src/client/chat/AssistantMarkdown.tsx:131-133`、`ui-chat/src/client/chat/AssistantMarkdown.tsx:68-74` |
| 4 | 桌面版的"流式感"来自 **① 节点 `data-streaming` ② 摘要 `TextShimmer` ③ 底部 `RunningStatus` 实时秒表**；**未找到**正文尾部闪烁光标之类的元素 | `ui-chat/src/client/chat/AssistantMarkdown.tsx:146`、`ui-chat/src/client/chat/ReasoningRow.tsx:63-66`、`ui-chat/src/client/chat/RunningStatus.tsx:31-39` |
| 5 | 上一轮的"过程"（思考+工具）会被收进**整轮控制行 `turn-process`**，默认折叠，并带 `messageCount/toolCallCount/subagentCount` 三个计数——正是"8 张工具卡没有收束"的桌面版解法 | `ui-chat/src/client/chat/TurnProcessNodeView.tsx:37-50`、`ui-chat/src/client/contract/turn-process.ts:4-18` |
| 6 | 动作按钮（复制/分支/用量）默认**靠 hover/focus 才显示**，且代码里显式写了"没有 hover 的设备保持常显" | `ui-chat/src/client/chat/MessageIconActions.module.css:39-61` |
| 7 | 发送/排队/停止是**同一个输入区**的三个状态：运行中主按钮变 Stop，`session.prompt(..., 'queue')` 负责入队 | `ui-conversation/src/client/skeleton/InputBar.tsx:323-342`、`ui-conversation/src/client/service.ts:209-213` |

---

## 一、信息架构：一条 assistant 消息由哪些部分组成

### 1.1 渲染总入口：节点 kind → 渲染器

| kind（逐字） | 渲染组件 | 证据 |
|---|---|---|
| `user` / `steering` | `UserMessageNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:40-43` |
| `context` | `ContextMessageNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:44-45` |
| `turn-trigger` | `TurnTriggerNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:46-47` |
| `system-prompt` | `SystemPromptNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:48-49` |
| `assistant-step` | `AssistantNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:50-59` |
| `command` | `CommandNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:60-65` |
| `manual-compaction` | `ManualCompactionNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:66-67` |
| `compaction` | `CompactionNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:68-69` |
| `model-retry` | `RetryNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:70-71` |
| `turn-error` | `TurnErrorNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:72-73` |
| `turn-max-tokens` | `TurnMaxTokensNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:74-75` |
| `turn-process` | `TurnProcessNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:76-77` |
| `turn-tail` | `TurnTailNodeView` | `ui-chat/src/client/chat/register-node-renderers.ts:78-87` |
| `unknown` | `UnknownNodeView`（JSON 兜底） | `ui-chat/src/client/chat/register-node-renderers.ts:88-89` |

每个节点都过一层"座席"：`ChatNodeSeat` 负责订阅、可见性、分组和 DOM 锚点，然后 `renderSlot('conversation.chat.node', …, { entryKey: routedNode.kind, … })` 按 kind 分发（`ui-chat/src/client/chat/ChatNodeSeat.tsx:161-171`）。座席还挂了一组 e2e/样式用锚点：`data-chat-node-key` / `data-chat-flow-kind` / `data-chat-turn` / `data-turn-process-*`（`ui-chat/src/client/chat/ChatNodeSeat.tsx:145-159`）。

### 1.2 `assistant-step` 的数据契约

| 数据 | 字段（逐字） | 证据 |
|---|---|---|
| 节点载荷 | `status: 'running' \| 'settled' \| 'interrupted'`、`turn`、`step`、`blocks: readonly AssistantBlock[]`、`time`、`usage?`、`finalNode?` | `ui-chat/src/client/contract/chat-nodes.ts:38-46` |
| 落定后的 durable 消息 | `kind:'assistant'`、`seq`、`messageId`、`time`、`turn`、`step`、`blocks`、`usage`、`timing{stepStartTime,firstTokenTime,completedTime}`、`interrupted?` | `ui-chat/src/client/conversation-nodes/assistant.ts:196-212` |
| 状态机来源 | `settled.interrupted → 'interrupted'`；无 settled → `'running'`；否则 `'settled'` | `ui-chat/src/client/conversation-nodes/assistant.ts:263-265` |
| 驱动事件（逐字） | `step/start`、`assistant/live-chunk`、`assistant/message`、`llm/retry` | `ui-chat/src/client/conversation-nodes/assistant.ts:364-372` |
| 流式 chunk 类型（逐字） | `block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish` | `ui-chat/src/client/conversation-nodes/assistant.ts:104-145`、`:322-326` |
| 发布节奏（逐字） | `'none' \| 'immediate' \| 'animation-frame'`（`usage`/`finish` 不发；`live-chunk` 走 animation-frame） | `ui-chat/src/client/conversation-nodes/assistant.ts:321-326` |

### 1.3 一段 assistant 消息由上到下

| 段 | 渲染实现 | 输入数据 | 证据 |
|---|---|---|---|
| 0. 整轮过程控制行（在消息**之前**） | `TurnProcessNodeView`：一行"工作了 / 用时 X"s 的按钮，可折叠整轮过程 | `TurnProcessChatData{turn, controlAnchorSeq, processStartSeq, answerAnchorSeq, answerStep, inlineReasoning, messageCount, toolCallCount, subagentCount}` | `ui-chat/src/client/chat/TurnProcessNodeView.tsx:22-30`、`ui-chat/src/client/contract/chat-nodes.ts:107-117` |
| 1. 触发来源说明（非人类触发的轮次） | `TurnTriggerNodeView`：图标 + 标题 + 时间 + 展开正文 | `node.data{…}`（`request/goal/agent/team/subagent/github/webhook/schedule/job/plugin` 图标映射） | `ui-chat/src/client/chat/TurnTriggerNodeView.tsx:15-26`、`:29-47` |
| 2. 思考（reasoning） | `ReasoningRow` → `DisclosureRow`，标题 `t('message.think')` | `text`、`running`、`useDisclosure`、`usePresentation` | `ui-chat/src/client/chat/ReasoningRow.tsx:85-99` |
| 3. 正文（text block） | `MarkdownText`（来自 ui-primitives），带 `streaming`、`labels`、`fileMentions`、`pathImages` | `block.text` | `ui-chat/src/client/chat/AssistantMarkdown.tsx:82-93` |
| 4. 图片 block | 连续 `image` block 合成一组画廊，走 `conversation.chat.message.images` 插槽 | `group.map(({attachment}) => ({attachment}))`、`loadImage`、`align:'start'` | `ui-chat/src/client/chat/AssistantMarkdown.tsx:108-130` |
| 5. 工具调用 | **不在本组件**：`tool-call` 在 `switch` 里直接 `break`（注释：由 ChatView 分组渲染成工具行） | `ToolCallBlock` | `ui-chat/src/client/chat/AssistantMarkdown.tsx:131-133` |
| 6. 未知 block | `JsonBlock` 兜底，标签 `t('message.unknownBlock')` | `block.block` | `ui-chat/src/client/chat/AssistantMarkdown.tsx:134-143` |
| 7. 中断标记 | 正文尾部 `<span>{t('message.stopped')}</span>` | `interrupted` prop | `ui-chat/src/client/chat/AssistantMarkdown.tsx:149-151` |
| 8. 轮次尾巴（动作 + 用量 + 时间） | `TurnTailNodeView` → `MessageIconActions`（复制/分支/用量） | `TurnTailChatData{turn, seq, time, closing, branchUnavailable, tokenUsage?}` | `ui-chat/src/client/chat/TurnTailNodeView.tsx:64-77`、`ui-chat/src/client/contract/chat-nodes.ts:94-104` |
| 9. 插件动作位 | `conversation.chat.assistant-actions`（list slot，key = `messageId`） | `AssistantActionOwnerProps{messageId}` | `ui-chat/src/client/chat/TurnTailNodeView.tsx:53-56`、`ui-chat/src/client/contract/slots.ts:63-65` |
| 10. 引用（文件提及） | 由 `AssistantNodeView` 从"闭合轮次 owner"解析出 `mentions`，交给 `MarkdownText` 的 `fileMentions` | `fileMentions(owner)` | `ui-chat/src/client/chat/AssistantNodeView.tsx:19-27`、`ui-chat/src/client/chat/AssistantMarkdown.tsx:89` |
| 11. 召回类引用（context 节点） | `ContextInjectionRow`：`producer.role === 'recall'` 时用会话引用图标；标题 key `message.contextRecall` | `producer.role`、`producer.label` | `ui-chat/src/client/chat/ContextInjectionRow.tsx:53-55`、`:57` |
| 12. 轮次用量详情 | `TurnUsagePanel`：胶囊（`t('message.turnUsage.consumed')`）+ 点击弹出 `role="dialog"` 明细 | `TurnTokenUsage{uncachedInputTokens,outputTokens,totalTokens,cacheReadTokens?,cacheWriteTokens?,reasoningTokens?,routes?}` | `ui-chat/src/client/chat/TurnUsagePanel.tsx:37-65`、`ui-chat/src/client/contract/chat-nodes.ts:77-91` |
| 13. 失败/截断/重试（独立节点） | `TurnErrorItem`（错误码 chip）、`TurnMaxTokensItem`（warning dot）、`ModelRetryItem`（倒计时 `<details>`） | `TurnErrorNode{message,code}`、`ModelRetryNode{delayMs,mode,maxRetries,retry,retryState,failure}` | `ui-chat/src/client/chat/MessageItem.tsx:132-161`、`:63-128` |
| 14. 压缩标记 | `CompactionItem`：`t('message.compaction.completed', {items, tokens})`，可展开摘要 | `CompactionSummaryNode{summary, shadowedItemCount, shadowedTokenCount}` | `ui-chat/src/client/chat/CompactionItem.tsx:39-47`、`:72-73` |
| 15. 用户消息 | `UserStyleBubble` → `conversation.chat.user.content` 工厂插槽 + `MessageIconActions` | `data.content`、`data.time`、`data.referenceLabels`、`data.skillNames` | `ui-chat/src/client/chat/MessageItem.tsx:163-212`、`:298-321` |
| 16. 流式状态行（列表最末） | `RunningStatus`：`RunningWhaleTail` + `TextShimmer` + `t('chat.deepDivingFor',{duration})` | 当前轮 `turn.start.time` | `ui-chat/src/client/chat/RunningStatus.tsx:28-39`、`ui-chat/src/client/chat/ChatFlow.tsx:19-26` |

> **耗时/用量到底从哪来**（移动端最容易抄错的一块）：
> - 整轮耗时：`turn.end.time - turn.start.time`，再 `formatRunDuration`（`ui-chat/src/client/chat/TurnProcessNodeView.tsx:22-25`）。
> - 运行中秒表：`RunningStatus` 用 `LIVE_RUN_CLOCK_INTERVAL_MS`（1000ms）刷新（`ui-chat/src/client/chat/message-chrome.ts:13`、`ui-chat/src/client/chat/RunningStatus.tsx:22-27`）。
> - 每步 TTFT/decode：`assistantStepReading(node)` → `{ttftMs, decodeMs, outputTokens}`（`ui-chat/src/client/contract/turn-metrics.ts:8-15`、`:34-42`）。
> - 会话统计胶囊：`sessionStats` 投影，字段 `turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens`；无投影时按同样字段名在前端折叠（`ui-chat/src/client/chat/StatsPills.tsx:24-39`、`:160-164`、`:53-83`）。
> - token 明细：`tokenUsage` 投影（`ui-chat/src/client/chat/StatsPills.tsx:284`）。

### 1.4 思考（reasoning）的折叠语义

| 规则 | 证据 |
|---|---|
| 默认**折叠**：`useDisclosure()` 初始 `expanded=false`，且"每个调用点独立" | `ui-chat/src/client/chat/use-disclosure.ts:11-21`、`ui-chat/src/client/chat/ReasoningRow.tsx:55` |
| 折叠态文案 = 摘要单行：运行中取**最后一个已完成段落首行**，落定取首行；并剥掉 `**` | `ui-chat/src/client/chat/ReasoningRow.tsx:56-57`、`:11-32` |
| 预览仅在 `!expanded && summary !== '' && (running \|\| policy.settledReasoningPreview)` 时显示 | `ui-chat/src/client/chat/ReasoningRow.tsx:58-59` |
| DOM 状态机：`data-state=running\|ok`、`data-expanded`、`data-preview`；整行可点展开 `expandOnRowClick` | `ui-chat/src/client/chat/ReasoningRow.tsx:76-83`、`:85-99` |
| 运行中还有一条给读屏的 `t('row.running')` | `ui-chat/src/client/chat/ReasoningRow.tsx:84` |
| 思考可以被**整轮过程折叠**隐藏（`reasoningHidden`），此时展开整轮控制行即可 | `ui-chat/src/client/chat/AssistantNodeView.tsx:28-33`、`ui-chat/src/client/chat/AssistantMarkdown.tsx:96-106` |

---

## 二、交互清单（触发 → 结果 → 证据）

| 交互 | 触发方式 | 结果 | 证据 |
|---|---|---|---|
| 展开/收起思考 | 点整行（`expandOnRowClick`） | 展开渲染 `conversation.chat.reasoning.body` | `ui-chat/src/client/chat/ReasoningRow.tsx:85-99`、`:70-74` |
| 展开/收起整轮过程 | 点 `turn-process` 行按钮 | `setOpen(!open)`；`aria-expanded`；不可折叠时 `disabled` | `ui-chat/src/client/chat/TurnProcessNodeView.tsx:37-50`、`:19` |
| 复制 assistant 正文/整轮文本 | 点复制图标（`aria-label = t('copy')`，成功后 1s 变 `t('copied')`） | `writeClipboard(text)`，文本来自 `assistantText(closing.blocks)` | `ui-chat/src/client/chat/MessageIconActions.tsx:85-89`、`:62-76`、`ui-chat/src/client/chat/TurnTailNodeView.tsx:65` |
| 复制用户消息 | 同上（用户气泡下也有 actions） | `text` = 拼接后的用户文本 | `ui-chat/src/client/chat/MessageItem.tsx:310-318`、`:209` |
| 复制代码块（assistant 正文里的围栏代码） | `CodeBlock` 自带"语言名 + 复制 + 折行"工具栏 | 由 ui-primitives 提供：`render.tsx` 渲染围栏时传 `copyLabel/copiedLabel/toolbarLabels`；`CodeBlock` 自己吃 `lang`，复制走 `writeClipboard` | `ui-primitives/src/markdown/render.tsx:26`、`:394-409`、`ui-primitives/src/markdown/CodeBlock.tsx:17`、`:36-42`、`:4` |
| 复制代码块（工具卡里） | 同一 `CodeBlock`，由工具卡显式传 labels | `copyLabel={t('copy')}` 等 | `ui-tool/src/client/tool/components/ToolRow.tsx:324-328` |
| ⚠️ 用户消息**没有** markdown/代码卡 | 用户文本走 `conversation.user.text` 工厂 → `UserText` → `UserTextRun`（纯文本 run + 引用 chip），不是 MarkdownText | `ui-conversation/src/client/user-text/UserText.tsx:34-45`、`:53-55`、`ui-chat/src/client/chat/MessageItem.tsx:203-208` |
| 分支（fork） | 点分支图标；`forkAt(data.seq)`；权限来自 `useAccess('session/fork')` | `ctx.sessions.fork({sessionId, atSeq, increaseTitle:true, onCreated})` → 打开新会话；失败静默保留原视图 | `ui-chat/src/client/chat/TurnTailNodeView.tsx:31-32`、`:70-71`、`ui-chat/src/client/apply.ts:285-295` |
| 分支不可用 | `branchUnavailable`（非尾部/有更晚内容）时按钮 `aria-disabled` + 隐藏说明 `t('message.branchUnavailable')` | 仍可聚焦/悬停以便 Tooltip 解释 | `ui-chat/src/client/chat/MessageIconActions.tsx:91-109`、`ui-chat/src/client/chat/TurnTailNodeView.tsx:71` |
| 查看轮次用量 | 点 `TurnUsagePanel` 胶囊（`aria-haspopup=dialog`） | 弹出明细：模型路由、cache hit、input/cacheRead/cacheWrite/output(+reasoning) | `ui-chat/src/client/chat/TurnUsagePanel.tsx:42-51`、`:68-104` |
| 自动重试（模型层） | Host 事件 `llm/retry`，无手动按钮 | `<details>` 行显示"第 n/max 次重试 + 倒计时 + 失败原因"；`retryState` = `scheduled\|started\|cancelled` | `ui-chat/src/client/chat/MessageItem.tsx:63-128`、`ui-chat/src/client/conversation-nodes/retry.ts:23-30` |
| 手动重试失败轮次 | **未找到**：`TurnErrorItem` 只有文案 + 错误码，无按钮 | — | `ui-chat/src/client/chat/MessageItem.tsx:136-146` |
| 编辑已发送消息 | **未找到**：`MessageIconActions` 的全部 props 只有 `text/time/clock/onBranch/branchUnavailable/className/extraActions/usageAction` | 桌面版靠"分支 + 重发"代替编辑 | `ui-chat/src/client/chat/MessageIconActions.tsx:13-38` |
| 编辑**排队中**的消息 | 队列行点铅笔 → 行内编辑器 → 保存 | `updateQueue(id, {kind:'edit', content:[{type:'text',text}]})` | `ui-conversation/src/client/queue/QueueDock.tsx:266-281`、`:159-166` |
| 排队项转发（steer） | 队列行点发送图标（仅 `running` 可用） | `updateQueue(id, {kind:'steer'})` | `ui-conversation/src/client/queue/QueueDock.tsx:299-316` |
| 删除排队项 | 队列行点垃圾桶 | `updateQueue(id, {kind:'remove'})` | `ui-conversation/src/client/queue/QueueDock.tsx:282-298` |
| 停止当前轮 | ①运行中主按钮变 Stop ②独立 Stop（continuable 子会话）③**连按两次 Esc** | 主按钮：`stop?.()`；Esc 路由：`installStopShortcut` + `StopSequence.press` | `ui-conversation/src/client/skeleton/InputBar.tsx:323-342`、`:481-496`、`ui-conversation/src/client/stop-shortcut.ts:31-56`、`ui-conversation/src/client/stop-sequence.ts:38-51` |
| Esc 不生效的场景 | 有修饰键 / 输入法组合 / 在 modal / `[data-approval-key]`、`iframe`、`.xterm`、`[inert]` 内 / 无活动轮次 | 直接 reset，不消费 | `ui-conversation/src/client/stop-shortcut.ts:34-41`、`:46-54` |
| 发送 | `Enter`（`Shift+Enter` 换行；`Ctrl/Cmd+Enter` 走"加速投递"= steer/queue 的另一档） | `keyboard.submit(accelerated,'click')` → `session.prompt(content, mode, …)` | `ui-conversation/src/client/input/editor/keymap.ts:135-158`、`ui-conversation/src/client/service.ts:286` |
| 长按回车连发防护 | `event.repeat === true` 时不发 | 防连发 | `ui-conversation/src/client/input/editor/keymap.ts:154` |
| 输入法保护 | `isComposing` / `keyCode === 229` / composition 结束后 10ms 内不提交 | 中文输入不会误发 | `ui-conversation/src/client/input/editor/keymap.ts:48-52`、`:74-80`、`:142-146` |
| 粘贴文件/文本 | `PASTE_COMMAND`：文件 → `intakeFiles`；纯文本 → 走 sanitize 插入 | 目录成员识别用 `webkitGetAsEntry().isDirectory` | `ui-conversation/src/client/input/editor/keymap.ts:159-185` |
| 排队（busy 时发送） | 运行中且 steer 可用：普通 Enter 用**偏好档**（队列/插话），`Ctrl/Cmd+Enter` 用相反档；不可 steer 时一律 `'queue'` | `resolveSubmitMode(preferred, running, gesture, steeringAvailable)` | `ui-conversation/src/client/input/submission-policy.ts:30-39` |
| 队列整体插话 | 草稿为空 + 运行中 + 队列非空 → 占位符变 `t('placeholder.steerQueue')` | `canSteerQueue` 条件 | `ui-conversation/src/client/skeleton/InputBar.tsx:156-157`、`:370-372` |
| 跳到最新 | 不在底部时右下角出现按钮 `aria-label=t('chat.toBottom')` | `scroll.returnToBottom()`；跟随意图由 `ScrollFollow` 管 | `ui-chat/src/client/chat/ChatView.tsx:240-251`、`ui-chat/src/client/chat/use-scroll-follow.ts:138-158` |
| 跳到某个轮次 | 左侧/顶部 Turn rail（`TurnNavigator`），`items` 来自 snapshot 的 navigation + `turnOutline` 投影 | `onNavigate=scroll.navigateToTurn` | `ui-chat/src/client/chat/ChatView.tsx:75-82`、`:199-207` |
| 加载更早历史 | 顶部 `hasMore` 时按钮，文案 `t('chat.loadOlder')` / 载入中 `t('loading')` | `session.loadOlder()` | `ui-chat/src/client/chat/ChatView.tsx:219-225`、`ui-chat/src/client/apply.ts:272-273` |
| 压缩（compaction） | 自动压缩显示为 `compaction` 行，有摘要时可点开；`/compact` 显示为 `manual-compaction` | `node.summary !== null` 才 `expandable` | `ui-chat/src/client/chat/CompactionItem.tsx:39-40`、`:50-55`、`ui-chat/src/client/chat/CommandNodeView.tsx:27-40` |
| 工具卡展开 | 点整行（`expandOnRowClick`）；`preparing` 态不可展开 | 按 variant 渲染 terminal/diff/read/image/search/web/details/IO 卡 | `ui-tool/src/client/tool/components/ToolRow.tsx:170`、`:369-388` |
| 工具卡内跳转文件 | 摘要渲染成按钮/链接（记录路径或安全 http(s) URL） | `onOpenFile(path,{line})`；失败/中断时不给链接 | `ui-tool/src/client/tool/components/ToolRow.tsx:189-196`、`:213-232` |
| 工具卡"在轨迹里查看" | 展开体内 Inspect 按钮（**hover 出现**，见`inspectButton`） | `inspect()` 跳 trajectory 视图 | `ui-tool/src/client/tool/components/ToolRow.tsx:353-362`、`:91-95` |
| 命令面板选择 | `↑↓` 移动、`Enter`/`Tab` 接受、`Shift+Tab`/`Esc` 关闭；`←→` 保留搜索框光标；输入即本地过滤 | `popup.move/select/dismiss`；`filterOptions` | `ui-commands/src/client/PopupSelectView.tsx:97-132`、`:50-52` |
| 危险命令二次确认 | option 带 `confirmation` 时弹 `RiskConfirmation`（先勾选 → confirm） | `popup.acknowledge/confirm/cancelConfirmation` | `ui-commands/src/client/PopupSelectView.tsx:195-209`、`ui-commands/src/client/contract.ts:11-18`、`:45-46` |
| 触发菜单（`@` 文件引用 / `/` 命令） | 光标前扫描；`@` 走引用语法（可带引号跨空格），`/` 只在词边界（URL 里的 `/` 不算） | `detectTrigger(draft, caret, guard)`；guard 档位 `plain/claimed/frozen` | `ui-input-trigger/src/core/detect.ts:48-75`、`:20-30` |
| 触发菜单本身 | listbox + `aria-activedescendant`，**焦点留在输入框**，行用 `mousedown` 选择，`mousemove` 移动高亮 | 面板 max 400px，骨架两行 | `ui-input-trigger/src/client/MenuView.tsx:129-136`、`:154-178`、`:28`、`:147-153` |
| 触发菜单层级下钻 | 行尾 `drill` 提示 `t('drill.hint')` / `t('drill.key')`，`Tab` 下钻 | `onPick(source,index,'drill')` | `ui-input-trigger/src/client/MenuView.tsx:191-212` |
| 审批通过/拒绝 | 按钮 `t('allowOnce')` / `t('reject')`；键盘 `Enter` = 允许一次、`Esc` = 拒绝（全局快捷键 `approval.allow` / `approval.reject`） | `pending.answer('allowed-once'\|'rejected')`；提交中 `aria-busy` | `ui-approval/src/client/ApprovalPanel.tsx:36-58`、`:77-84`、`ui-approval/src/client/index.ts:82-85` |
| 提问回答 | 单选/多选按钮（`role=radio\|checkbox`、`aria-checked`）、自定义文本、逐题翻页、跳过、提交 | 草稿在 store 里按 `pending.key` 保存（`progressByRequest`） | `ui-user-questions/src/client/QuestionComposer.tsx:498-537`、`:183-195`、`:596-634` |
| 提问面板最小化/关闭 | 头部两个图标按钮：`aria-expanded` 的最小化、`t('nav.close'\|'nav.cancel')` 的关闭 | `minimized` 只留标题条；`data-question-key` | `ui-user-questions/src/client/QuestionComposer.tsx:465-483`、`:433-437` |
| 提问倒计时/让时间 | `t('wait.countdown'\|'wait.paused')` + `t('wait.takeTime')` 按钮 | `pending.takeTime()` / `pending.engage()` | `ui-user-questions/src/client/QuestionComposer.tsx:446-464` |
| 键盘提交单个选项 | 选项按钮上 `Enter` 直接提交全部草稿 | `submitDrafts(drafts)` | `ui-user-questions/src/client/QuestionComposer.tsx:511-515` |

---

## 三、数据契约：界面上的数字/状态来自哪

### 3.1 快照与节点（视图层读什么）

| 数据 | 类型/字段 | 证据 |
|---|---|---|
| Chat 快照 | `ChatSnapshot{order, nodes, locations, navigation, timeline, legacy}` | `ui-chat/src/client/contract/snapshot.ts:110-117` |
| 轮次导航项 | `TurnNavigationItem{turn, anchorKey, prompt, response}` | `ui-chat/src/client/contract/snapshot.ts:57-66` |
| 轮次过程可见性 | `ChatTurnProcessPresentation{turn, spec, turnStarted, turnClosed, hasExternalProcess, hasInterleavedInput, compactAnswer}` | `ui-chat/src/client/contract/snapshot.ts:88-98` |
| 统计/兼容切片 | `LegacyConversationSlice{nodes, turnTimings, turnEnds, partial, runningCalls}` | `ui-chat/src/client/contract/snapshot.ts:100-107` |
| 节点公共 owner | `ChatNodeOwnerProps{groupPart?, cwd?, openFile, inspectCall, forkAt, loadImage, fileMentions, turnProcess?}` | `ui-chat/src/client/contract/slots.ts:211-223` |
| 用户内容 | `UserContentData{text, attachments, extraBlocks, referenceLabels?}`；附件 `{type:'image',image} \| {type:'file',file}` | `ui-chat/src/client/contract/slots.ts:226-238` |
| 轮次过程 owner | `TurnProcessOwnerProps{hasContent, spec, foldable, open, setOpen}` | `ui-chat/src/client/contract/slots.ts:249-256` |
| 阅读位置 | `ChatScrollPosition{anchorKey, anchorTop, scrollTop}` | `ui-chat/src/client/contract/slots.ts:283-287` |

### 3.2 会话 store 字段（`useSession`）

| 字段 | 用途 | 证据 |
|---|---|---|
| `running` | 运行中/自动跟随/运行状态行 | `ui-chat/src/client/chat/ChatView.tsx:93`、`ui-chat/src/client/chat/ChatFlow.tsx:19` |
| `openState` | `'loading' \| 'open' \| 'error'` 三态决定历史加载 UI | `ui-chat/src/client/chat/ChatView.tsx:108`、`:187`、`:213-218` |
| `openError` | `{message, code}` | `ui-chat/src/client/chat/ChatView.tsx:109`、`:214-218` |
| `hasMore` / `loadingOlder` | 顶部"加载更早" | `ui-chat/src/client/chat/ChatView.tsx:110-111`、`:219-225` |
| `pendingSubmissions` | 本地回显（`placement` = `transcript`/`queued`/`steering`） | `ui-chat/src/client/chat/ChatView.tsx:151-176`、`ui-conversation/src/client/queue/QueueDock.tsx:107-122` |
| `promptError` | 发送/停止失败横幅 | `ui-conversation/src/client/skeleton/InputBar.tsx:63`、`:109-119` |
| `removed` / `subagent` | 决定输入是否锁死、Stop 是否独立可用 | `ui-conversation/src/client/skeleton/InputBar.tsx:64-66`、`:134-135` |

### 3.3 投影（`useProjection`）

| key（逐字） | 内容 | 用在哪 | 证据 |
|---|---|---|---|
| `'inbox'` | `InboxState`：`'next-turn'`（队列）、`'next-step'`（插话） | 队列码头、插话气泡 | `ui-chat/src/client/chat/ChatView.tsx:83`、`:147-150`、`ui-conversation/src/client/queue/QueueDock.tsx:106-113` |
| `'turnOutline'` | 全日志轮次大纲（快照导航不含投影值，合并发生在视图层） | Turn rail 合并 | `ui-chat/src/client/chat/ChatView.tsx:75-82` |
| `'sessionStats'` | `WindowStats`（turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens） | 输入区统计胶囊 | `ui-chat/src/client/chat/StatsPills.tsx:160-164` |
| `'tokenUsage'` | `TokenUsageProjection`（cacheRead/cacheWrite/uncached…） | 胶囊明细 | `ui-chat/src/client/chat/StatsPills.tsx:284`、`:108-120` |
| `'plan'` | 计划模式是否激活 | 占位符切换 | `ui-conversation/src/client/skeleton/InputBar.tsx:69` |
| `'goal'` | 是否已有目标（提示词消歧） | 占位符/提示 | `ui-conversation/src/client/skeleton/InputBar.tsx:71`、`:353-361` |
| `'imageLimits'` | `{mediaTypes, maxImagesPerMessage, maxImageBytes, maxMessageImageBytes}` | 选图前本地预检 | `ui-conversation/src/client/skeleton/InputBar.tsx:100`、`:220-235` |

### 3.4 Host 端点（本包内实际发起的调用）

| 动作 | 调用（逐字） | 证据 |
|---|---|---|
| 发送（队列模式） | `await session.prompt([{type:'text',text}], 'queue')` | `ui-conversation/src/client/service.ts:211` |
| 发送/插话（带附件） | `session.beginSubmission({mode,text,attachments,onRetire})` → `await session.prompt(content, mode, signal, submission.requestId)` | `ui-conversation/src/client/service.ts:268-286` |
| 队列变更 | `await session.updateQueue(itemId, action)`（`action.kind` ∈ `edit`/`remove`/`steer`） | `ui-conversation/src/client/service.ts:488-496`、`ui-conversation/src/client/queue/QueueDock.tsx:159-166`、`:288-312` |
| 停止 | `await session.cancel()` | `ui-conversation/src/client/service.ts:500-503` |
| 翻历史 | `session.loadOlder()` / `session.loadThrough(seq)` | `ui-chat/src/client/apply.ts:272-273` |
| 读附件图片 | `ctx.uiConversation.imageUrl(sessionId, attachment)`（+`peekImageUrl`） | `ui-chat/src/client/apply.ts:274-277` |
| 分支 | `ctx.sessions.fork({sessionId, atSeq, increaseTitle:true, onCreated})` | `ui-chat/src/client/apply.ts:285-295` |
| 打开文件 | `ctx.sidebarRight.openResource(url[,{params:{line}}])` | `ui-chat/src/client/apply.ts:258-263` |
| 执行命令 | `command.execute`（失败抛 `command.execute failed: <code>: <message>`） | `ui-commands/src/client/service.ts:391`、`:407` |
| 审批快捷键命令 | `approval.allow`（Enter）/ `approval.reject`（Esc） | `ui-approval/src/client/index.ts:82-85` |
| 会话历史图片（历史归档） | `entry.binding.session.readAttachment(attachment.attachmentId)` | `ui-conversation/src/client/conversation/historical-images.ts:108` |

### 3.5 展示策略（决定"折叠与否"的开关）

| 模式 | `foldCompletedTurns` | `stepGrouping` | `liveProcessDetail` | `settledReasoningPreview` | 证据 |
|---|---|---|---|---|---|
| `compact` | true | `collapsed` | false | false | `ui-chat/src/client/presentation-policy.ts:24-30` |
| `standard` | true | `collapsed` | true | true | `ui-chat/src/client/presentation-policy.ts:31-37` |
| `detailed` | true | `history` | true | true | `ui-chat/src/client/presentation-policy.ts:38-44` |
| `verbose` | false | `none` | false | true | `ui-chat/src/client/presentation-policy.ts:45-51` |
| 折叠时机 | `collapseTiming` ∈ `completion` / `next-input` | | | | `ui-chat/src/client/presentation-policy.ts:63-66`、`ui-chat/src/client/chat/ChatView.tsx:70` |

### 3.6 工具卡数据契约（`ui-tool`）

| 项 | 字段/取值（逐字） | 证据 |
|---|---|---|
| 卡片状态机 | `type ToolRowState = 'preparing' \| 'running' \| 'ok' \| 'error' \| 'stopped'` | `ui-tool/src/client/tool/models/tool-call-model.ts:19` |
| variant（决定用哪种卡） | `type ToolRowVariant = 'search' \| 'read' \| 'bash' \| 'write' \| 'edit' \| 'code' \| 'others'` | `ui-tool/src/client/tool/models/tool-call-model.ts:16` |
| 行模型 | `ToolRowModel{variant, titleKey, summary, filePath, bodyRaw, output, errorSummary, autoReviewDenial, state}` | `ui-tool/src/client/tool/models/tool-call-model.ts:143-163` |
| 摘要取键顺序 | `bash:['description','command']`、`read:['path','file_path','url']`、`search:['query','pattern','url']` … | `ui-tool/src/client/tool/models/tool-call-model.ts:216-219` |
| 结果文本展平 | `resultText(node)`：text 块原样、其他块 `JSON.stringify(block,null,2)`；空内容+error 时补 `name: code` | `ui-tool/src/client/tool/models/tool-call-model.ts:181-191` |
| 终端卡 | `TerminalCardModel.card` = `Pick<TerminalBlockProps,'cwd'\|'output'\|'exitCode'\|'signal'\|'running'\|'background'>`；`copy` = `{kind:'shell',command,description}` 或 `{kind:'terminal-send',text,sessionId}` | `ui-tool/src/client/tool/models/terminal-card-model.ts:42-55` |
| 终端失败判定 | `terminalFailed(model)`：非 running 且（`exitCode !== 0` 或 `signal` 存在）——bash 失败是**结果数据**，`isError` 仍是 false | `ui-tool/src/client/tool/models/terminal-card-model.ts:97-100` |
| diff 卡 | `DiffCardModel.card = Pick<DiffBlockProps,'diffs'>`；`CHAT_DIFF_MAX_LINES = 9` | `ui-tool/src/client/tool/models/diff-card-model.ts:8`、`:15-22` |
| 读文件卡 | `ReadCardModel = Pick<ReadBlockProps,'label'\|'lines'\|'totalLines'\|'lang'>` | `ui-tool/src/client/tool/models/read-card-model.ts:24` |
| 搜索卡 | `SearchCardModel{card, recovery}`；`CHAT_SEARCH_MAX_LINES = 8` | `ui-tool/src/client/tool/models/search-card-model.ts:12`、`:15-20` |
| 网页卡 | `WebCardModelProps = Omit<WebBlockProps,'labels'\|'className'>`；来源项 `{url,title?,snippet?,publishedAt?}` | `ui-tool/src/client/tool/models/web-card-model.ts:9`、`:26-31` |
| 图片卡 | `ImageCardModel{path, images:[{attachment}], extraText}`（字节不在模型里，靠 `attachmentId` 授权解析） | `ui-tool/src/client/tool/models/image-card-model.ts:14-26` |
| 详情卡（todo/goal/schedule） | `todosDetail`：`todo.status` ∈ `'completed'\|'in_progress'\|'pending'` | `ui-tool/src/client/tool/models/details-card-model.ts:33-44` |
| 提问转录卡 | `AskQuestionCardModel` = `{kind:'answered', questions:[{id,question,answers}], skippedLabel}` \| `{kind:'unanswered', questions:[{id,question}], verdict}` | `ui-tool/src/client/tool/models/ask-question-card-model.ts:15-25` |
| 展开体互斥选择 | `card = askQuestion ?? terminal ?? diff ?? read ?? image ?? search ?? web ?? details`（同一时刻只渲染一种） | `ui-tool/src/client/tool/components/ToolRow.tsx:169` |

### 3.7 审批 / 提问 / 命令面板字段

| 面板 | 字段/取值（逐字） | 证据 |
|---|---|---|
| 审批请求 | `ApprovalPresentationRequest{toolName, callId?, reason?, displayReason?, signal?}` | `ui-approval/src/client/contract/slots.ts:52-63` |
| 审批决定 | `type ApprovalDecision = 'allowed-once' \| 'rejected'` | `ui-approval/src/client/contract/slots.ts:66` |
| 待审批对象 | `PendingApproval{kind:'approval', key, toolName, callId?, reason?, displayReason?, result}`；`answerable` = 未结算 | `ui-approval/src/client/contract/slots.ts:74-89`、`:130-132` |
| 审批面板状态 | `answered`、`waiting`、`active`、`composing`、`compositionEnded`（防 IME 误判） | `ui-approval/src/client/ApprovalPanel.tsx:27-31`、`:55-57` |
| 提问卡片快照 | `QuestionCardSnapshot{state, waitState:'counting'\|'focused'\|'editing'\|'waiting'\|'continued', countdown?:{remainingMs,running}, channel:'waterfall'\|'rpc'\|'none', closed}` | `ui-user-questions/src/client/contract/slots.ts:204-218` |
| 待提问对象 | `PendingQuestion{kind:'question'\|'plan-review', key, sessionId, questions, callId?, review?, dismissal:'hide'\|'cancel'}` | `ui-user-questions/src/client/contract/slots.ts:226-250` |
| 提问草稿 | 按 `pending.key` 存在 store 的 `progressByRequest`：`{index, drafts[], wait?}`；`drafts` 与题目 1:1 | `ui-user-questions/src/client/QuestionComposer.tsx:183-195`、`:245-251` |
| 单选题选项 | `question.options[{label, description?}]`；推荐项从 label 前缀解析（`parseRecommendedLabel`） | `ui-user-questions/src/client/QuestionComposer.tsx:35-41`、`:499-535` |
| 命令弹窗选项 | `SelectOption{id, label, badge?, detail?, group?, active?, confirmation?}` | `ui-commands/src/client/contract.ts:30-47` |
| 弹窗规格 | `PopupSelectSpec{kind:'popupSelect', searchMode?:'substring'\|'fuzzy-label', searchLabels?(), options(session,signal), onSelect(option,session)}` | `ui-commands/src/client/contract.ts:64-75` |
| 命令注册 | `CommandContribution{name, label?(), description?(), icon?, available(session), ui}`；`CommandDecoration` 只改裸调用的 UI | `ui-commands/src/client/contract.ts:101-114`、`:125-132` |
| 命令弹窗状态 | `status: 'pending'\|'ready'\|'failed'`、`error`、`submitting`、`confirming`、`acknowledged`、`search`、`active`、`options` | `ui-commands/src/client/PopupSelectView.tsx:50-52`、`:173-192` |

---

## 四、空态 / 加载态 / 错误态（具体到组件与文案 key）

### 4.1 空态

| 场景 | 表现 | 证据 |
|---|---|---|
| 没有任何消息（新会话/空白会话） | 判定：`hero = sessionId === undefined \|\| (shellPhase === 'blank' && (openState === 'open' \|\| summaryBlank === true))`；`phase` 三态 `settling/hero/active` 打在根 `data-phase` 上 | `ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:37-46` |
| Hero 主体 | `HeroShell`：34px 鲸鱼（hover 会游动，`prefers-reduced-motion` 时静止）+ 标题 `t('hero.headline')` + 预览徽标 `t('hero.preview')`；**输入区仍然挂在树里**（`composerStack` 里同时渲染 `HeroShell` + `heroWorkspaceRow` + 输入区，只是 `variant='hero'`） | `ui-conversation/src/client/skeleton/EmptyHero.tsx:132-164`、`:100-125`、`ui-conversation/src/client/skeleton/ConversationContent.tsx:164-171`、`:147-148` |
| Hero 的工作区行 | `WorkspaceChip`（`aria-haspopup=menu`，无工作区时文案 `t('hero.chooseWorkspace')`） | `ui-conversation/src/client/skeleton/EmptyHero.tsx:38-62` |
| Hero 占位符 | `t('placeholder.hero')`；无工作区时 `t('placeholder.workspace')` 且输入区 `inert` | `ui-conversation/src/client/skeleton/ConversationContent.tsx:142-162` |
| 无会话（冷启动） | 输入区仍渲染同一 DOM，只是 `disabled`：`disabled = removed \|\| inert \|\| !live \|\| blocked !== undefined \|\| parentOffline` | `ui-conversation/src/client/skeleton/InputBar.tsx:140` |
| 队列为空 | `QueueDock` 直接 `return null` | `ui-conversation/src/client/queue/QueueDock.tsx:136` |

### 4.2 加载态

| 场景 | 表现 | 证据 |
|---|---|---|
| 历史加载中 | 流顶部一行 `t('chat.loadingHistory')` | `ui-chat/src/client/chat/ChatView.tsx:213` |
| 翻更早历史中 | 按钮文案切到 `t('loading')` 且 `disabled` | `ui-chat/src/client/chat/ChatView.tsx:221-223` |
| 会话仍在回放（loading+blank 且摘要未知） | `phase = 'settling'`：输入区被隐藏，避免 hero↔docked 闪跳 | `ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:37-40` |
| 助手流式中 | ①`AssistantMarkdown` 根 `data-streaming` ②摘要 `TextShimmer`（思考/工具摘要/运行状态）③列表尾部 `RunningStatus`（鲸尾 + "深潜中 Xs"） | `ui-chat/src/client/chat/AssistantMarkdown.tsx:146`、`ui-chat/src/client/chat/ReasoningRow.tsx:65`、`ui-chat/src/client/chat/RunningStatus.tsx:31-39` |
| 工具准备中/运行中 | `ToolRowState`：`preparing`（不可展开）→ `running`；行内 `TextShimmer` 摘要 + 视觉隐藏状态文案 `t('row.preparing'\|'row.running')` | `ui-tool/src/client/tool/models/tool-call-model.ts:19`、`ui-tool/src/client/tool/components/ToolRow.tsx:104-112`、`:170` |
| 斜杠菜单候选加载 | 该 group `status === 'pending'` 且无条目时渲染两行骨架（`role="status"` + `aria-label=t('loading')`） | `ui-input-trigger/src/client/MenuView.tsx:147-153` |
| 命令面板加载 | `state.status === 'pending'` → `t('status.loading')`；提交中 → `t('status.applying')` | `ui-commands/src/client/PopupSelectView.tsx:181-182` |

### 4.3 错误态

| 场景 | 表现（含文案 key） | 证据 |
|---|---|---|
| 历史打开失败 | 顶部红条：`t('chat.loadError', {message, code})` | `ui-chat/src/client/chat/ChatView.tsx:214-218` |
| 打开文件被拒（Host 拒绝） | `Modal`：`t('fileOpen.title')` + 原因 + 按钮 `t('cancel')` / `t('retry')`，可重试同一路径 | `ui-chat/src/client/chat/ChatView.tsx:252-260`、`:266-289` |
| 发送/停止失败 | 输入区 Toast（`IconWarningOutlineRegular`，`seq` 决定重挂载）；`session/writer-held` → `t('error.sessionInUse')`；附件被拒 → `attachmentErrorText(...)`；其他 → `<message> (<code>)` | `ui-conversation/src/client/skeleton/InputBar.tsx:376-384`、`:109-119`、`:120-122` |
| 轮次级失败 | `turn-error` 行：`StateDot state="error"` + 标题（`ACCOUNT_SIGNED_OUT`/`INTERRUPTED` → `t('message.taskStopped')`，否则 `t('message.turnError')`）+ 原因 + `<code>` 错误码（`INTERRUPTED` 不显示码） | `ui-chat/src/client/chat/MessageItem.tsx:136-146` |
| 失败原因本地化（逐字 code） | `ACCOUNT_SIGNED_OUT` / `INTERRUPTED` / `ACCOUNT_SIGN_IN_REQUIRED` / `QUOTA` / `ACCOUNT_QUOTA` / `AUTH` → 对应 `t('message.failure.*')` | `ui-chat/src/client/chat/MessageItem.tsx:51-61` |
| 输出被 max tokens 截断 | `turn-max-tokens` 行：`StateDot state="warning"` + `t('message.maxTokens')` + `t('message.maxTokens.hint')` | `ui-chat/src/client/chat/MessageItem.tsx:149-161` |
| 工具失败 | 行 `data-state="error"`；摘要变成结果首行（否则整行红）；`settledWithCue` 时不显示 suffix/diff 总数/文件链接；展开体输出 `data-error` | `ui-tool/src/client/tool/components/ToolRow.tsx:177-183`、`:186-196`、`:236-243`、`:344` |
| 命令行失败 | `GenericCommandCard`：`outcome.kind === 'error'` → `t('command.failed')`；`data-state=error` + 视觉隐藏 `t('row.failed')` | `ui-chat/src/client/chat/GenericCommandCard.tsx:12-15`、`:33-34`、`:55-57` |
| 自动审批拒绝（AutoReview） | `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` 被识别成结构化 denial（带 `reason`，非字符串降级为无理由） | `ui-tool/src/client/tool/models/tool-call-model.ts:165-172` |
| 命令面板加载失败 | 面板内 `role="alert"` 错误条 + `t('retry')` 按钮（仅 `status==='failed'`） | `ui-commands/src/client/PopupSelectView.tsx:173-180` |
| 触发菜单某源加载失败 | 未找到独立失败行；只有 pending 骨架与 ready 空态（`group.items.length === 0` 直接不渲染） | `ui-input-trigger/src/client/MenuView.tsx:137-138` |
| 提问面板失败/被接管 | footer `role="status"` 反馈；`card.state === 'continued'` 时重挂载并提示 `t('error.resubmit')` | `ui-user-questions/src/client/QuestionComposer.tsx:614-616`、`:208-214` |
| 提问等待/被暂扣 | `t('wait.held')`（focused/editing）、`t('wait.continued')`；review 卡显示 `t('review.status')` | `ui-user-questions/src/client/QuestionComposer.tsx:458-464` |
| 审批提交中 | 卡片 `aria-busy`，两按钮 `disabled`，状态点由 `warning` 变 `ongoing` | `ui-approval/src/client/ApprovalPanel.tsx:60-66`、`:77-84` |
| 配额 | 全局 notice 链（`shell.quota-notice`），`QUOTA`/`ACCOUNT_QUOTA` 两个码 | `ui-chat/src/client/contract/slots.ts:67-76`、`:442-449` |

---

## 五、移动端必须换做法的部分（依赖 hover / 宽屏 / 快捷键）

| 桌面机制 | 为什么手机不能用 | 证据 | 手机建议 |
|---|---|---|---|
| 消息动作行**悬浮才出现**（`@media (hover: hover)` 里 `opacity: 0`，hover/focus-within 才 1） | 触屏没有 hover；代码只保证"没有 hover 的设备保持常显"，并没有给出长按/菜单式入口 | `ui-chat/src/client/chat/MessageIconActions.module.css:39-61` | 默认常显（低对比）；或长按气泡弹出动作面板；桌面 hover 只是增强 |
| "不可用按钮"靠 **hover Tooltip** 解释原因 | 禁用态按钮在触屏无法触发 Tooltip | `ui-chat/src/client/chat/MessageIconActions.module.css:94-103`、`ui-chat/src/client/chat/MessageIconActions.tsx:92-100` | 点按弹出同样说明（或直接行内小字） |
| 工具卡 **Inspect 按钮 hover 出现** | 同上 | `ui-tool/src/client/tool/components/ToolRow.tsx:91-95`、`:353-362` | 放进工具卡的常显动作条 |
| 轮次尾巴动作 `data-actions-reveal="hover"` | 同上 | `ui-chat/src/client/chat/TurnTailNodeView.tsx:61` | 常显 / 点按展开 |
| 会话内容**宽度拖拽手柄**（指针捕获，记忆 `dsh.conversation.contentWidth`，默认 clamp 680–920px） | 手机没有可拖的空白侧栏，宽度由屏幕决定 | `ui-conversation/src/client/skeleton/ConversationWidthControls.tsx:6`、`:24-27`、`:41`、`:64-95` | 不做；改为字号/行距档位 |
| 轨迹视图是**宽表格 + 侧栏详情** | ≤760px 才把详情变成覆盖抽屉，仍是"表格思维" | `ui-trajectory/src/client/TrajectoryTable.module.css:1972-1983` | 手机上换"时间线列表 + 单条详情页"，不要横向表格 |
| 统计胶囊在窄屏才**砍掉文字只留图标**（≤480px） | 手机宽度几乎总在这个阈值内 → 只剩图标，信息密度低 | `ui-chat/src/client/chat/TurnUsagePanel.module.css:55-68` | 改成一行可点的摘要（如 `12.3k tok · 45s`）+ 点击开详情 |
| 提问面板窄屏(≤720px)只是把内边距/字号收一收 | 一屏一题 + 分页在手机上仍偏挤 | `ui-user-questions/src/client/QuestionComposer.module.css:445-469` | 全屏 sheet、一屏一题、底部固定"下一题/提交" |
| 快捷键：`Enter` 发送、`Shift+Enter` 换行、`Ctrl/Cmd+Enter` 加速投递 | 手机软键盘没有这些修饰键；`Enter` 语义变成"换行"更自然 | `ui-conversation/src/client/input/editor/keymap.ts:135-158`、`ui-conversation/src/client/input/submission-policy.ts:30-39` | 显式发送按钮 + 键盘上方的"换行/发送"开关；"插话 vs 排队"用按钮而不是 Ctrl |
| `Esc` **连按两次**停止 | 触屏没有 Esc | `ui-conversation/src/client/stop-shortcut.ts:34`、`ui-conversation/src/client/stop-sequence.ts:38-51` | 保留大号 Stop 按钮（桌面版也有：`primaryStops` 让主按钮在运行中变 Stop，`ui-conversation/src/client/skeleton/InputBar.tsx:323`） |
| 审批 `Enter`/`Esc` 快捷键 | 同 | `ui-approval/src/client/index.ts:82-85` | 两个大按钮（桌面版本来也有），快捷键可省 |
| 命令面板/触发菜单的 `↑↓ Tab Enter ←→` 全键盘导航 | 手机是触摸选择 | `ui-commands/src/client/PopupSelectView.tsx:97-132`、`ui-input-trigger/src/client/MenuView.tsx:191-212` | 列表点击选择；保留"点外部关闭" |
| 触发菜单用 `mouseMove` 移动高亮、`mousedown` 选择（专门为"焦点不离开 textarea"设计） | 触屏没有 mousemove，长按会变选择文本 | `ui-input-trigger/src/client/MenuView.tsx:154-178` | 用 click/tap；防止长按选中 |
| 斜杠菜单 `Tab` 下钻、`drill` 提示 | 触屏无 Tab | `ui-input-trigger/src/client/MenuView.tsx:191-212` | 行尾 chevron 直接点 |

> **需要澄清的一点**：桌面版**没有**"正文尾部闪烁光标"。它的流式反馈是 `data-streaming` + `TextShimmer` + 底部秒表（见 1.3 表第 16 行与 §4.2）。移动端若想要光标，是**新增设计**，不是复刻。

---

## 六、移动端最该优先复刻的 3 件事（含难点）

### ① 整轮过程收束（`turn-process` 控制行）—— 直接解决"8 张工具卡淹没屏幕"

| 要做的事 | 证据 |
|---|---|
| 在一轮的开始放一行控制行："工作了 / 用时 Xs" + chevron，默认**折叠**该轮所有思考与工具行 | `ui-chat/src/client/chat/TurnProcessNodeView.tsx:19`、`:27-30`、`:52-58` |
| 行上带 `messageCount` / `toolCallCount` / `subagentCount`，可显示"3 次工具 · 1 个子代理" | `ui-chat/src/client/chat/TurnProcessNodeView.tsx:42-44`、`ui-chat/src/client/contract/chat-nodes.ts:113-116` |
| 折叠规则：运行中 / 被中断 / 出错 / 有插话输入时**必须常开** | `ui-chat/src/client/contract/turn-process.ts:53-57`、`ui-chat/src/client/chat/ChatNodeSeat.tsx:62-65` |
| 用户点开→记住状态（桌面用 `turnProcessOpen(state, spec, …)`；移动端可本地持久化） | `ui-chat/src/client/chat/ChatNodeSeat.tsx:60-70` |

**难点**：需要把"本轮属于哪些节点"算出来（桌面有 `TurnProcessSpec.processStartSeq/answerAnchorSeq/answerStep`，`ui-chat/src/client/contract/turn-process.ts:4-18`）。移动端目前拿到的是扁平事件列表，至少要能按 `turn` 归组，并区分"正文回答"与"过程"。这是**数据层改造**，不是纯样式。

### ② 超长消息 / 长工具的收束与折叠（含"思考摘要单行"）

| 要做的事 | 证据 |
|---|---|
| 思考默认折叠，折叠态只显示一行摘要（运行中取最后一个已完成段落首行） | `ui-chat/src/client/chat/ReasoningRow.tsx:55-59`、`:16-32` |
| 工具卡默认折叠；`preparing` 不可展开；展开体按类型分卡（终端/ diff / 读文件 / 搜索 / 网页 / 详情 / IO） | `ui-tool/src/client/tool/components/ToolRow.tsx:170`、`:254-352` |
| diff 只留 9 行、搜索只留 8 行（超过折叠，不是直接截断丢失） | `ui-tool/src/client/tool/models/diff-card-model.ts:8`、`ui-tool/src/client/tool/models/search-card-model.ts:12` |
| IO 卡只在展开时格式化原始入参（`formatToolBody`），避免大 JSON 进 DOM | `ui-tool/src/client/tool/components/ToolRow.tsx:172-175` |

**难点**：截断策略必须"可恢复"——桌面版所有截断都有展开入口，且 `maxLines={Infinity}` 只在终端卡里用（`ui-tool/src/client/tool/components/ToolRow.tsx:262`）。移动端若只做 CSS 截断而没有"展开全部"，会把信息吃掉（这正是我们上一轮踩过的坑）。

### ③ 输入区三态：运行中不锁死 + 主按钮变 Stop + 排队/插话

| 要做的事 | 证据 |
|---|---|
| 输入框**不因 running 锁死**：`locked` 只看 removed/inert/无会话/被 block/父离线 | `ui-conversation/src/client/skeleton/InputBar.tsx:136-154` |
| 运行中且草稿为空 → 主按钮变成 **Stop**；有草稿 → 主按钮是发送（`input.send.queue` / `input.send.steer`） | `ui-conversation/src/client/skeleton/InputBar.tsx:323-333` |
| 运行中发送 = 入队（`session.prompt(..., 'queue')`），"插话"是**另一个动作**（`kind:'steer'`） | `ui-conversation/src/client/service.ts:211`、`ui-conversation/src/client/queue/QueueDock.tsx:299-316` |
| 队列行提供编辑 / 删除 / 插话三动作，且"插话"只在 running 可用 | `ui-conversation/src/client/queue/QueueDock.tsx:236-319` |
| 排队项草稿/失败必须能恢复：`promptError` 横幅 + 草稿保留 | `ui-conversation/src/client/input/hub.ts:231`、`ui-conversation/src/client/skeleton/InputBar.tsx:109-119` |

**难点**：`queue` 与 `steer` 的语义差异必须由**后端支持**（移动端现在只发了 queue 模式）。另外队列是 Host 权威数据（`inbox` 投影 + `pendingSubmissions` 本地回显要**去重合并**，桌面版用 `requestId` 对齐，见 `ui-chat/src/client/chat/ChatView.tsx:162-176`），手机端若只维护本地数组会出现"队列项闪两份"。

---

## 附：ui-trajectory 速览（与本轮移动端目标关系较远，仅记录已验证事实）

| 事实 | 证据 |
|---|---|
| 轨迹视图 = 摘要 + 逐轮事件账本，包含表格、时间线、工具栏三块 | `ui-trajectory/src/client/TrajectoryView.tsx:1`、`:11-17` |
| 工具栏状态：`actualDuration` / `actualTime` / `allTurnsCollapsed` / `allAssistantsCollapsed` / `searchQuery`，整体是 `role="toolbar"` | `ui-trajectory/src/client/TrajectoryToolbar.tsx:8-31`、`:52` |
| 搜索索引有 3s 节流；历史分页每页 50 个节点 | `ui-trajectory/src/client/TrajectoryView.tsx:34-35` |
| ≤760px 时详情面板变成右侧覆盖抽屉（宽 `min(92%,420px)`） | `ui-trajectory/src/client/TrajectoryTable.module.css:1972-1983` |