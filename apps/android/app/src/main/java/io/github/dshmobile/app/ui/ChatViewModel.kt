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

    fun reload() {
        val c = requireConn() ?: return
        viewModelScope.launch {
            c.call("session.history", buildJsonObject {
                put("sessionId", _state.value.sessionId)
                put("maxMessages", 80)
            }).onSuccess { value ->
                val obj = value.jsonObject
                val events = JsonRender.arr(obj, "events") ?: JsonArray(emptyList())
                val lines = events.mapIndexedNotNull { i, e -> toLine(e as? JsonObject, i) }
                lastSeq = obj["cursor"]?.jsonPrimitive?.content?.toLongOrNull()
                    ?: lines.size.toLong()
                _state.update { it.copy(lines = lines, loading = false, error = null) }
            }.onFailure { error ->
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    /**
     * 轮询而不是订阅流。
     *
     * 官方把 `session/follow` 定义成 RemoteStreamHandle——客户端要用稳定的 rpcId 发起，
     * 主机再以 `server-request` 帧回推、客户端逐帧回 `client-response`。那条链路的帧形状
     * 在已公开的官方包里没有可验证的定义。与其猜一个可能错的形式，不如先用必然可用的
     * `session.history` 轮询把体验跑通；确认了流协议再切换（见 docs/api-contract.md 的 Gaps）。
     */
    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(1_600)
                val c = conn ?: continue
                val sid = _state.value.sessionId
                if (sid.isEmpty() || _state.value.pending != null) continue
                // call() 本身返回 Result 且不抛，这里不再套 runCatching。
                c.call(
                    "session.history",
                    buildJsonObject {
                        put("sessionId", sid)
                        put("maxMessages", 30)
                    },
                    timeoutMs = 8_000,
                ).onSuccess { value ->
                    val obj = value.jsonObject
                    val events = JsonRender.arr(obj, "events") ?: return@onSuccess
                    val fresh = events.mapIndexedNotNull { i, e ->
                        val entry = e as? JsonObject ?: return@mapIndexedNotNull null
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
            c.call("session.prompt", buildJsonObject {
                put("sessionId", _state.value.sessionId)
                put("mode", "queue")
                put("content", kotlinx.serialization.json.buildJsonArray {
                    add(buildJsonObject { put("type", "text"); put("text", body) })
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
            c.call("session.cancel", buildJsonObject { put("sessionId", _state.value.sessionId) })
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

    private fun detectRunning(history: JsonObject): Boolean {
        val events = JsonRender.arr(history, "events") ?: return false
        var running = false
        events.forEach { e ->
            val entry = e as? JsonObject ?: return@forEach
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