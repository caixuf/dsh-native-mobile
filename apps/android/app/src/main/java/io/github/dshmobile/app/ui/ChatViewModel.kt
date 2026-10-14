package io.github.dshmobile.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.dshmobile.app.net.DshConnection
import io.github.dshmobile.app.net.Envelopes
import io.github.dshmobile.app.net.HostRequest
import io.github.dshmobile.app.render.JsonRender
import io.github.dshmobile.app.notify.ConnectionHub
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 会话列表 + 当前会话的对话。 */

data class ChatLine(
    val key: String,
    val role: String,
    val text: String,
    val kind: String,
    val toolName: String? = null,
    val toolArgs: String? = null,
    val toolResult: String? = null,
    val toolCallId: String? = null,
    val isError: Boolean = false,
)

/**
 * 一条等待用户回应的主机请求。
 *
 * @param rpcId 主机的 `eventId`（`waterfall` 帧），应答时原样送回。
 * @param method 事件名：`approval/request` 或 `user-questions/request`。
 * @param questionId 提问类事件的**问题 id**（`AskUserQuestionItem.id`）。
 *        应答形状是 `{answers:[{id, selected:[label]}]}`，这里的 `id` 指**问题**
 *        而非选项 —— 早期实现把选项文本当答案直接发，形状完全不对。
 * @param options 选项 **label** 列表（多选事件可能多个问题，这里只呈现第一个）。
 */
data class PendingPrompt(
    val rpcId: String,
    val method: String,
    val title: String,
    val body: String,
    val options: List<String>,
    val questionId: String? = null,
    val approval: Boolean = false,
)

/**
 * 一条**待发送**的消息（排队中，尚未被主机处理）。
 *
 * 🔴 为什么要有本地队列（2026-10-14）：
 *
 * 用户反馈「正在运行中时候不能输入啊，不能发送任务队列，你看客户端就可以的」。
 * 排查发现**能力一直都在** —— `session.prompt` 的 `mode` 参数本身就是
 * `queue | steer`：
 *   - `queue` → 排在当前回合之后执行（这就是"任务队列"）
 *   - `steer` → 直接注入当前回合（这就是"插话"）
 *
 * 而 `session.updateQueue` 还能编辑 / 删除 / 把排队项**提升为 steer**。
 *
 * 所以卡住的不是协议，是我们自己的 UI —— `Composer(enabled = !state.running)`
 * 把输入框整个锁死了。这是纯粹的自我设限。
 *
 * 本地队列的作用：主机不会主动推"我的队列里有什么"，所以排队项由客户端自己
 * 记账（乐观 UI），保证用户立刻看到"我发出去了"而不是干等。
 */
data class QueuedMessage(
    /** 客户端本地 id，用于删除/编辑定位。 */
    val localId: String,
    val text: String,
    /** 提交时使用的 mode；`queue` 排队、`steer` 插话。 */
    val mode: String = "queue",
    val createdAt: Long = System.currentTimeMillis(),
    /**
     * 提交状态。
     * `pending` = 已本地入队但还没成功发给主机（或还不知道结果）
     * `sent`    = 主机已确认接收（accepted）
     * `failed`  = 提交失败（网络/权限），保留在队列里让用户决定重试或删除
     */
    val status: String = "pending",
    val error: String? = null,
)

data class ChatUiState(
    val sessionId: String = "",
    val title: String = "",
    val lines: List<ChatLine> = emptyList(),
    val pending: PendingPrompt? = null,
    val running: Boolean = false,
    val sending: Boolean = false,
    val loading: Boolean = true,
    val error: String? = null,
    val rawTail: String? = null,
    /**
     * 待发送队列（本地记账）。
     *
     * 用户在**运行中**也可以继续输入并发送 —— 消息进入这里，按 `queue` 模式
     * 提交给主机，主机在当前回合结束后依次执行。
     */
    val queue: List<QueuedMessage> = emptyList(),
    /**
     * 一次性提示（如"模式偏好只影响本地展示"）。
     *
     * 用于**诚实告知**用户某项操作的真实效果 —— 例如模式/权限这类
     * DSH 未开放远程切换的能力，不能假装切换成功了。
     * UI 消费后应调用 [consumeHint] 清掉，避免常驻。
     */
    val hint: String? = null,
    /**
     * 电脑是否正在「准备中」。
     *
     * 🔴 我们的产品是「手机发起、电脑执行」。从点发送到电脑上真的有响应，
     * 中间有一段不可见的等待（唤醒守护进程、加载技能、准备工作区）。
     * 不给反馈的话，用户会以为 App 卡了并重复点击。
     *
     * 阶段划分对齐逆向 MiniMax 移动端的 `claw_pod_start_process_0..3`
     * （唤醒 → 加载知识和技能 → 准备工作空间 → 即将完成）。
     */
    val preparing: Boolean = false,
    /** 0..3，当前进行到第几阶段；>= preparing 为 false 时忽略。 */
    val preparingStep: Int = 0,
    /** 当前选中的大语言模型 */
    val selectedModel: String = "deepseek-v4.1-flash",
    val selectedProvider: String = "opendesign",
    val availableModels: List<String> = listOf("deepseek-v4.1-flash", "deepseek-chat", "deepseek-reasoner"),
    /** 当前智能体运行模式 */
    val selectedMode: String = "标准模式",
    val availableModes: List<String> = listOf("标准模式", "代码审查模式", "计划与架构模式"),
    /** 当前操作权限范围 */
    val selectedPermission: String = "工作区内修改",
    val availablePermissions: List<String> = listOf("工作区内修改", "完全权限", "只读模式"),
)

class ChatViewModel(private val connProvider: () -> DshConnection?) : ViewModel() {

    constructor(conn: DshConnection?) : this({ conn })

    private val conn: DshConnection? get() = connProvider()

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private var pollJob: Job? = null
    private var hostJob: Job? = null
    /** 「电脑准备中」阶段推进的定时任务。 */
    private var advanceJob: Job? = null
    private var lastSeq: Long = -1
    private var started = false

    fun open(sessionId: String, title: String) {
        if (started && _state.value.sessionId == sessionId) return
        started = true
        lastSeq = -1
        _state.value = ChatUiState(sessionId = sessionId, title = title)
        if (sessionId.startsWith("local-") || conn == null) {
            _state.update {
                it.copy(
                    loading = false,
                    lines = listOf(
                        ChatLine(
                            key = "local-intro",
                            role = "assistant",
                            text = "你好！我是你的电脑端 AI 遥控伴侣 ⚡\n\n你可以直接打字，或者**按住右下角麦克风说话**，语音指令将通过加密隧道直接在你的电脑上执行（包含所有 MCP 插件、文件读写与终端命令）。",
                            kind = "markdown",
                        )
                    )
                )
            }
            return
        }
        reload()
        startPolling()
        startHostRequests()
    }

    private fun requireConn(): DshConnection? {
        if (conn == null) {
            _state.update { it.copy(error = "尚未连接到任何电脑") }
        }
        return conn
    }

    /**
     * 读一页会话记录。
     *
     * ## 全部经真实主机实测确认（2026-10-13）
     *
     * 方法名是 `session.page`，**不是** `session.history`（后者在真实主机上不存在）。
     * 而且 args 的键名是服务端声明的形参名 `request`，不是业务字段名：
     *
     *     args = { request: { address, throughSeq, maxMessages } }
     *
     * 实测返回：
     *     { records: [ { type:'event', event:{ type, seq, time, data } } ], … }
     *     例：event.type = "assistant/message"，seq = 3245
     *
     * ⚠️ `throughSeq` **不能超过当前 cursor**。实测错误：
     *     "session page through seq 9007199254740991 is past cursor 3256"
     * 所以不能用 Long.MAX_VALUE 表示「最新」。正确做法是先拿 cursor 再翻页；
     * 这里用 `throughSeq` 状态保存上次已知的 cursor，首次用一个探测值，
     * 主机报错时从错误信息里学出真实 cursor。
     */
    private fun pageArgs(sessionId: String, throughSeq: Long, maxMessages: Int): JsonObject = buildJsonObject {
        put("request", buildJsonObject {
            put("address", buildJsonObject {
                put("kind", "session")
                put("sessionId", sessionId)
            })
            put("throughSeq", throughSeq)
            put("maxMessages", maxMessages)
        })
    }

    /** 当前已知的会话 cursor；超过它会报 "past cursor"。 */
    private var cursor: Long = 0

    /** 从 "past cursor N" 这类错误里学出真实 cursor。 */
    private fun learnCursor(message: String?): Long? {
        val m = Regex("past cursor (\\d+)").find(message ?: "") ?: return null
        return m.groupValues[1].toLongOrNull()
    }

    /** 从 session.page 的结果里取出记录数组（兼容 records[].event 与裸 events）。 */
    private fun recordsOf(obj: JsonObject): List<JsonObject> {
        val records = JsonRender.arr(obj, "records")
        if (records != null) {
            return records.mapNotNull { r ->
                val entry = r as? JsonObject ?: return@mapNotNull null
                (entry["event"] as? JsonObject) ?: entry
            }
        }
        // 兼容：万一主机直接给了 events[]。
        return (JsonRender.arr(obj, "events") ?: JsonArray(emptyList()))
            .mapNotNull { it as? JsonObject }
    }

    /**
     * 读一页会话记录。
     *
     * `throughSeq` 有「不能超过 cursor」的约束，而真实 cursor 只有主机知道。
     * 每次用 1_000_000L 主动探测 cursor（主机必然报 "past cursor N"），
     * 从而立刻学出当前真实 cursor，再精准拉取。
     */
    private suspend fun fetchPage(c: DshConnection, sid: String, maxMessages: Int): Result<Pair<Long, JsonObject>> {
        val probe = c.call("session.page", pageArgs(sid, 1_000_000L, 1), timeoutMs = 6_000)
        val learned = learnCursor(probe.exceptionOrNull()?.message)
        val targetSeq = learned ?: if (cursor > 0) cursor else 1_000L
        cursor = targetSeq
        val r = c.call("session.page", pageArgs(sid, targetSeq, maxMessages), timeoutMs = 10_000)
        return r.map { targetSeq to it.jsonObject }
    }

    fun reload() {
        val c = requireConn() ?: return
        val sid = _state.value.sessionId
        viewModelScope.launch {
            fetchPage(c, sid, 80).onSuccess { (newCursor, obj) ->
                cursor = newCursor
                // ⚠️ 顺序很重要：`recs` 必须先声明，下面两处都要用它。
                // 之前出现过 `recs` 在声明前被引用（`val serverLines = recs...`
                // 写在 `val recs = recordsOf(obj)` 之前），导致整块解析错位、
                // 编译器报出一串"无法推断类型"的连锁错误。
                val recs = recordsOf(obj)
                val serverLines = recs.mapIndexedNotNull { i, e -> toLine(e, i) }
                extractSessionContext(recs)
                lastSeq = recs.lastOrNull()?.get("seq")
                    ?.jsonPrimitive?.content?.toLongOrNull() ?: newCursor

                // 合并现有 optimistic lines（只保留尚未被服务端记录覆盖的 pending 消息）
                val serverTexts = serverLines.filter { it.role == "user" }.map { it.text }.toSet()
                val pendingLines = _state.value.lines.filter { it.key.startsWith("pending-") && it.text !in serverTexts }

                _state.update {
                    it.copy(
                        lines = serverLines + pendingLines,
                        loading = false,
                        error = null,
                        running = detectRunning(obj),
                    )
                }
            }.onFailure { error ->
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    /**
     * 轮询会话状态与增量事件。
     *
     * 🔴 跑在 `Dispatchers.Default`，**不是主线程**（2026-10-14 性能审计发现）。
     *
     * `viewModelScope.launch` 默认是 `Dispatchers.Main.immediate`。原实现因此
     * 把一整条重活链都放在了主线程上：
     *   - `Envelopes.json.parseToJsonElement` 解析响应体（实测单次 **468 KB**）
     *   - `recordsOf` + `toLine()` × 60 条
     *   - `extractSessionContext` + `detectRunning` 全量扫描
     *
     * 每 2.5 秒一次的主线程突发，必然掉帧 —— 这是"不丝滑"的直接来源。
     *
     * 安全性说明：循环内只做纯计算与 `_state.update`，而
     * `MutableStateFlow.update` 是原子的、可从任意线程调用；
     * 所有 UI 读取仍通过 `collectAsStateWithLifecycle` 回到主线程。
     * 因此整段搬离主线程是安全的，不需要逐处 `withContext`。
     *
     * 同时加了**后台暂停**：App 退到后台时 UI 已不收集，继续每 2.5 秒
     * 解析 468KB 纯属浪费电与 CPU（还可能撞上回到前台的那一刻）。
     */
    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch(Dispatchers.Default) {
            while (isActive) {
                delay(2_500)
                // 后台不轮询 —— 见上面说明
                if (!ConnectionHub.appInForeground) continue
                val c = conn ?: continue
                val sid = _state.value.sessionId
                if (sid.isEmpty() || _state.value.pending != null) continue

                // 1. 探测主机当前最新 cursor
                val probe = c.call("session.page", pageArgs(sid, 1_000_000L, 1), timeoutMs = 5_000)
                val learned = learnCursor(probe.exceptionOrNull()?.message)
                if (learned != null) {
                    // 如果 cursor 相比上次推进了，或者当前处于 running/preparing 状态
                    if (learned > cursor || _state.value.running || _state.value.preparing) {
                        cursor = learned
                        val r = c.call("session.page", pageArgs(sid, learned, 60), timeoutMs = 8_000)
                        r.onSuccess { value ->
                            val obj = value.jsonObject
                            val recs = recordsOf(obj)
                            extractSessionContext(recs)
                            val serverLines = recs.mapIndexedNotNull { i, entry -> toLine(entry, i) }
                            val serverTexts = serverLines.filter { it.role == "user" }.map { it.text }.toSet()
                            val pendingLines = _state.value.lines.filter { it.key.startsWith("pending-") && it.text !in serverTexts }
                            // 复用上面已经抽好的 recs，不再让 detectRunning 内部重抽一遍
                            val isRunning = detectRunning(recs)

                            val newSeq = recs.lastOrNull()?.get("seq")?.jsonPrimitive?.content?.toLongOrNull()
                            newSeq?.takeIf { it > lastSeq }?.let { lastSeq = it }

                            // 🔴 内容没真变就**不更新 state**（2026-10-14 性能审计发现）。
                            //
                            // 原实现每次都 `serverLines + pendingLines` 新建一个 List 并
                            // `copy` 进 state。即使内容逐字相同，`StateFlow` 也会因为
                            // **新实例**而认为发生了变化 → 整棵 Compose 订阅树重组。
                            //
                            // 而轮询是 2.5 秒一次的固定节拍：主机没有新内容时，
                            // 我们仍会每 2.5 秒无条件重组一次整个聊天界面。
                            // 这是"待机也在掉帧"的来源。
                            //
                            // 现在先比对新旧列表与运行态，完全相同就直接跳过 update。
                            val merged = serverLines + pendingLines
                            val cur = _state.value
                            val sameLines = merged == cur.lines
                            val sameRunning = isRunning == cur.running
                            val nextPreparing =
                                if (isRunning || serverLines.any { line -> line.role == "assistant" }) {
                                    false
                                } else {
                                    cur.preparing
                                }
                            if (sameLines && sameRunning && nextPreparing == cur.preparing) {
                                return@onSuccess
                            }

                            _state.update {
                                it.copy(
                                    lines = merged,
                                    running = isRunning,
                                    preparing = nextPreparing,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private fun startHostRequests() {
        hostJob?.cancel()
        val c = conn ?: return
        hostJob = viewModelScope.launch {
            c.hostRequests.collect { req -> handleHostRequest(c, req) }
        }
    }

    /**
     * 主机事件 → 待确认卡片。
     *
     * 🔴 只处理 `answerable`（即 `waterfall`）的项。真实主机把**纯通知**（`emit`）
     * 和**待应答的 waterfall** 都送到同一条 `$events` 流上；早前按事件名里是否含
     * "approval"/"question"/"ask" 来猜，会把 `schedule/changed` 这类通知也弹成审批框，
     * 而且真正需要应答的事件一旦改名就会漏掉。
     *
     * 两类 waterfall 的负载形状**不同**（均从 app.asar 取证）：
     *
     *   approval/request        { toolName, callId?, reason?, displayReason? }
     *   user-questions/request  { questions:[{id, question, detail?, header?,
     *                             options?:[{label, description?}], multiSelect?}], wait? }
     *
     * 所以选项要从 `questions[0].options[].label` 取（是**对象数组**，不是字符串数组）。
     */
    private fun handleHostRequest(c: DshConnection, req: HostRequest) {
        if (!req.answerable) return
        val isApproval = req.method.contains("approval")
        val question = JsonRender.arr(req.payload, "questions")?.firstOrNull()
            as? kotlinx.serialization.json.JsonObject
        val questionId = question?.let { JsonRender.str(it, "id") }

        val title = if (isApproval) {
            "工具调用需要批准"
        } else {
            question?.let { JsonRender.str(it, "header", "question") } ?: "需要你确认"
        }
        val body = when {
            isApproval -> JsonRender.str(req.payload, "displayReason", "reason")
                ?: JsonRender.str(req.payload, "toolName")?.let { "工具：$it" }
                ?: "主机请求批准一次工具调用"
            question != null -> JsonRender.str(question, "question", "detail")
                ?: JsonRender.compact(question, 400)
            else -> JsonRender.compact(req.payload, 400)
        }
        // 选项：提问是 [{label,…}]，审批没有选项（由 UI 的允许/拒绝按钮覆盖）。
        val options = if (question != null) {
            JsonRender.arr(question, "options")
                ?.mapNotNull { JsonRender.str(it as? kotlinx.serialization.json.JsonObject, "label") }
                .orEmpty()
        } else {
            emptyList()
        }
        _state.update {
            it.copy(
                pending = PendingPrompt(
                    rpcId = req.rpcId,
                    method = req.method,
                    title = title,
                    body = body,
                    options = options,
                    questionId = questionId,
                    approval = isApproval,
                ),
            )
        }
    }

    fun answer(outcome: JsonObject) {
        val c = requireConn() ?: return
        val pending = _state.value.pending ?: return
        _state.update { it.copy(pending = null) }
        viewModelScope.launch {
            val ok = c.respond(pending.rpcId, outcome)
            if (!ok) _state.update { it.copy(error = "应答未被主机接受（可能已过期）") }
        }
    }

    /**
     * 选择并切换当前会话的大语言模型。
     *
     * 经真实主机实测确认（`session.selectModel`）：
     * 形参名为 `request: { sessionId, provider, model }`。
     */
    fun selectModel(modelName: String) {
        val c = requireConn() ?: return
        val sid = _state.value.sessionId
        val provider = when {
            modelName.contains("flash") -> "opendesign"
            modelName.contains("deepseek") -> "deepseek"
            modelName.contains("claude") -> "anthropic"
            modelName.contains("gpt") -> "openai"
            else -> _state.value.selectedProvider
        }
        _state.update { it.copy(selectedModel = modelName, selectedProvider = provider) }
        viewModelScope.launch {
            val r = c.call(
                "session.selectModel",
                buildJsonObject {
                    put("request", buildJsonObject {
                        put("sessionId", sid)
                        put("provider", provider)
                        put("model", modelName)
                    })
                },
                timeoutMs = 6_000,
            )
            r.onFailure { err ->
                _state.update { it.copy(error = "模型切换提示: ${err.message ?: "该模型暂时不可用"}") }
            }
        }
    }

    /**
     * 切换当前操作权限范围。
     *
     * 🔴 **实测修正（2026-10-14）**：原实现发 `/permission <preset>`。
     * 实测证明 DSH 不识别该命令（`command` 槽位为空），它会被当成普通文本
     * 发给模型 —— 既没改权限，又浪费一次调用并污染会话历史。
     *
     * **DSH 真实的权限机制是「审批请求」**（`approval/request` 事件）：
     * 需要授权的动作会实时弹给用户，由用户逐次批准/拒绝
     * （`$events/result` + `allowed-once | rejected | ...`）。
     * 那是**逐次审批**，不是"预设档位"—— 所以不存在一个可以远程切换的档位开关。
     *
     * 现在的做法：
     *  - 不再发假命令
     *  - 控件如实说明：权限由电脑端逐次审批决定，手机端在弹窗里响应
     */
    fun selectPermission(permissionLabel: String) {
        _state.update {
            it.copy(
                selectedPermission = permissionLabel,
                hint = "权限由电脑端逐次审批：需要授权的动作会弹到这里，由你当场决定",
            )
        }
    }

    /** UI 展示完一次性提示后调用，避免常驻。 */
    fun consumeHint() {
        _state.update { it.copy(hint = null) }
    }

    /**
     * 切换当前智能体模式。
     *
     * 🔴 **实测修正（2026-10-14）**：原实现发 `/preset <name>` 斜杠命令。
     * 但实测证明 DSH **不识别**这些命令 —— 发 `/preset plan`、`/help`、`/model`、
     * `/permission workspace-write` 全都返回 `accepted=true` 且
     * **`command` 槽位为空**（按官方契约，该槽位只在命令被识别时出现）。
     *
     * 也就是说：这些"命令"实际被当成**普通文本发给了模型** ——
     * 既没切换任何东西，还白白消耗一次模型调用、并把一串斜杠文本写进会话历史。
     *
     * 现在的做法：
     *  - **不再发送任何斜杠命令**（避免污染会话与浪费 token）
     *  - 模式仍是**本地展示偏好**，如实告知用户"这是提示词偏好，不是远端开关"
     *  - 真正切预设要走 agentPreset 系列的接口，而它在主机侧是 `loopback_only`（实测被拦）
     *
     * ⚠️ 这是诚实的降级：宁可少一个假开关，也不要给用户"我改了但没生效"的错觉。
     */
    fun selectMode(modeLabel: String) {
        _state.update {
            it.copy(
                selectedMode = modeLabel,
                hint = "模式偏好已记录（本地展示）；DSH 未开放远程切换预设接口，实际行为由会话自身决定",
            )
        }
    }

    /**
     * 从 session.page 记录中解析当前会话真实运行中的模型、模式与权限。
     */
    private fun extractSessionContext(records: List<JsonObject>) {
        var foundModel: String? = null
        var foundProvider: String? = null
        var foundMode: String? = null
        var foundPerm: String? = null

        for (rec in records) {
            val eventType = rec["type"]?.jsonPrimitive?.content ?: ""
            val data = rec["data"] as? JsonObject

            when (eventType) {
                "permission/preset" -> {
                    val p = data?.get("preset")?.jsonPrimitive?.content
                    foundPerm = when (p) {
                        "workspace-write" -> "工作区内修改"
                        "danger-full-access" -> "完全权限"
                        "read-only" -> "只读模式"
                        else -> p
                    }
                }
                "sandbox/mode" -> {
                    if (foundPerm == null) {
                        val m = data?.get("mode")?.jsonPrimitive?.content
                        foundPerm = when (m) {
                            "workspace-write" -> "工作区内修改"
                            "danger-full-access" -> "完全权限"
                            "read-only" -> "只读模式"
                            else -> m
                        }
                    }
                }
                "agent-preset/selected" -> {
                    val ap = data?.get("agentPreset")?.jsonPrimitive?.content
                    foundMode = when (ap) {
                        "cordis", "review" -> "代码审查模式"
                        "plan" -> "计划与架构模式"
                        "standard", "default" -> "标准模式"
                        else -> ap
                    }
                }
                "request/header" -> {
                    val config = data?.get("header") as? JsonObject
                    val cfg = config?.get("config") as? JsonObject
                    val m = cfg?.get("model")?.jsonPrimitive?.content
                    val p = cfg?.get("provider")?.jsonPrimitive?.content
                    if (!m.isNullOrBlank()) foundModel = m
                    if (!p.isNullOrBlank()) foundProvider = p
                }
                "request/context" -> {
                    val m = data?.get("model")?.jsonPrimitive?.content
                    val p = data?.get("provider")?.jsonPrimitive?.content
                    if (!m.isNullOrBlank()) foundModel = m
                    if (!p.isNullOrBlank()) foundProvider = p
                }
            }
        }

        if (foundModel != null || foundPerm != null || foundMode != null) {
            _state.update { current ->
                current.copy(
                    selectedModel = foundModel ?: current.selectedModel,
                    selectedProvider = foundProvider ?: current.selectedProvider,
                    selectedPermission = foundPerm ?: current.selectedPermission,
                    selectedMode = foundMode ?: current.selectedMode,
                )
            }
        }
    }

    /**
     * 审批的允许 / 拒绝。
     *
     * ⚠️ `remember` 参数**故意不发上线**：宿主 `ApprovalOutcome` 词表只有
     * `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` 四个字符串，
     * 没有「记住本次选择」这一项。多发字段会被判为词表外值并**归一化成
     * `'unavailable'`**，反而把允许变成拒绝。保留参数只为兼容现有 UI 调用点。
     */
    fun approve(approved: Boolean, remember: Boolean = false) {
        answer(Envelopes.approvalOutcome(approved))
    }

    /**
     * 回答一个提问选项。
     *
     * 形状：`{answers:[{id:<问题 id>, selected:[<选项 label>]}]}`。
     * 问题 id 缺失时不发（宁可不发，也不要发一个主机认不出的形状）。
     */
    fun answerOption(text: String) {
        val pending = _state.value.pending ?: return
        val questionId = pending.questionId
        if (questionId == null) {
            _state.update { it.copy(error = "这条请求没有可回答的问题 id，已忽略") }
            return
        }
        answer(Envelopes.questionOutcome(questionId, listOf(text)))
    }

    /**
     * 发送消息。
     *
     * 🔴 **运行中也能发**（2026-10-14 修复）。
     *
     * 原实现有两个自我设限：
     *   1. `if (_state.value.sending) return` —— 提交中直接丢消息；
     *   2. UI 层 `Composer(enabled = !state.running)` 把输入框锁死。
     *
     * 但协议本来就支持：`session.prompt` 的 `mode=queue` 会**排在当前回合之后**，
     * 这正是客户端「任务队列」的行为。所以这里改成：
     *
     *   - 空闲 → 立即提交（照旧）
     *   - 运行中 / 提交中 → **入本地队列并提交**，模式用 `queue`
     *
     * 本地队列只用于展示与撤销；真正的排队由主机负责。
     */
    fun send(text: String) {
        val body = text.trim()
        if (body.isEmpty()) return

        val current = _state.value
        val busy = current.running || current.sending

        if (current.sessionId.startsWith("local-") || conn == null) {
            sendLocalDemo(body)
            return
        }

        if (!busy) {
            // 空闲：走原有的即时提交路径（保留「电脑准备中」阶段反馈）
            submitImmediate(body)
        } else {
            // 忙：入队 + 以 queue 模式提交
            enqueueAndSubmit(body)
        }
    }

    /** 本地演示会话（未连接主机时）的假回复，仅用于空壳可用性。 */
    private fun sendLocalDemo(body: String) {
        val userMsg = ChatLine(
            key = "u-${System.currentTimeMillis()}",
            role = "user",
            text = body,
            kind = "markdown",
        )
        val replyMsg = ChatLine(
            key = "a-${System.currentTimeMillis()}",
            role = "assistant",
            text = "已收到语音/文字指令：\n\n> **$body**\n\n指令已通过手机随身端下发！在配对的工作电脑上，桌面端已部署的 MCP 工具（搜索、文件系统、终端命令、代码执行）将在此步协同调用执行。",
            kind = "markdown",
        )
        _state.update {
            it.copy(lines = it.lines + userMsg + replyMsg, sending = false, preparing = false)
        }
    }

    /**
     * 运行中入队并提交。
     *
     * 先本地入队（乐观 UI，用户立刻看到"已排队"），再提交；提交失败把该项标记为
     * `failed` 并**保留在队列里** —— 不能静默丢掉用户辛苦打的字。
     */
    private fun enqueueAndSubmit(body: String) {
        val localId = "q-${System.currentTimeMillis()}-${(0..999).random()}"
        val item = QueuedMessage(localId = localId, text = body, mode = "queue")
        _state.update { it.copy(queue = it.queue + item, error = null) }

        val c = conn ?: return
        viewModelScope.launch {
            submitPrompt(c, body, mode = "queue")
                .onSuccess {
                    _state.update { s ->
                        s.copy(queue = s.queue.map { if (it.localId == localId) it.copy(status = "sent") else it })
                    }
                }
                .onFailure { error ->
                    _state.update { s ->
                        s.copy(
                            queue = s.queue.map {
                                if (it.localId == localId) {
                                    it.copy(status = "failed", error = error.message)
                                } else {
                                    it
                                }
                            },
                            error = error.message,
                        )
                    }
                }
        }
    }

    /** 空闲态提交：保留「电脑准备中」的阶段式反馈。 */
    private fun submitImmediate(body: String) {
        val c = requireConn() ?: return
        val userLine = ChatLine(
            key = "pending-${System.currentTimeMillis()}",
            role = "user",
            text = body,
            kind = "user/message",
        )
        _state.update {
            it.copy(
                lines = it.lines + userLine,
                sending = true,
                preparing = true,
                preparingStep = 0,
                error = null,
            )
        }

        // 阶段推进：主机没给"准备完成"的信号（我们目前也没接事件流的 turn/start），
        // 所以按**时间**推进 —— 这是诚实的近似：告诉用户在等，而不是假装知道确切进度。
        // 每一步的时长按「远程唤醒 + 加载技能 + 准备工作区」的真实耗时估计。
        advanceJob?.cancel()
        advanceJob = viewModelScope.launch {
            val schedule = listOf(600L, 1600L, 3000L)
            for ((i, delay) in schedule.withIndex()) {
                kotlinx.coroutines.delay(delay)
                if (!_state.value.preparing) return@launch
                _state.update { it.copy(preparingStep = i + 1) }
            }
        }

        viewModelScope.launch {
            submitPrompt(c, body, mode = "queue")
                .onSuccess {
                    _state.update { it.copy(sending = false, running = true) }
                }
                .onFailure { error ->
                    _state.update { it.copy(sending = false, preparing = false, error = error.message) }
                }
        }
    }

    /**
     * 实际提交一条 prompt。
     *
     * args 的键名必须是服务端声明的形参名 `request`（实测确认）；
     * 内部字段来自 `SessionPromptRequest`：requestId / sessionId / mode / content，
     * 其中 `requestId` 与 `sessionId` **同为必填**。
     */
    private suspend fun submitPrompt(
        c: DshConnection,
        body: String,
        mode: String,
    ): Result<kotlinx.serialization.json.JsonElement> =
        c.call("session.prompt", buildJsonObject {
            put("request", buildJsonObject {
                put("requestId", java.util.UUID.randomUUID().toString())
                put("sessionId", _state.value.sessionId)
                put("mode", mode)
                put("content", kotlinx.serialization.json.buildJsonArray {
                    add(buildJsonObject { put("type", "text"); put("text", body) })
                })
            })
        })

    // ── 队列管理 ────────────────────────────────────────────────────────────

    /** 从队列里移除一条（本地撤销；已经发给主机的无法撤回）。 */
    fun removeQueued(localId: String) {
        _state.update { s -> s.copy(queue = s.queue.filterNot { it.localId == localId }) }
    }

    /**
     * 把一条排队消息**提升为插话**（steer）。
     *
     * 语义：不再等当前回合结束，而是立刻注入进去 —— 对应客户端
     * `session.updateQueue` 的 `{kind:'steer'}`，以及 prompt 的 `mode=steer`。
     */
    fun promoteToSteer(localId: String) {
        val item = _state.value.queue.firstOrNull { it.localId == localId } ?: return
        if (item.status == "sent") {
            // 已提交的项无法改写，提示用户而不是假装成功
            _state.update { it.copy(error = "这条已经发出去了，无法再改为插话") }
            return
        }
        _state.update { s ->
            s.copy(queue = s.queue.map { if (it.localId == localId) it.copy(mode = "steer") else it })
        }
        val c = conn ?: return
        viewModelScope.launch {
            submitPrompt(c, item.text, mode = "steer")
                .onSuccess {
                    _state.update { s -> s.copy(queue = s.queue.filterNot { it.localId == localId }) }
                }
                .onFailure { error -> _state.update { s -> s.copy(error = error.message) } }
        }
    }

    /** 重试一条失败的消息。 */
    fun retryQueued(localId: String) {
        val item = _state.value.queue.firstOrNull { it.localId == localId } ?: return
        val c = conn ?: return
        _state.update { s ->
            s.copy(queue = s.queue.map { if (it.localId == localId) it.copy(status = "pending", error = null) else it })
        }
        viewModelScope.launch {
            submitPrompt(c, item.text, mode = item.mode)
                .onSuccess {
                    _state.update { s ->
                        s.copy(queue = s.queue.map { if (it.localId == localId) it.copy(status = "sent") else it })
                    }
                }
                .onFailure { error ->
                    _state.update { s ->
                        s.copy(
                            queue = s.queue.map {
                                if (it.localId == localId) it.copy(status = "failed", error = error.message) else it
                            },
                        )
                    }
                }
        }
    }

    /** 清空队列里的本地记录（不发任何请求）。 */
    fun clearQueue() {
        _state.update { s -> s.copy(queue = s.queue.filter { it.status == "failed" }) }
    }

    fun cancel() {
        val c = requireConn() ?: return
        viewModelScope.launch {
            // args 键名是服务端形参 `request`（实测确认）。
            c.call("session.cancel", buildJsonObject {
                put("request", buildJsonObject { put("sessionId", _state.value.sessionId) })
            })
            _state.update { it.copy(running = false) }
        }
    }

    /**
     * 把一条 `session.page` 记录转成一行气泡。
     *
     * 事件类型全集经真实主机实测确认（`scripts/inspect-event-shapes.mjs`，
     * 300 条记录、13 种类型）：
     *
     *   user/message      → 右侧气泡（用户说的）
     *   assistant/message → 左侧气泡（AI 回的）
     *   system/message    → 居中系统提示
     *   tool/call         → 工具调用（arguments 是 JSON **字符串**）
     *   tool/result       → 工具结果
     *   step/start|end、turn/start|end、model/selection、request/context、
     *   request/header、workspace/changes、agent/inbox/spliced → **不显示**
     *     （这些是过程噪音；旧版会把 step/start 也渲染成 "[step/start]" 行，
     *       300 条记录里 108 条是这类，气泡列表会被淹掉）
     */
    private fun toLine(entry: JsonObject?, index: Int): ChatLine? {
        if (entry == null) return null
        val seq = JsonRender.long(entry, "seq") ?: index.toLong()
        val kind = JsonRender.typeOf(entry)

        // 只渲染「有内容可看」的类型，其余直接丢弃。
        when (kind) {
            "user/message", "assistant/message", "system/message", "tool/call", "tool/result" -> Unit
            else -> return null
        }

        val role = JsonRender.roleOf(entry)
        val data = entry["data"] as? JsonObject

        var toolName: String? = null
        var toolArgs: String? = null
        var toolResult: String? = null
        var toolCallId: String? = null
        var isError = false

        val text = when (kind) {
            "tool/call" -> {
                toolName = JsonRender.str(data, "name") ?: "工具"
                toolCallId = JsonRender.str(data, "callId", "id")
                val rawArgs = data?.get("arguments") ?: data?.get("input")
                toolArgs = when (rawArgs) {
                    is kotlinx.serialization.json.JsonPrimitive -> rawArgs.content
                    null -> null
                    else -> rawArgs.toString()
                }
                // 🔴 text 只放**人类可读的动作名**，绝不放原始 JSON。
                //
                // 工具调用的可读细节由 DisclosureToolCard 负责呈现（摘要 + 可展开的
                // 结构化入参）。早期这里塞的是 `调用 bash · {"command":"…"}`，
                // 一旦这条 line 以正文形式出现，屏幕上就是一坨未解码的 JSON；
                // 而且和内嵌在 assistant/message 里的同一调用**重复显示两遍**。
                toolName
            }
            "tool/result" -> {
                val message = data?.get("message") as? JsonObject
                toolCallId = JsonRender.str(message ?: data, "toolCallId", "callId")
                isError = JsonRender.bool(message ?: data, "isError", "error") ?: false
                val content = message?.get("content") ?: data?.get("content") ?: data?.get("result")
                // 工具输出的兜底：优先取可读文本。
                // 🔴 只有 content 确实取不到时才退回 compact，且 compact 只对
                // **真正的输出载荷**（字符串原语 / 数组）有意义 ——
                // 对 message 形状的对象整体 dump 会把内部 JSON 铺满屏幕
                // （同类事故：会话流里出现 `{"role":"assistant","content":[...`）。
                val res = JsonRender.contentToText(content)
                    ?: JsonRender.textOf(content)
                    ?: content?.let { JsonRender.compact(it, 500) }
                    ?: ""
                toolResult = res
                res
            }
            else -> {
                val content = (data?.get("message") as? JsonObject)?.get("content")
                    ?: data?.get("content")
                // 先走 contentToText（它会跳过内嵌的工具调用块）。
                // 只有在它**完全取不到内容**时才退到 textOf；
                // textOf 内部同样跳过工具调用块，两条路都不会把工具调用渲染成正文。
                val extracted = JsonRender.contentToText(content)
                    ?: JsonRender.textOf(data)
                    ?: JsonRender.textOf(entry["message"])
                    ?: JsonRender.textOf(entry["content"])
                    ?: return null
                extracted
            }
        }

        if (kind == "user/message") {
            val src = (entry["data"] as? JsonObject)?.get("source") as? JsonObject
            val srcKind = src?.get("kind")?.jsonPrimitive?.content
            // 过滤系统注入的运行时上下文、技能快照与记忆等，避免被伪装成用户气泡
            if (srcKind != null && srcKind != "user") return null
            if (text.startsWith("<system-reminder>") ||
                text.startsWith("Current runtime context") ||
                text.startsWith("[MNEMON]") ||
                text.startsWith("MNEMON RUNTIME MEMORY SNAPSHOT")
            ) {
                return null
            }
        }
        if (kind == "system/message") {
            // 系统底层基底 prompt 过于冗长（几千字），过滤掉避免干扰界面
            if (text.startsWith("You are an AI agent") || text.length > 300) return null
        }

        return ChatLine(
            key = "$seq-$kind-$index",
            role = role,
            text = text,
            kind = kind,
            toolName = toolName,
            toolArgs = toolArgs,
            toolResult = toolResult,
            toolCallId = toolCallId,
            isError = isError,
        )
    }

    private fun detectRunning(page: JsonObject): Boolean = detectRunning(recordsOf(page))

    /**
     * 在**已抽取**的记录列表上判定运行态。
     *
     * 🔴 为什么要这个重载（2026-10-14 性能审计发现）：
     *
     * 调用点（轮询路径）手上已经有 `recs` 了，却调用 `detectRunning(obj)`，
     * 后者内部再 `recordsOf(page)` 抽一遍 —— 对同一份 payload 做两次
     * `records` 数组映射 + 全量类型判定。纯重复工作，每 2.5 秒一次。
     *
     * 这里保留原签名（其他地方可能在用）并转发到新重载，避免改动面扩大。
     */
    private fun detectRunning(records: List<JsonObject>): Boolean {
        var running = false
        records.forEach { entry ->
            when (JsonRender.typeOf(entry)) {
                "turn/start", "step/start" -> running = true
                "turn/end", "turn/complete", "step/end" -> running = false
            }
        }
        return running
    }

    override fun onCleared() {
        pollJob?.cancel()
        hostJob?.cancel()
        super.onCleared()
    }
}