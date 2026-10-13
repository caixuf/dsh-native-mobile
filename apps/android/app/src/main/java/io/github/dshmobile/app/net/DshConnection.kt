package io.github.dshmobile.app.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/**
 * 与一台 DSH 实例的连接。
 *
 * 组成：两条只下行的 WebSocket（`events.mux` / `events.host`）+ 一条 HTTP 一问一答通道。
 * 只有两条流都打开、且 `host.describe` 成功，才算 Ready——与官方客户端的判定一致，
 * 否则会出现「看起来连上了但收不到任何事件」的假在线。
 *
 * 重连：指数退避 500ms×2ⁿ，上限 10s，带抖动。主机下发的提问/审批带**稳定的 rpcId**，
 * 重连后会被重放，因此已处理过的必须按 rpcId 去重。
 */
class DshConnection(
    private val scope: CoroutineScope,
    private val baseUrl: String,
    private val token: String,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    private val _state = MutableStateFlow<LinkState>(LinkState.Disconnected)
    val state: StateFlow<LinkState> = _state.asStateFlow()

    private val _hostRequests = MutableSharedFlow<HostRequest>(replay = 8, extraBufferCapacity = 64)
    val hostRequests: SharedFlow<HostRequest> = _hostRequests.asSharedFlow()

    /** 已应答过的 rpcId，避免重连重放时重复弹窗。 */
    private val answered = LinkedHashSet<String>()

    private val ids = AtomicLong(0)
    private val lifecycle = Mutex()

    private val muxOpen = java.util.concurrent.atomic.AtomicBoolean(false)
    private val hostOpen = java.util.concurrent.atomic.AtomicBoolean(false)

    @Volatile private var muxSocket: WebSocket? = null
    @Volatile private var hostSocket: WebSocket? = null
    @Volatile private var reconnectJob: Job? = null
    @Volatile private var stopped = false
    @Volatile private var attempt = 0

    // ---- 生命周期 ---------------------------------------------------------

    fun start() {
        scope.launch { lifecycle.withLock { openAll() } }
    }

    fun stop() {
        stopped = true
        reconnectJob?.cancel()
        muxSocket?.close(1000, "client closed")
        hostSocket?.close(1000, "client closed")
        muxSocket = null
        hostSocket = null
        _state.value = LinkState.Disconnected
    }

    private fun openAll() {
        if (stopped) return
        attempt += 1
        _state.value = LinkState.Connecting(attempt)
        openSocket("mux") { socket ->
            muxSocket = socket
            muxOpen.set(true)
            onSocketOpen()
        }
        openSocket("host") { socket ->
            hostSocket = socket
            hostOpen.set(true)
            onSocketOpen()
        }
    }

    private fun onSocketOpen() {
        if (!muxOpen.get() || !hostOpen.get()) return
        scope.launch {
            // 就绪判定：两条流都开 + 一次真实的 RPC 成功。
            //
            // ⚠️ 早前用的是 `host.describe`，但**真实主机没有这个方法**
            // （实测 `host/describe` → 404 not found；枚举出的 41 个 endpoint 里没有它）。
            // 改用 `session.list` —— 它必然存在，且能顺带验证鉴权与 payload 形状都对。
            val probe = call("session.list", buildJsonObject { put("_request", buildJsonObject {}) }, timeoutMs = 8_000)
            if (stopped) return@launch
            if (probe.isSuccess) {
                attempt = 0
                _state.value = LinkState.Ready(hostName)
            } else {
                _state.value = LinkState.Degraded(
                    "主机未响应 session.list：${probe.exceptionOrNull()?.message ?: "未知原因"}",
                    attempt,
                )
                scheduleReconnect("握手未完成")
            }
        }
    }

    /** 实例名（从下行流里的主机信息学出来；拿不到就显示空）。 */
    private var hostName: String = ""

    private fun openSocket(which: String, onOpen: (WebSocket) -> Unit) {
        val path = if (which == "mux") "$WS_MUX" else "$WS_HOST"
        val request = Request.Builder()
            .url(baseUrl.replaceFirst(Regex("^http"), "ws") + path)
            .header("Authorization", "Bearer $token")
            .build()

        http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching { Envelopes.json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                if (frame.str("type") != Envelopes.TYPE_SERVER_REQUEST) return
                val rpcId = frame.str("rpcId") ?: return
                val method = frame.str("method") ?: return
                if (!answered.add(rpcId)) return // 重连重放，去重
                val payload = frame.obj("payload") ?: JsonObject(emptyMap())
                _hostRequests.tryEmit(HostRequest(rpcId, method, payload))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (which == "mux") {
                    muxOpen.set(false)
                    muxSocket = null
                } else {
                    hostOpen.set(false)
                    hostSocket = null
                }
                scheduleReconnect(t.message ?: "连接中断")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (which == "mux") {
                    muxOpen.set(false)
                    muxSocket = null
                } else {
                    hostOpen.set(false)
                    hostSocket = null
                }
                if (!stopped) scheduleReconnect(reason.ifEmpty { "连接被关闭" })
            }
        })
    }

    private fun scheduleReconnect(cause: String) {
        if (stopped || reconnectJob?.isActive == true) return
        _state.value = LinkState.Degraded(cause, attempt)
        // 500ms × 2ⁿ，上限 10s，50–100% 抖动。
        val base = (500L shl (attempt.coerceAtMost(5) - 1)).coerceIn(500L, 10_000L)
        val jitter = base / 2 + Random.nextLong(base / 2 + 1)
        reconnectJob = scope.launch {
            delay(jitter)
            lifecycle.withLock { openAll() }
        }
    }

    // ---- 一问一答 ---------------------------------------------------------

    /**
     * 调用 `POST /api/<method>`。
     *
     * 传输故障与业务故障是两条不同的路径：非 2xx 与信封层错误直接抛
     * [DshCallException]；`result.ok === false` 也以异常形式抛出，调用方统一处理。
     */
    suspend fun call(
        method: String,
        args: JsonObject = JsonObject(emptyMap()),
        timeoutMs: Long = 30_000,
    ): Result<JsonElement> = runCatching {
        val rpcId = "r${ids.incrementAndGet()}"
        // 注意：URL 用 **endpoint 形式**（斜杠），不是点号形式。
        // 实测 `session/list` → 200，`session.list` → 404 not found。
        val endpoint = Envelopes.toEndpoint(method)
        val body = Envelopes.clientRequest(rpcId, method, args).toString()
            .toRequestBody(JSON_MEDIA)

        val request = Request.Builder()
            .url(baseUrl + API_PREFIX + endpoint)
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .post(body)
            .build()

        val text = withTimeoutOrNull(timeoutMs) {
            http.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw DshCallException("transport_${response.code}", "$method 失败：HTTP ${response.code}")
                }
                raw
            }
        } ?: throw DshCallException("timeout", "$method 在 ${timeoutMs}ms 内没有响应")

        val frame = Envelopes.json.parseToJsonElement(text).jsonObject
        if (frame.str("rpcId") != rpcId) {
            throw DshCallException("rpc_id_mismatch", "$method 的 rpcId 与请求不一致")
        }
        val result = frame.obj("result") ?: throw DshCallException("malformed", "$method 的应答缺少 result")
        if (result.bool("ok") == true) {
            result["value"] ?: kotlinx.serialization.json.JsonNull
        } else {
            val error = result.obj("error")
            throw DshCallException(
                error?.str("code") ?: "unknown",
                error?.str("message") ?: "$method 返回了未知的错误",
            )
        }
    }

    /** 应答一条主机下发的提问/审批（官方走 `POST /api/respond`，不是 WS）。 */
    suspend fun respond(rpcId: String, result: JsonObject): Boolean {
        val body = Envelopes.clientResponse(rpcId, result).toString().toRequestBody(JSON_MEDIA)
        val request = Request.Builder()
            .url(baseUrl + API_PREFIX + "respond")
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .post(body)
            .build()
        return runCatching {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use false
                val frame = Envelopes.json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
                frame.bool("accepted") == true
            }
        }.getOrDefault(false)
    }

    /** 主动 ping 一问一答通道，验证令牌是否仍然有效。 */
    suspend fun ping(): Boolean =
        call("session.list", buildJsonObject { put("_request", buildJsonObject {}) }, timeoutMs = 8_000).isSuccess

    companion object {
        /**
         * `throughSeq` 的初值。真实主机要求它不超过会话 cursor，
         * 超过时会回 "past cursor N"，届时用 N 重试（见 ChatViewModel.fetchPage）。
         * 这里取一个常见会话量级的值，多数情况下一次就中。
         */
        const val DEFAULT_THROUGHPUT_SEQ = 1_000_000L

        const val API_PREFIX = "/mobile-gateway/api/"
        const val WS_MUX = "/mobile-gateway/events.mux"
        const val WS_HOST = "/mobile-gateway/events.host"
        const val PAIR_PATH = "/mobile-gateway/pair"
        /** 账号密码登录入口（首选，比配对码好记）。 */
        const val LOGIN_PATH = "/mobile-gateway/login"
        const val HEALTH_PATH = "/mobile-gateway/health"

        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // 下行流不设读超时
            .writeTimeout(15, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}