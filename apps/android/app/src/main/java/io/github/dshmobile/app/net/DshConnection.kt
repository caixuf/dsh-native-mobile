package io.github.dshmobile.app.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
import kotlinx.coroutines.withContext
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
 * 组成：**一条** mux WebSocket（`/mobile-gateway/remote.mux` → 主机 `/api/remote.mux`）
 * 承载若干逻辑流，其中一条是事件流 `$events`；另有一条 HTTP 一问一答通道
 * （审批/提问的应答也走它，endpoint `$events/result`）。
 *
 * 就绪判定：mux 已开 + 一次 `session.list` 成功 —— 与官方客户端的判定一致，
 * 否则会出现「看起来连上了但收不到任何事件」的假在线。
 *
 * 重连：指数退避 500ms×2ⁿ，上限 10s，带抖动。主机下发的提问/审批带**稳定的 eventId**，
 * 重连后会被重放，因此已处理过的必须按 eventId 去重。
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

    @Volatile private var muxSocket: WebSocket? = null
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
        muxSocket = null
        eventClientId = null
        _state.value = LinkState.Disconnected
    }

    private fun openAll() {
        if (stopped) return
        attempt += 1
        _state.value = LinkState.Connecting(attempt)
        // 🔴 真实主机只有**一条** mux WebSocket（`/api/remote.mux`），
        // 不是两条 `events.mux` / `events.host` —— 后两者在权威源码里零出现，
        // 实测连上去主机立刻回 `invalid Remote endpoint` 并断开。
        // 见 lib/bridge.mjs 顶部的取证说明。
        openSocket { socket ->
            muxSocket = socket
            muxOpen.set(true)
            // 连上后立刻开一条**逻辑流**：endpoint `$events`，payload 必须是 {args:{}}。
            socket.send(
                buildJsonObject {
                    put("type", "open")
                    put("streamId", eventStreamId)
                    put("endpoint", EVENT_STREAM_ENDPOINT)
                    put("payload", buildJsonObject { put("args", buildJsonObject {}) })
                }.toString(),
            )
            onSocketOpen()
        }
    }

    private fun onSocketOpen() {
        if (!muxOpen.get()) return
        scope.launch {
            // 就绪判定：mux 已开 + 一次真实的 RPC 成功。
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

    /** 本次逻辑事件流的 streamId（每次重连换一个新的）。 */
    private var eventStreamId: String = java.util.UUID.randomUUID().toString()

    /**
     * 事件流的 clientId —— 由主机在 `ready` 帧里下发。
     *
     * 🔴 应答审批/提问时**必须**带上它：`$events/result` 的 args 是
     * `{clientId, eventId, outcome}`，主机用它定位是哪个活跃事件流。
     */
    @Volatile private var eventClientId: String? = null

    private fun openSocket(onOpen: (WebSocket) -> Unit) {
        val request = Request.Builder()
            .url(baseUrl.replaceFirst(Regex("^http"), "ws") + WS_MUX)
            .header("Authorization", "Bearer $token")
            .build()

        http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen(webSocket)

            /**
             * 处理 mux 上的一条帧。
             *
             * 主机 → 客户端只有三种（权威 stream-protocol.ts）：
             *   item  { streamId, value? }   ← value 才是业务帧
             *   end   { streamId }
             *   error { streamId, error:{code,message,details} }
             *
             * `item.value` 是 `$events` 流的四种之一：
             *   ready     { clientId, host }        —— 记下 clientId
             *   emit      { event, args }           —— 纯通知
             *   waterfall { event, eventId, agentId, request } —— **需要应答**（审批/提问）
             *   cancel    { eventId }
             */
            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching { Envelopes.json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                when (frame.str("type")) {
                    "item" -> handleStreamItem(frame.obj("value") ?: return)
                    "end" -> scheduleReconnect("事件流被主机关闭")
                    "error" -> {
                        val message = frame.obj("error")?.str("message") ?: "事件流出错"
                        scheduleReconnect(message)
                    }
                    else -> Unit // 未知帧类型向前兼容丢弃（协议演进不发版）
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                muxOpen.set(false)
                muxSocket = null
                eventClientId = null
                scheduleReconnect(t.message ?: "连接中断")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                muxOpen.set(false)
                muxSocket = null
                eventClientId = null
                if (!stopped) scheduleReconnect(reason.ifEmpty { "连接被关闭" })
            }
        })
    }

    /** 处理 `$events` 逻辑流的一个 item。 */
    private fun handleStreamItem(value: JsonObject) {
        when (value.str("type")) {
            "ready" -> {
                eventClientId = value.str("clientId")
                value.obj("host")?.str("home")?.let { hostName = it }
            }
            "emit" -> {
                val event = value.str("event") ?: return
                // 纯通知（如 schedule/changed、api-session/activity）—— **不需要应答**。
                // answerable=false 让消费端不会把它弹成审批框。
                _hostRequests.tryEmit(
                    HostRequest(rpcId = event, method = event, payload = value, answerable = false),
                )
            }
            "waterfall" -> {
                val event = value.str("event") ?: return
                val eventId = value.str("eventId") ?: return
                // 用 eventId 作为应答标识（主机靠它定位 pending）。
                if (!answered.add(eventId)) return
                _hostRequests.tryEmit(
                    HostRequest(
                        rpcId = eventId,
                        method = event,
                        payload = value.obj("request") ?: value,
                        answerable = true,
                    ),
                )
            }
            "cancel" -> Unit
            else -> Unit
        }
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

        // 🔴 JSON 解析必须**留在 IO 线程**（2026-10-14 真机性能审计发现）。
        //
        // 原实现把 `parseToJsonElement` 放在 `withContext(IO)` 块**外面** ——
        // 它于是回到调用方上下文执行，而调用方是 `viewModelScope`（= Main.immediate）。
        //
        // 后果：每次 `session.page` 轮询（2.5s 一次）都在**主线程**解析 JSON。
        // 实测单次响应体 **468 KB / 147 条记录**，主线程解析这么大一块
        // 必然掉帧 —— 这正是"界面不丝滑"的一个直接来源。
        //
        // 现在解析与读取一起在 IO 完成，只把**已经解析好的 JsonObject** 交回去。
        val frame = withContext(Dispatchers.IO) {
            // 🔴 两个都必须：① 阻塞式 execute() 不能在主线程跑（否则
            // NetworkOnMainThreadException，请求根本发不出去）；② 超时交给
            // OkHttp 自己的 readTimeout —— 原来的 withTimeoutOrNull 包一个阻塞调用
            // 是**中断不了**的，服务器不响应就会一直挂着。
            val callClient = if (timeoutMs > 0) {
                http.newBuilder()
                    .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()
            } else {
                http
            }
            val raw = callClient.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw DshCallException("transport_${response.code}", "$method 失败：HTTP ${response.code}")
                }
                text
            }
            Envelopes.json.parseToJsonElement(raw).jsonObject
        }

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

    /**
     * 应答一条主机下发的提问/审批。
     *
     * 🔴 2026-10-13 公网实测 + 权威源码取证：**真实主机没有 `/api/respond`**
     * （全 asar 零命中；实测直连 401、经网关 404）。正确通道是 RPC endpoint
     * `$events/result`，args 形状（`parseRemoteEventResult` 逐字）：
     *
     *     { clientId, eventId, outcome:
     *         { kind:'next' } |
     *         { kind:'result', value? } |
     *         { kind:'rejected', error:{name,message,code?,details?} } }
     *
     * `clientId` 来自事件流的 `ready` 帧，`eventId` 来自 `waterfall` 帧。
     * 实测：带一个假 clientId 打过去，主机会回
     * `typert gateway: Remote event result identifies no active event stream`
     * —— 证明端点存在，只是没有活跃流。而 `/api/respond` 是 404。
     */
    suspend fun respond(eventId: String, outcome: JsonObject): Boolean {
        val clientId = eventClientId ?: return false
        val rpcId = "r${ids.incrementAndGet()}"
        val body = Envelopes.clientRequest(rpcId, EVENT_RESULT_ENDPOINT, buildJsonObject {
            put("clientId", clientId)
            put("eventId", eventId)
            put("outcome", outcome)
        }).toString().toRequestBody(JSON_MEDIA)
        val request = Request.Builder()
            .url(baseUrl + API_PREFIX + EVENT_RESULT_ENDPOINT)
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .post(body)
            .build()
        return runCatching {
            withContext(Dispatchers.IO) {
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use false
                    val frame = Envelopes.json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
                    frame.obj("result")?.bool("ok") == true
                }
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
        /**
         * 唯一的 mux WebSocket。
         *
         * 🔴 真实主机只有这一条（权威常量 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`）。
         * 原来的 `events.mux` / `events.host` 两条在真实源码里零出现，
         * 实测连上去主机立刻回 `invalid Remote endpoint` 并断开。
         */
        const val WS_MUX = "/mobile-gateway/remote.mux"

        /** 事件流的内部 endpoint（真实主机侧常量，不是我们编的）。 */
        const val EVENT_STREAM_ENDPOINT = "\$events"

        /** 审批/提问的应答通道（**不是** `/api/respond`，那个端点不存在）。 */
        const val EVENT_RESULT_ENDPOINT = "\$events/result"

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