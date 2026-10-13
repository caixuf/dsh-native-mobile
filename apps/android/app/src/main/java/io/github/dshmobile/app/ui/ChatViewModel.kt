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
)

class ChatViewModel(private val conn: DshConnection?) : ViewModel() {

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private var pollJob: Job? = null
    private var hostJob: Job? = null
    private var lastSeq: Long = -1
    private var started = false

    fun open(sessionId: String, title: String) {
        if (started && _state.value.sessionId == sessionId) return
        started = true
        lastSeq = -1
        _state.value = ChatUiState(sessionId = sessionId, title = title)
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
     * `throughSeq` 有「不能超过 cursor」的约束，而 cursor 只有主机知道。
     * 所以这里做一次**自适应重试**：先试一个值，若主机回 "past cursor N"，
     * 就用 N 重试。这比猜一个上限可靠（实测 Long.MAX_VALUE 必被拒）。
     */
    private suspend fun fetchPage(c: DshConnection, sid: String, maxMessages: Int): Result<JsonElement> {
        val guess = if (cursor > 0) cursor else DshConnection.DEFAULT_THROUGHPUT_SEQ
        val first = c.call("session.page", pageArgs(sid, guess, maxMessages))
        val message = first.exceptionOrNull()?.message
        val learned = learnCursor(message)
        if (learned != null && learned != guess) {
            cursor = learned
            return c.call("session.page", pageArgs(sid, learned, maxMessages))
        }
        return first
    }

    fun reload() {
        val c = requireConn() ?: return
        val sid = _state.value.sessionId
        viewModelScope.launch {
            fetchPage(c, sid, 80).onSuccess { value ->
                val obj = value.jsonObject
                val lines = recordsOf(obj).mapIndexedNotNull { i, e -> toLine(e, i) }
                // 记录最后一条的 seq，轮询时从它之后增量拉。
                lastSeq = recordsOf(obj).lastOrNull()?.get("seq")
                    ?.jsonPrimitive?.content?.toLongOrNull() ?: lastSeq
                _state.update { it.copy(lines = lines, loading = false, error = null) }
            }.onFailure { error ->
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    /**
     * 轮询而不是订阅流。
     *
     * 官方把 `session/follow` 定义成 RemoteStreamHandle——客户端要用稳定 rpcId 发起，
     * 主机再以 `server-request` 帧回推、客户端逐帧回 `client-response`。那条链路的帧形状
     * 在已公开的官方包里没有可验证的定义。与其猜一个可能错的形式，不如先用必然可用的
     * `session.page` 轮询把体验跑通；确认了流协议再切换（见 docs/api-contract.md 的 Gaps）。
     *
     * ## 性能（实测数据，别删）
     *
     * `session/page` 的 `maxMessages` **不限制 records 条数**——它限的是消息窗口，
     * 一轮里的 step/tool 事件全都会回来。实测 30 条请求实际返回 149 条 / 268 KB，
     * 公网链路（FRP 隧道）每 1.6s 全量拉一次 = 手机每秒下载 170 KB，这就是卡顿来源。
     *
     * 三个对策：
     *  1. **增量拉取**：轮询用 `lastSeq` 作为 `throughSeq`，只拉新增部分（几 KB）
     *  2. **降频**：1.6s → 3s（增量后单次只有几 KB，3s 足够跟手）
     *  3. **maxMessages 只是兜底**：增量模式下通常一次只回几条
     */
    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(3_000)
                val c = conn ?: continue
                val sid = _state.value.sessionId
                if (sid.isEmpty() || _state.value.pending != null) continue
                // 增量：从 lastSeq 之后拉。lastSeq<0 说明还没初始化，先全量。
                val throughSeq = if (lastSeq > 0) lastSeq else DshConnection.DEFAULT_THROUGHPUT_SEQ
                val r = c.call(
                    "session.page",
                    buildJsonObject {
                        put("request", buildJsonObject {
                            put("address", buildJsonObject {
                                put("kind", "session")
                                put("sessionId", sid)
                            })
                            put("throughSeq", throughSeq)
                            put("maxMessages", 30)
                        })
                    },
                    timeoutMs = 8_000,
                )
                // "past cursor N" 说明我们的 lastSeq 落后于主机裁剪点（会话被压缩过），
                // 丢掉本地全量重新同步一次。
                val err = r.exceptionOrNull()?.message
                val learned = learnCursor(err)
                if (learned != null) {
                    cursor = learned
                    reload()
                    continue
                }
                r.onSuccess { value ->
                    val obj = value.jsonObject
                    val records = recordsOf(obj)
                    val fresh = records.mapIndexedNotNull { i, entry ->
                        val seq = entry["seq"]?.jsonPrimitive?.content?.toLongOrNull()
                        if (seq != null && lastSeq >= 0 && seq <= lastSeq) null else toLine(entry, i)
                    }
                    if (fresh.isNotEmpty()) {
                        _state.update { it.copy(lines = it.lines + fresh) }
                    }
                    // 推进 lastSeq 到本页最大 seq，下轮从这里增量
                    records.lastOrNull()?.get("seq")?.jsonPrimitive?.content?.toLongOrNull()
                        ?.takeIf { it > lastSeq }?.let { lastSeq = it }
                    _state.update { it.copy(running = detectRunning(obj)) }
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
        val c = requireConn() ?: return
        val body = text.trim()
        if (body.isEmpty() || _state.value.sending) return
        _state.update { it.copy(sending = true, error = null) }
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
                _state.update { it.copy(sending = false, running = true) }
                reload()
            }.onFailure { error ->
                _state.update { it.copy(sending = false, error = error.message) }
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

        // tool/call 特例：arguments 是字符串，需要单独拼装，不能走通用 textOf。
        val text = if (kind == "tool/call") {
            val name = JsonRender.str(data, "name") ?: "工具"
            val args = data?.get("arguments")
            if (args == null) "调用 $name" else "调用 $name · ${JsonRender.compact(args, 200)}"
        } else {
            // 优先按 content 数组抽正文 —— 实测 tool/result 的正文在
            // data.message.content[]（元素是 {type:'text',text} 对象），
            // 直接走 textOf 会落到 compact() 而显示 [object Object]。
            val content = (data?.get("message") as? JsonObject)?.get("content")
                ?: data?.get("content")
            JsonRender.contentToText(content)
                ?: JsonRender.textOf(data)
                ?: JsonRender.textOf(entry["message"])
                ?: JsonRender.textOf(entry["content"])
                ?: return null
        }
        return ChatLine(key = "$seq-$kind-$index", role = role, text = text, kind = kind)
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