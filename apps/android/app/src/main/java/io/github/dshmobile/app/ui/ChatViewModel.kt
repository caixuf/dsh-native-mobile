package io.github.dshmobile.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.dshmobile.app.net.DshConnection
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

data class PendingPrompt(
    val rpcId: String,
    val method: String,
    val title: String,
    val body: String,
    val options: List<String>,
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
                lastSeq = lines.size.toLong()
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
     */
    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(1_600)
                val c = conn ?: continue
                val sid = _state.value.sessionId
                if (sid.isEmpty() || _state.value.pending != null) continue
                // 走 fetchPage 以复用 cursor 自适应逻辑。
                fetchPage(c, sid, 30).onSuccess { value ->
                    val obj = value.jsonObject
                    val records = recordsOf(obj)
                    val fresh = records.mapIndexedNotNull { i, entry ->
                        val seq = entry["seq"]?.jsonPrimitive?.content?.toLongOrNull()
                        if (seq != null && lastSeq >= 0 && seq <= lastSeq) null else toLine(entry, i)
                    }
                    if (fresh.isNotEmpty()) {
                        _state.update { it.copy(lines = it.lines + fresh) }
                    }
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

    /** 审批与提问都以稳定 rpcId 从下行流推来；答过就不再弹。 */
    private fun handleHostRequest(c: DshConnection, req: HostRequest) {
        val method = req.method.lowercase()
        if (!method.contains("approval") && !method.contains("question") && !method.contains("ask")) return
        val title = JsonRender.str(req.payload, "title", "name", "question", "tool") ?: "需要你确认"
        val body = JsonRender.textOf(req.payload["prompt"] ?: req.payload["message"] ?: req.payload["content"])
            ?: JsonRender.compact(req.payload, 400)
        val options = JsonRender.arr(req.payload, "options")
            ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
            .orEmpty()
        _state.update { it.copy(pending = PendingPrompt(req.rpcId, req.method, title, body, options)) }
    }

    fun answer(value: JsonObject) {
        val c = requireConn() ?: return
        val pending = _state.value.pending ?: return
        _state.update { it.copy(pending = null) }
        viewModelScope.launch {
            val ok = c.respond(pending.rpcId, value)
            if (!ok) _state.update { it.copy(error = "应答未被主机接受（可能已过期）") }
        }
    }

    fun approve(approved: Boolean, remember: Boolean = false) {
        answer(
            buildJsonObject {
                put("kind", if (approved) "allow" else "deny")
                put("approved", approved)
                if (remember) put("remember", true)
            },
        )
    }

    fun answerOption(text: String) {
        answer(buildJsonObject { put("kind", "answer"); put("answer", text) })
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

    private fun toLine(entry: JsonObject?, index: Int): ChatLine? {
        if (entry == null) return null
        val seq = JsonRender.long(entry, "seq") ?: index.toLong()
        val kind = JsonRender.typeOf(entry)
        val role = JsonRender.roleOf(entry)
        val text = JsonRender.textOf(entry["data"])
            ?: JsonRender.textOf(entry["message"])
            ?: JsonRender.textOf(entry["content"])
            ?: JsonRender.textOf(entry["result"])
            ?: JsonRender.textOf(entry)
            ?: return null
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