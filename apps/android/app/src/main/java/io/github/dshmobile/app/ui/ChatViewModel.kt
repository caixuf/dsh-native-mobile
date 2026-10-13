package io.github.dshmobile.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.dshmobile.app.net.DshConnection
import io.github.dshmobile.app.net.Envelopes
import io.github.dshmobile.app.net.HostRequest
import io.github.dshmobile.app.render.JsonRender
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
                val serverLines = recordsOf(obj).mapIndexedNotNull { i, e -> toLine(e, i) }
                val recs = recordsOf(obj)
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
     */
    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(2_500)
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
                            val serverLines = recordsOf(obj).mapIndexedNotNull { i, entry -> toLine(entry, i) }
                            val serverTexts = serverLines.filter { it.role == "user" }.map { it.text }.toSet()
                            val pendingLines = _state.value.lines.filter { it.key.startsWith("pending-") && it.text !in serverTexts }
                            val isRunning = detectRunning(obj)

                            recordsOf(obj).lastOrNull()?.get("seq")?.jsonPrimitive?.content?.toLongOrNull()
                                ?.takeIf { it > lastSeq }?.let { lastSeq = it }

                            _state.update {
                                it.copy(
                                    lines = serverLines + pendingLines,
                                    running = isRunning,
                                    preparing = if (isRunning || serverLines.any { line -> line.role == "assistant" }) false else it.preparing,
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

    fun send(text: String) {
        val body = text.trim()
        if (body.isEmpty() || _state.value.sending) return

        if (_state.value.sessionId.startsWith("local-") || conn == null) {
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
                it.copy(
                    lines = it.lines + userMsg + replyMsg,
                    sending = false,
                    preparing = false,
                )
            }
            return
        }

        val c = requireConn() ?: return
        val userLine = ChatLine(
            key = "pending-${System.currentTimeMillis()}",
            role = "user",
            text = body,
            kind = "user/message",
        )
        // 进入「电脑准备中」阶段 0，并立即乐观呈现用户消息
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
            val schedule = listOf(600L, 1600L, 3000L) // 到 step1/2/3 的延迟
            for ((i, delay) in schedule.withIndex()) {
                kotlinx.coroutines.delay(delay)
                if (!_state.value.preparing) return@launch
                _state.update { it.copy(preparingStep = i + 1) }
            }
        }

        viewModelScope.launch {
            // args 的键名必须是服务端声明的形参名 `request`（实测确认）。
            // 内部的字段名则来自 SessionPromptRequest 的业务定义。
            c.call("session.prompt", buildJsonObject {
                put("request", buildJsonObject {
                    // requestId 与 sessionId 同为必填。
                    put("requestId", java.util.UUID.randomUUID().toString())
                    put("sessionId", _state.value.sessionId)
                    put("mode", "queue")
                    put("content", kotlinx.serialization.json.buildJsonArray {
                        add(buildJsonObject { put("type", "text"); put("text", body) })
                    })
                })
            }).onSuccess {
                // 主机已接收：进入最后阶段，然后交给 running 接管
                _state.update {
                    it.copy(
                        sending = false,
                        running = true,
                        preparing = false,
                        preparingStep = 3,
                    )
                }
                reload()
            }.onFailure { error ->
                _state.update {
                    it.copy(sending = false, preparing = false, error = error.message)
                }
            }
        }
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
                if (rawArgs == null) "调用 $toolName" else "调用 $toolName · ${JsonRender.compact(rawArgs, 200)}"
            }
            "tool/result" -> {
                val message = data?.get("message") as? JsonObject
                toolCallId = JsonRender.str(message ?: data, "toolCallId", "callId")
                isError = JsonRender.bool(message ?: data, "isError", "error") ?: false
                val content = message?.get("content") ?: data?.get("content") ?: data?.get("result")
                val res = JsonRender.contentToText(content)
                    ?: JsonRender.textOf(content)
                    ?: (data ?: entry)?.let { JsonRender.compact(it, 500) }
                    ?: ""
                toolResult = res
                res
            }
            else -> {
                val content = (data?.get("message") as? JsonObject)?.get("content")
                    ?: data?.get("content")
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

    private fun detectRunning(page: JsonObject): Boolean {
        val records = recordsOf(page)
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