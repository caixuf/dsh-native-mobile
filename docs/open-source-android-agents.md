# 开源 AI Agent 客户端源码研读（Android 为主）

> 日期：2026-10-13 · 目的：**读真实源码**（不是读文档/README），为 DSH 移动端找可落地的设计
> 方法：`git clone --depth 1`，逐文件读，结论带 `文件:行号`
> ⚠️ 本文件经过一次**自我更正**：初版只看了几个 1–8★ 的小项目，后经穷举搜索找到真正高星、
> 形态更接近的项目（见 §1）。**初版的仓库排序是错的，以本版为准。**
>
> **克隆产物位置**：`C:\Users\me\Downloads\oss-study\`（**工作区之外** —— 原因见 §4.1）。
> 共 8 个仓库、313 MB。`conch-report.md` 是子代理产出的完整深读报告（未进仓库）。

---

## 0. 两个必须先说清的事实

### 0.1 MiniMax 的安卓端**没有开源**

上一版 `minimax-code-study.md` 是从**官方文档 + 截图 + 商店页**推的（当时已标注"移动端 UI 未能核实"）。这次去 GitHub 核实：

| 仓库 | 实测事实（`api.github.com`） |
|---|---|
| [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | **2025 stars**、MIT、`"language":"TypeScript"`、size 30 MB、topics `["coding-agents","harness","minimax"]`。描述是 "An open-source coding agent for **your terminal**"。**只有 CLI/TUI/headless/ACP，无任何 Kotlin/Gradle/Android 目录。** |

**结论：MiniMax Code 的安卓端闭源，学不到源码。** 想要移动端设计参考，只能看下面这些。

### 0.2 小米 / 字节 / NousResearch **都没有开源原生移动端**

穷举核查（来自独立子代理，含具体边界）：

| 对象 | 核查范围 | 结论 |
|---|---|---|
| **小米** | `Xiaomi`(84 仓库)、`MiCode`(80)、`XiaomiMIUI`(1，空)、`xiaomi-hyperos`(2，仅解锁工具)；关键词 `superassistant`/`XiaoAi`/`MiAI` **零命中** | **从未开源任何 AI 助手/Agent 客户端**。AI 相关仓库全是服务端/模型/引擎（`mace` 5053★ 推理引擎、`ha_xiaomi_home` 22191★ HA 集成）。超级小爱、小爱同学均闭源 |
| **字节** | `bytedance` **420 个仓库全量扫描** | **无开源移动 App**。`UI-TARS`(11591★, Python) 只有模型训练代码；`UI-TARS-desktop`(39254★, TS) 是**跑在电脑上的 Node 库，通过 ADB 控制手机**，不是手机 App。`Doubao`/`Coze`/`Trae` 客户端/`MarsCode`/`ByteDance-Seed` **均 404** |
| **NousResearch** | `hermes-agent`(253223★, Python, MIT) 全树 19556 条目 | **无 android/ios/gradle 目录**。官方 Android 支持 = **Termux 里跑 TUI**，不是原生 App |

**字节唯一值得看的东西**：`UI-TARS-desktop` 的 `multimodal/gui-agent/operator-adb/src/AdbOperator.ts`（Apache-2.0）—— 归一化坐标换算、**截图三级降级**（appium → `shell screencap` → YADB）、中文输入判定 `/[\p{Script=Han}]/u` 后转 YADB、KeyCode 映射（home=3/back=4/enter=66）。**若将来要做 GUI Agent（让 Agent 操作手机），这是最佳工程参考。**

---

## 1. 真正值得读的仓库（按可学价值排序）

| 仓库 | Stars | 许可 | 语言 | 为什么值得看 |
|---|---|---|---|---|
| [Codename-11/hermes-relay](https://github.com/Codename-11/hermes-relay) | 339 | **MIT** | Kotlin | ⭐⭐⭐⭐⭐ **形态与我们几乎一样**：Kotlin/Compose 原生 App 连**自建网关**，OkHttp（非 Ktor）+ kotlinx.serialization。`docs/` 有 **340 KB `decisions.md`** + `gateway-contract-testing.md`。**许可最干净，首选** |
| [AAswordman/Operit](https://github.com/AAswordman/Operit) | 8616 | LGPL-3.0 | Kotlin | Android Agent，工具调用 + **权限模型 Allow/Ask/Deny** + Shizuku + 无障碍 |
| [rikkahub/rikkahub](https://github.com/rikkahub/rikkahub) | 8157 | **AGPL-3.0**（传染） | Kotlin | Compose 多 LLM provider + **MCP 客户端**。注意 AGPL |
| [google-ai-edge/gallery](https://github.com/google-ai-edge/gallery) | 24940 | Apache-2.0 | Kotlin | Google 官方端侧模型 App。有 `skills/`（可插拔 Agent Skills）与 `mcp/` 目录 |
| [nikitaeight24family/Conch](https://github.com/nikitaeight24family/Conch) | 7 | NOASSERTION | Kotlin | 连自有服务器的 Agent 客户端，10 种 CLI 适配。**115k 行 + 1239 个 @Test**，工程深度惊人 |
| [hiylo/starburst](https://github.com/hiylo/starburst) | 8 | NOASSERTION | Kotlin | 独立 `SseClient.kt`(38 KB) + `SseFrameDecoder.kt` |
| [traveler3022/Hermes-Pocket](https://github.com/traveler3022/Hermes-Pocket) | 1 | GPL-3.0 | Kotlin | **PKCE + 单次 WS 票据**、seq 丢帧检测、`IncrementalMdParser` |
| [Jilazem/Hermes-Mobil](https://github.com/Jilazem/Hermes-Mobil) | 5 | **MIT** | Kotlin | 离线 outbox、`DiagLog` 写入即脱敏 |
| [soul99soul-glitch/opencode-android](https://github.com/soul99soul-glitch/opencode-android) | 7 | 无 | Kotlin | 内嵌 runtime 进程管理（端口守卫、DNS、配置写入） |

> 诚实声明：`hermes-relay` 是唯一一个**高星 + MIT + 形态对口**的；`Conch`/`starburst` 星数很低但**工程深度远超星数**（1239 个测试）。星数不代表质量，下面结论都以**源码**为准。

---

## 2. 最高价值的 8 条（按可落地性排序）

### 2.1 🔴 所有权边界：**运行时 id 只是别名，永远不是 owner**

**来源**：`hermes-relay/.../data/SessionActivityRegistry.kt:5-24`

```kotlin
/** Stable ownership boundary for live activity. Runtime ids are aliases, never owners. */
data class SessionActivityOwner private constructor(
    val connectionId: String,
    val profile: String,
    val storedSessionId: String,
) {
    companion object {
        fun of(connectionId: String, profile: String, storedSessionId: String) = ...
            .also { require(it.connectionId.isNotEmpty()); require(it.profile.isNotEmpty()); ... }
    }
}
```

**为什么命中我们**：我们刚被这个问题咬过 —— 会话列表里 44 条 subagent 会话用**裸 sessionId 打不开**，而 1 条 `session.fork` 出来的普通会话**带 `parentSessionId` 却能打开**。我当时先按 id 前缀判、再按 `parentSessionId` 判，**两次都错**，最后靠逐条实测才发现只有 `origin == "subagent"` 是充要条件。

**这条设计原则的价值**：它把「**这个活动归谁**」提升为**显式的、带校验的、构造时 require 非空**的值对象，而不是散落各处的字符串比较。DSH 的对应物是 `address: {kind:'session'|'subagent', sessionId|parentSessionId}` —— **这正是主机自己在用的建模**（我们实测过 `session/page` 的 `address` 形状）。

**落地**：定义 `SessionOwner(connectionId, profile, storedSessionId)`，`require` 非空；`SessionRow` 只存 owner 而不是裸 id；打开会话时**只能**从 owner 构造 address。这样"拿错 id 去打开"在类型层面就不可能。

---

### 2.2 🔴 证据带**代际号（generation）**，过期证据不得覆盖新状态

**来源**：`hermes-relay/.../data/SessionActivityRegistry.kt:56-70`

```kotlin
enum class SessionActivityEvidenceSource {
    Directory, LocalSend, ActiveList, SessionEvent, PendingInput, Terminal, Checkpoint, Process,
}

data class SessionActivityEvidence(
    val source: SessionActivityEvidenceSource,
    val generation: Long,        // ← 代际号
    val observedAtMillis: Long,
    ...
)
```

**两个可直接抄的设计**：
1. **证据带来源**（`source`）：同一个"这个会话在跑"的结论，可能来自目录列举、本地发送、事件流、进程探测……**来源不同，可信度与新鲜度都不同**。我们目前 `LinkState.Ready` 是单一布尔，把所有来源混成一个结论。
2. **证据带代际号**：旧代际的迟到证据**不得**覆盖新代际状态。这正是 Conch 用 `turnSeq` 解决的同一类 bug（见 2.3）。

**落地**：`ChatViewModel` 的 `running` 状态改为 `(phase, source, generation)`；每次重连 `generation++`；所有异步回调先比代际再改状态。

---

### 2.3 🔴 turn 代际号 + **单一终局权威**

**来源**：`Conch/.../AgentSessionPersistentStream.kt:930-956`（代际判定）与 `:883-915`（终局权威）

Conch 的注释复盘了两个经典 bug：
- **旧 reader 迟到事件污染新 turn**：teardown 后旧 reader 仍阻塞在 `readLine`，其 `finally` 用 `myGen == turnSeq` 判定归属，**孤儿 reader 不得 complete 新 turn 的 deferred**。
- **spinner 不灭**：UI 曾二次用子串判断 turn 是否结束，导致状态机与 UI 判断不一致。修法是**只认解析器产出的 `TurnEnd`**，UI 不做二次猜测。

**为什么命中我们**：我们的 `ChatViewModel.startPolling()` 里 `lastSeq` 是**裸 Long**，`reload()` 与轮询都能改它；`detectRunning(page)` 靠遍历 records 里有没有 `turn/start`/`turn/end` 来猜运行态 —— **这正是"UI 二次猜测"的形态**。

**落地**：
- 加 `turnSeq: Long`，每次 `open()`/重连 `++`；轮询回调先比代际；
- `running` 只由**最后一个 `turn/end` 或 `turn/start` 事件**决定，不用"遍历全部 records 求和"。

---

### 2.4 🔴 同一份列表请求必须**单飞（single-flight）**

**来源**：`Conch/.../agent/ListingSingleFlight.kt:1-71`

```kotlin
/**
 * MEASURED on the user's phone (2026-08-27): a refresh landed while the first
 * pass was still streaming and the server showed two `bash -lc` pipelines of
 * the same script running at 18 and 13 minutes, splitting a link already down
 * to ~20 KB/s between them. The second pass did not make the list arrive
 * sooner — it halved the speed of the one that was already in flight.
 */
```

**为什么命中我们**：我们有**四个**并发调用点可能在同一秒打同一份 `session/list` —— `SessionsScreen` 的 `LaunchedEffect`、顶栏刷新按钮、`ChatViewModel` 的 3s 轮询、`AppViewModel.refresh()`。而我们的链路是**公网 FRP 隧道**，比 Conch 的场景更窄。

**落地**：加 `ListingSingleFlight.run(key="session/list") { ... }`。注意它的**取消语义**（`:45-53`）：leader 被取消时 follower 拿**空列表**而不是跟着被取消 —— 这是缓存刷新路径，下一拍会再来。

---

### 2.5 🔴 流式 markdown 必须**防抖 + 挪出主线程 + 增量解析**

**来源 A（防抖）**：`Conch/.../ui/screens/ChatMessageLines.kt:687-738`

```kotlin
// The old `remember(text) { lightMarkdown(text) }` re-parsed the ENTIRE message
// from scratch on every prompt-byte (Claude streams ~50-100 tokens/sec → 50-100
// full reparses per second on the main thread). For a 2000-char reply that's
// millions of regex ops, all running on the UI thread, all hot.
val streamed by produceState(initialValue = ..., text, codeBg, codeFg) {
    markdownCache.get(mdKey)?.let { value = it; return@produceState }
    delay(120L)                                                          // 防抖
    val parsed = withContext(Dispatchers.Default) { lightMarkdown(...) } // 挪出主线程
    markdownCache.put(mdKey, parsed); value = parsed
}
```

**来源 B（增量解析，更优）**：`Hermes-Pocket/.../HermesMarkdownParser.kt:60-98` 的 `IncrementalMdParser` —— **只重解析最后一个空行之后的尾部**（且该空行不在未闭合代码块内），把流式重解析从 O(n²) 降到 O(n)。

**来源 C（分层）**：Conch 的做法是**聊天行用手写轻量渲染，完整 markdown 渲染器只给全屏 viewer**（`ChatMessageLines.kt:1120,1187`）。markdown 库选型：`com.mikepenz:multiplatform-markdown-renderer-android:0.27.0`（`Conch/gradle/libs.versions.toml`）。

**为什么命中我们**：我们目前是**手写 `JsonRender` + 纯 `Text()`**，没有 markdown；一旦加代码块/表格就会撞上这个性能悬崖。而且我们**每 3s 轮询一次全量 `session.page`**（实测单次 468 KB / 147 条），重渲染压力比 Conch 更大。

**落地顺序**：先做 2.6 的消息模型（否则 markdown 渲染的是平铺噪音），再加渲染。

---

### 2.6 🔴 消息模型用 sealed interface，UI **永远看不到原始 JSON**；进度事件按稳定 id **原地更新**

**来源**：`Conch/.../agent/AgentMessage.kt:1-75`

```kotlin
/**
 * Cross-CLI normalized view of one event from a chat stream.
 * Every AgentCliSpec implementation parses its CLI's native JSONL into instances
 * of this sealed interface. The UI layer only ever sees these — it never knows
 * whether the message originated from Claude's `system/init`, Codex's
 * `thread.started`, or Gemini's `init`.
 */
enum class PermissionDecision { DENY, ALLOW_ONCE, ALLOW_SESSION }

sealed interface AgentMessage {
    data class System(...) : AgentMessage
    data class EventNote(override val id: String, val label: String,
                         val detail: String? = null, val tone: Tone = Tone.DIM) : AgentMessage
    data class AssistantText(override val id: String, val text: String) : AgentMessage
}
```

`EventNote` 的注释明确：**progress-ish 事件（`task_*` / `hook_*` / `thinking_tokens`）复用稳定 `id` 以便原地更新，而不是刷屏。**

**为什么命中我们**：我们的 `ChatLine.key = "$seq-$kind-$index"` 是**每条都新增**，所以 `step/start`、`tool/call` 这类过程事件会持续堆行 —— 这与我们之前"300 条记录里 108 条是噪音"是同一个病。

**落地**：`toLine()` 输出改为 sealed interface（`UserText`/`AssistantText`/`ToolCall`/`EventNote(id=稳定键)`/`PermissionRequest`），UI 按类型分发；进度类事件按稳定 id **替换**而非追加；`LazyColumn` 用 `key = { it.id }` 稳定锚定（Conch `ChatScreenMessageList.kt:108`）。

---

### 2.7 🔴 审批三档 + **选项由服务端下发** + 未知请求必须**立刻拒绝**

**来源 A（三档枚举）**：`Conch/.../agent/AgentMessage.kt:17` + `AgentSessionCodexAppServer.kt:1706-1721`
```kotlin
enum class PermissionDecision { DENY, ALLOW_ONCE, ALLOW_SESSION }
```
注释说明：「`ALLOW_SESSION` 映射到 Codex `acceptForSession` / Gemini `allow_always`；没有会话级作用域的（Claude）当作 `ALLOW_ONCE`」。

**来源 B（选项服务端下发）**：`Hermes-Pocket/.../ServerRequestParser.kt:38-57` —— 由服务端的 `choices`/`allow_permanent`/`smart_denied` 决定显示哪些按钮，**别硬编码**。

**来源 C（未知请求必须回错）**：`Hermes-Pocket/.../OkHttpGatewayClient.kt:889-916` —— 收到不认识的方法**立刻回 `-32601`**，否则 agent 会**阻塞到超时**。

**来源 D（可撤销）**：`ChatRequestsDelegate.kt:203-218` 的 `request.cancel` 事件 —— 服务端超时/被打断时**撤回卡片**，防止"点了没反应"。

**为什么命中我们**：我们现在只有 `approve(approved, remember)` 布尔 + `answerOption`，**没有"本次会话都允许"这一档**；而 DSH 主机实测有 `approval/policy`（我们见过 `{"policy":"ask"}`）。且我们没有"服务端撤回审批"的处理。

**落地**：`PendingPrompt` 加 `options: List<Decision>`（由服务端 payload 决定）；`answerOption` 改为按枚举应答；`handleHostRequest` 里对**不认识的事件名**主动回一个 rejected（否则 Agent 端阻塞）。

---

### 2.8 令牌安全升级：**PKCE + 单次 WS 票据**（而非长期 token 进 URL）

**来源**：`Hermes-Pocket/.../runtime/remote/RemoteAuth.kt:247-323` + `RemoteAuthInterceptor.kt:29-45`

- `/auth/native/authorize` → `/auth/password-login` → `/auth/native/token` 换 access/refresh；
- **每次拨号前** `POST /api/auth/ws-ticket` 拿**单次票**（30 秒失效），拦截器把 `?ticket=` 塞进 WS URL；
- HTTP 用 `Authorization: Bearer`，401 自动刷新重试一次。

**对比我们**：我们 `HostRecord.token` 是**长期令牌**（30 天），存在 `EncryptedSharedPreferences`，且**WS 与 HTTP 都用同一个 token**。

**落地（不改服务端的最小版）**：至少确保 token **只走 `Authorization` 头**，绝不进 URL/query（我们的 `readToken()` 支持 `?token=` 兜底 —— 这是个风险面，建议关掉或仅限回环）。完整版需网关侧加 ticket 端点。

---

### 2.9 🔴 高频 delta 必须**缓冲合批**，否则 O(n²)

**来源**：`starburst/.../data/EventReducer.kt:80-105` + `EventReducerMessageExt.kt:166-212`

starburst 把高频流式 delta 先塞进 `ConcurrentHashMap<StringBuilder>`，**每 50ms 一次性合并**，避免每来一个 token 就复制整段文本（O(n²)）；ViewModel 侧再把 28 路 `StateFlow` `combine` 成 `uiState`，并对 messages/parts 做 **50ms 采样节流**（`ChatViewModel.kt:383-398,680-690`）。

**为什么命中我们**：我们目前**根本还没接 `$events` 流**（网关刚修好，待重启），全靠 3s 轮询 `session.page` 重拉全量（实测单次 468 KB / 147 条）。一旦接上事件流，**第一个撞上的就是这个 O(n²)**。

**落地**：接 `$events` 时，`emit` 帧的 delta 先进 `StringBuilder`，50ms flush 一次；`LazyColumn` 用稳定 key 避免全量重组。

### 2.10 🔴 流式期间**不解析 Markdown**，settle 后才切

**来源**：`opencode-android/.../ChatComponents.kt:449-482` + `MarkdownText.kt:35-81`

流式时用纯 `Text` + 闪烁光标，**稳定后才切 Markdown**；`rememberMarkdownState(retainState = true)` 并缓存 `lastSuccessState`，使流式中途解析失败**不清空气泡**。

**补充防护**（starburst）：超 **40k 字符降级为纯文本可滚动预览**（`ChatMarkdownContent.kt:63-95`），代码块高亮 `try/catch` 失败回退纯文本（`SafeMarkdownHighlighting.kt:116-143,256`）。

**这条与 2.5（防抖解析）并不矛盾，是两个层次**：2.5 说"要解析就得防抖+离主线程"；这条说"流式期间干脆不解析，省掉整个问题"。**两者都做**：流式期纯文本，settle 后增量解析 + 缓存。

### 2.11 聊天列表用 `reverseLayout=true` + `isAtBottom` 判断

**来源**：`starburst/.../ui/screens/ChatScreen.kt:744-828`

用 `reverseLayout=true`，配 `derivedStateOf` 判断 `isAtBottom`；**上滑时关闭自动滚动并显示未读小红点**。

**为什么命中我们**：我们 `ChatScreen.kt:66-68` 是 `LaunchedEffect(lines.size) { animateScrollToItem(lastIndex) }` —— **流式增长时会被反复打断**，且用户上滑看历史时会被强行拽回底部。

### 2.12 发送**幂等**：预生成 messageId + 本地待发记录持久化

**来源**：`starburst/.../MessageIdGenerator.kt:22-34` + `PendingPromptRepository.kt:27-81`

starburst 为每条 prompt **预生成 `messageId`** 并**落盘 pending 记录**，进程被杀后可对账。我们 `ChatViewModel.send()` 用随机 `requestId` 但**不持久化** —— 进程被杀则消息去向不明。

**落地**：`send()` 前把 `(requestId, sessionId, text, 时间)` 写入本地 pending 表；收到 `user/message` 事件或 `session.page` 里出现对应内容即清除；启动时对账残留项。

---

## 3. 其余可借鉴点（简表）

| # | 借鉴什么 | 来源（文件:行号） | 落地 |
|---|---|---|---|
| 1 | 状态机抽**纯 Kotlin 函数** `(current,event)→next`，脱离 Android 单测 | `Conch/.../SessionStateMachine.kt:1-154` | 我们有裸 `AtomicBoolean muxOpen`，抽成纯函数才能补上缺失的单测 |
| 2 | `isAdoptable()`：区分"传输活着"与"会话还能不能跑" | `Conch/.../SessionStateMachine.kt:80-84` | 我们 `LinkState.Ready` 混了两个问题，应拆开 |
| 3 | 发送后 **ACK 看门狗**：35s 无事件 → 探针，死则重投 | `Conch/.../AgentSessionPersistentStream.kt:293-326` | 把"没送到"与"远端在干活"分开 |
| 4 | **自适应轮询**：工作 2s／前台空闲 5s／后台 30s／后台>5min 60s／省流量×6 | `Conch/.../ChatViewModelTailPoll.kt:1839-1844` | 我们固定 3s；改为分级，常量集中一处 |
| 5 | **seq 丢帧检测**：帧头单调 seq，检测到空洞就整段重建 | `Hermes-Pocket/.../EventSequenceTracker.kt:19-24` | 我们 mux 帧没有 seq；丢帧会静默缺字 |
| 6 | **重连后 `syncPending()`**：拉一次历史，把最后一条 assistant 贴回 | `Hermes-Mobil/.../ChatViewModel.kt:949-979` | 专治"服务器有答案、手机一直转圈" |
| 7 | **离线 outbox**：断线提示"N 条待发送"，重连 flush，失败 `add(0,body)` 回队 | `Hermes-Mobil/.../ChatViewModel.kt:193,912-931` | 我们断线发消息直接失败 |
| 8 | **single-flight 拨号 + 网络回调立即重连** | `Hermes-Pocket/.../OkHttpGatewayClient.kt:214-234,680-701` | 消灭"218 次连接风暴" |
| 9 | 退避：首连 300ms、之后指数、**上限 30s** | `Hermes-Mobil/.../GatewayWsClient.kt:329-331` | 我们上限 10s 偏激进，弱网费电 |
| 10 | `retryable` 分类：401/403 不可重试，408/429/5xx 可重试 | `starburst/.../SseClient.kt:145,769` | 我们所有非 2xx 都抛同一异常，UI 无法区分"请重新登录"与"会自动重试" |
| 11 | 认证错误**单独文案**，别落进"服务器不响应" | `starburst/.../SseClient.kt:135` | 同上 |
| 12 | 心跳超时 **90s** 判定流死 | `starburst/.../SseClient.kt:30,158` | 我们无心跳超时；WS 半开连接会假装"连着" |
| 13 | 单帧上限 **16 MiB**，超限**抛异常而非静默截断** | `starburst/.../SseFrameDecoder.kt:12-17,37-40` | 我们网关有 32 MiB 总上限但无单帧概念 |
| 14 | `EncryptedSharedPreferences` **自愈**：解不开→重试→删库重建 | `Conch/.../SecretsStore.kt:41-55,66-77` | 我们已有读取失败清库逻辑，可对齐 |
| 15 | **诊断日志写入即脱敏** + 轮转 + 一键导出 | `Hermes-Mobil/.../DiagLog.kt:150-176` | 含 `Authorization: Bearer` 曾漏 token 的真实修复 |
| 16 | 历史用 `PersistentList` + id→index，避免 O(N) | `Conch/.../AgentSessionHistory.kt:67-70` | 我们现在是 `List` 全量重建 |
| 17 | **能力探测而非版本号**握手 | `Conch/.../CodexWsBrain.kt:76-80` | 用 capabilities 帧，别按 version 猜 |
| 18 | 前台服务**按需升降级**：只在等回复时进前台 | `Hermes-Mobil/.../AwaitReplyService.kt` | 比常驻省电 |
| 19 | 通知栏 `RemoteInput` 直回 + 25s 预算短命 FGS | `Hermes-Mobil/.../ReplyService.kt` | 长任务交互 |
| 20 | 会话列表**落盘缓存**（首屏秒开） | `Hermes-Mobil/.../SessionCache.kt:22-45` | 我们冷启动必须等网络 |
| 21 | DI **不必上 Hilt**：object + `by lazy(SYNCHRONIZED)`，依赖链显式 | `Conch/.../di/ServiceLocator.kt:42-46` | 注释写明理由（Hilt 编译慢、Koin 多一个全局可变） |
| 22 | 网关**契约测试夹具**：可复现传输/会话/事件序/历史对账故障，无 provider 调用 | `hermes-relay/docs/gateway-contract-testing.md` | 我们已有 e2e 67 断言，可再补"事件序"与"重连"场景 |

---

## 4. 这些项目自己的坑（供我们避雷）

| 坑 | 出处 | 说明 |
|---|---|---|
| **上帝类** | `Conch/.../ChatViewModel.kt` **410 KB / 6917 行 / 146 个函数**；`AgentSessionCodexAppServer.kt` 106 KB；`SshConnectionPool.kt` 1765 行 | 分片是**事后拆的**。我们的 `DshConnection.kt` 现在 ~390 行，**保持住** |
| 依赖被 lint 崩溃**钉死**，注释 20 行 | `Conch/gradle/libs.versions.toml` | `lifecycle` 钉 2.8.7、`activityCompose` 钉 1.10.1，原因都是「2.9.x lint 在旧 AGP 下 `IncompatibleClassChangeError`」。**我们升级依赖要留同样注释** |
| 原生库 **16 KB 页对齐**被 Play 拒 | 同上（CameraX 注释） | "Play rejects 64-bit native libraries whose ELF load segments are aligned to 4 KB instead of 16 KB"。我们 APK 含 4 种 ABI，**上架前必查** |
| 权限被 Play 政策拒 | 同上（photopicker 注释） | "rejected for READ_MEDIA_IMAGES/VIDEO under the Photo and Video Permissions policy"。我们有 `CAMERA`（扫码），需确认用途合规 |
| 协议按 build 类型**分叉** | `starburst/AGENTS.md` | "Debug 包 → 原后端；Release 包 → 新 starburst-agent"，靠 `BuildConfig.DEBUG` 门控。**典型技术债，别学** |
| 大量 `SilentlyTry` 吞异常 | `Conch/...` | 靠注释解释为何可吞；作者记录过多次"空输出被当成不存在"的事故 |
| `GlobalScope.launch` / `runBlocking` 出现在持锁路径 | `SshConnectionPool.kt:327-332,1507-1515,1571` | 生命周期不受控、锁粒度风险 |
| 关键行为**缺回归网** | `Conch`（1239 测试但多是 parser/状态机纯函数）；`Hermes-Mobil` 仅 8 个纯函数测试，网络/重连/队列/审批**全无测试** | 我们的网关 e2e 67 断言 + 公网巡检 45 断言**已强于它们**，继续 |
| 设计理由全在 KDoc，`docs/` 只有 4 KB | `Conch` | 大量 30+ 行事故复盘写在代码注释里，**人走即丢** |
| TOFU 验证器**两份重复实现**，已分叉过一次 | `Conch/.../SshClient.kt:335` vs `SshConnectionPool.kt:1661` | 前者曾忘记 pin |
| `allowBackup=true` 从 false 改回 | `Conch/AndroidManifest.xml:97-111` | 靠 `data_extraction_rules` 白名单挡密钥；**规则一旦漏改即凭据进云备份** |
| 明文 HTTP 放行 | `Hermes-Mobil` 放行私有网段明文；`Hermes-Pocket` 直接 `usesCleartextTraffic="true"` | 我们 `network_security_config.xml` 也是 `cleartextTrafficPermitted="true"`（为局域网直连）。**公网必须 HTTPS**，这条要守住 |
| 离线队列只存单槽 | `Hermes-Pocket/.../ChatUiState.kt` 的 `queuedPrompt` 是单槽不是队列 | 连发两条离线消息**丢第一条** |
| 服务端组件不在仓库 | `Hermes-Mobil` 只有 `relay/gemini_live_relay.py`，README 承诺的 `phone_bridge.py` **不在仓库** | 反向通道无法端到端复现 |

### 4.1 ⚠️ 额外发现：克隆第三方仓库会**自动加载它们的 AGENTS.md 作为指令**

本次把仓库克隆进工作区的 `.scratch/study/` 后，`starburst/AGENTS.md`、`hermes-relay/AGENTS.md` + `CLAUDE.md` **被运行时当作项目指令自动注入了上下文**（内容是它们的分支策略、提交规范、安全红线等）。移出工作区后，运行时明确回报 "Instructions removed" —— 证实它们**确实在被应用**。

**风险**：这些是**第三方仓库的规则**，与我们的项目无关，却会被当成"适用的指令"。本次它们恰好无害（我们只读不写），但**如果克隆的是恶意仓库，其 `AGENTS.md` 就可能注入指令**（供应链攻击面）。

**已处理**：
1. 把 8 个克隆仓库**移出工作区** → `C:\Users\me\Downloads\oss-study\`（313 MB）；
2. 在 `.gitignore` 加入 `.scratch/`，防止将来误提交第三方源码。

**建议**：① 研读外部仓库时**始终放在工作区之外**；② 若必须放工作区内，克隆后**立刻删除其 `AGENTS.md`/`CLAUDE.md`**；③ 绝不在这类目录里执行写操作。

---

### 4.2 ⚠️ 三处**它们做得比我们差**的地方（不要被"高星"带偏）

研读时要双向对照 —— 这几处我们**已经更优**，改动前别退回：

| 维度 | 它们 | 我们 | 结论 |
|---|---|---|---|
| **断线续传** | `starburst` 解析了 `durableSeq` 却**从未使用**（`SseClient.kt:38,236`）—— 没有 `Last-Event-ID`，断线期间事件**永久丢失**，只能靠重连后全量对账。`opencode-android` 同样无 seq 续传 | 我们用 `session.page` 的 **`throughSeq` 增量**（`lastSeq`），断线后从断点续拉 | ✅ **我们的机制更优，保留** |
| **凭据存储** | `starburst` 把 `password`/`backendToken`/`sshPassword` **明文序列化进 DataStore**（`ServerRepository.kt:160-178`），全仓 `EncryptedSharedPreferences` **grep 零命中**；`usesCleartextTraffic="true"` 全局开（`AndroidManifest.xml:36`） | 我们用 `EncryptedSharedPreferences`（`HostStore.kt`），且写失败会抛 `HostStoreException` | ✅ **我们更优** |
| **测试** | `opencode-android` **无 androidTest**，SSE 连接/重连路径**零覆盖**（只测了纯函数 `consumeSseLine`）；`Hermes-Mobil` 仅 8 个纯函数测试，网络/重连/队列/审批**全无** | 网关 e2e **67 断言**、公网巡检 **45 断言**、`verify-subagent-classifier.mjs` 逐条实测 | ✅ **我们更优，继续** |

> 但也有一处**共同缺失**值得警惕：`starburst` 与 `opencode-android` **都没有 seq 续传**，断线窗口完全依赖重连后对账。我们有 `throughSeq`，但**同样没有帧级 seq 丢帧检测**（见简表 #5）—— 两者是互补的，不是二选一。

---

## 5. 建议的落地顺序（结合我们当前状态）

| 优先级 | 做什么 | 依据 | 改动量 |
|---|---|---|---|
| **1** | **single-flight** 包住 `session/list` | §2.4，我们有 4 个并发调用点 | 小 |
| **2** | **turn 代际号 + 单一终局权威** | §2.3，治"旧事件污染新状态"与"spinner 不灭" | 小 |
| **3** | **所有权值对象** `SessionOwner` | §2.1，我们刚在这上面连错两次 | 小 |
| **4** | 重连参数（上限 30s）+ `retryable` 分类 + 认证错误单独文案 | 表 9-11 | 小 |
| **5** | **接 `$events` 流 + delta 50ms 缓冲合批** | §2.9 —— 网关修好后这是**第一件**要做的事 | 中 |
| **6** | 消息模型改 sealed interface + 稳定 id 原地更新 | §2.6 | 中 |
| **7** | markdown：流式期纯文本 → settle 后增量解析（+40k 降级、try/catch 回退） | §2.5 + §2.10 | 中 |
| **8** | 聊天列表 `reverseLayout` + `isAtBottom` + 未读小红点 | §2.11 | 小 |
| **9** | 发送幂等：预生成 id + pending 落盘 | §2.12 | 小 |
| **10** | 审批三档 + 选项服务端下发 + 服务端撤回 | §2.7 | 中 |
| **11** | 离线 outbox + 会话列表落盘缓存 | 表 7,20 | 中 |
| **12** | 状态机抽纯函数 + 补单元测试 | 表 1,2 | 中 |
| **13** | 诊断日志脱敏 + 心跳超时 + seq 丢帧检测 | 表 5,12,15 | 中 |

> **第 5 条依赖"重启 DSH"**（网关 mux 改动需重启才生效）。在此之前，1–4、8、9 都可独立落地。

---

## 6. 未能核实 / 明确边界

- **MiniMax 安卓端**：确认**未开源**（只有 CLI，TypeScript）。
- **小米 / 字节 / NousResearch 的原生移动端**：**均未开源**（核查范围见 §0.2）。注意这是"在所列组织与关键词下未找到"，**非数学证明**；未查 Gitee / GitLab / 官网直接下载的源码包。
- **`rikkahub`(8157★) 与 `Operit`(8616★)**：因 GitHub 匿名 API 限流（HTTP 403）**未能抓取文件树**，其描述来自 README 与元数据，**未逐文件验证**。本次只克隆了 `operit` 与 `aiedge-gallery`（成功，3200/633 文件）但**未逐行读**。
- **`hermes-relay`**：只读了 `SessionActivityRegistry.kt`、`ReconnectBackoff` 相关与 `docs/gateway-contract-testing.md` 开头；**340 KB 的 `decisions.md` 未读**，`spec.md`(178 KB) 未读。**这个仓库的价值远未被挖尽，值得后续专门投入。**
- **`Conch` 的 SSH 层**（`SshConnectionPool.kt` 1765 行）、**FIDO2 实现**（`SkSigner.kt` 22 KB）：只看了清单与规模，**未逐行读**。
- 所有 stars/许可数据来自 `api.github.com`（2026-10-13 实测），会变动。
- 克隆产物在 `.scratch/study/`（**未提交**）。

> **复现**：见 §1 各仓库链接；`git clone --depth 1 <url>`。Hermes-Mobil 有 217 MB，建议 `--filter=blob:none` + sparse-checkout。
