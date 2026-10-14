package io.github.dshmobile.app.relay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * 审批中继服务 —— **产品核心能力的落点**。
 *
 * ## 为什么必须有它
 *
 * 手机上的页面活在 WebView 里，`onPause()` 一到，WebView 的 JS 定时器与 WebSocket
 * 就被系统挂起。所以「电脑端等授权 → 手机立刻收到」在纯 WebView 方案下**根本不成立**：
 * 用户锁屏或切后台的那一刻，连接就断了，审批静静躺在电脑上等。
 *
 * 它做三件事：
 * 1. 前台服务持有**原生** WebSocket（不受 WebView 生命周期影响），订阅 `$events`；
 * 2. 收到 `waterfall` 就发**带按钮的通知**，锁屏/下拉通知栏即可直接允许或拒绝；
 * 3. 按钮 → [RelayActionReceiver] → 直接 POST `$events/result` 回主机。
 *
 * ## 已明确处理的四种失败（都不是"重试就好"）
 *
 * - **401/403**：令牌失效。**停止重连**并提示重新配对 —— 否则配上"断线不退避"
 *   就是无限重试死循环，用户永远等不到东西还不知道为什么。
 * - **通知未授权**（Android 13+ `POST_NOTIFICATIONS`）：审批到了也看不见，如实上报。
 * - **半开连接**：靠 OkHttp `pingInterval` 发现 TCP 已死（否则会假装连着）。
 * - **重启后重复弹已处理审批**：已应答账本**落盘**（见 [RelayStore]）。
 *
 * ## 已知平台限制（写在代码里，别让后来人以为是 bug）
 *
 * - API 34 起 `dataSync` 型前台服务有**每日时长上限**，超时后系统会停掉服务；
 *   这是平台约束，不是本服务写得不对。恢复前台时（重开 App）会重新拉起。
 * - 通知按钮的可用性由系统与厂商 ROM 决定；本服务保证"至少有通知"。
 */
class ApprovalRelayService : Service() {

    private lateinit var store: RelayStore
    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var attempt = 0
    private var stopped = false
    private var reconnectScheduled = false
    private var foregroundStarted = false

    override fun onCreate() {
        super.onCreate()
        store = RelayStore(this)
        RelayNotifications.ensureChannels(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * 状态迁移必须可观测。
     *
     * 没有日志时，「手机上什么都没发生」「服务根本没起来」「通知被系统吞了」
     * 三种情况完全无法区分 —— 这正是本项目反复吃过的亏。查：
     * `adb logcat -s DshRelay`
     */
    private fun log(message: String) = Log.i(TAG, message)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            log("收到 STOP → 关闭中继")
            shutdown()
            return START_NOT_STICKY
        }

        if (!store.isConfigured()) {
            log("未配对 → 不启动")
            // 没配对就没有可守的东西。前台通知先立住再退出，避免
            // startForegroundService 后 5 秒内没 startForeground 被判 ANR。
            updateForeground("未配对：请先在 App 里连接电脑")
            stopSelf()
            return START_NOT_STICKY
        }

        log("启动中继服务（配置的主机：${store.baseUrl}）")

        stopped = false
        state = STATE_CONNECTING
        updateForeground("正在连接电脑…")

        // 配置可能刚刚变化（重新配对/换主机）：取消待执行的重连，强制连一次。
        handler.removeCallbacksAndMessages(null)
        reconnectScheduled = false
        socket?.cancel()
        socket = null
        connect()

        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        socket?.cancel()
        socket = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        state = STATE_STOPPED
        super.onDestroy()
    }

    // ── 连接 ────────────────────────────────────────────────────────────────

    private fun connect() {
        if (stopped) return
        val baseUrl = store.baseUrl ?: return
        val token = store.token ?: return
        log("连接中：${RelayClient.wsUrl(baseUrl)}（令牌走 Authorization 头，不进 URL）")

        // 🔴 令牌走请求头。原生端做得到，WebView 做不到（浏览器规范不允许
        // 给 WebSocket 设自定义头），所以网页端只能用 ?token= —— 这也是
        // "原生中继比网页连接更安全"的具体收益。
        val request = Request.Builder()
            .url(RelayClient.wsUrl(baseUrl))
            .addHeader("Authorization", "Bearer $token")
            .build()

        socket = RelayClient.http.newWebSocket(request, MuxListener())
    }

    private inner class MuxListener : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempt = 0
            store.rememberLastError(null)
            state = STATE_HANDSHAKING
            log("WS 已建立，发送 open 帧（endpoint=\$events）")
            updateForeground("已连接 · 等待审批")
            // open 帧必须**精确 4 键**，否则网关以 1008 关闭连接。
            webSocket.send(ApprovalContract.openEventStream("s-${System.currentTimeMillis()}"))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handleFrame(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            onDisconnected(null, "连接已关闭（code=$code）")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            onDisconnected(response?.code, t.message ?: "网络异常")
        }
    }

    private fun onDisconnected(httpCode: Int?, reason: String) {
        socket = null
        if (stopped) return
        log("断开：httpCode=${httpCode ?: "无"} reason=$reason")
        if (httpCode == 401 || httpCode == 403) {
            onAuthFailure(httpCode)
            return
        }
        scheduleReconnect(reason)
    }

    private fun scheduleReconnect(reason: String) {
        if (stopped || reconnectScheduled) return
        reconnectScheduled = true
        attempt += 1
        // 上限 30s：更激进只会耗电，而且弱网下更糟。
        val backoff = minOf(30_000L, 1_000L * (1L shl minOf(attempt - 1, 5)))
        store.rememberLastError(reason)
        state = STATE_RETRYING
        log("第 $attempt 次重连将在 ${backoff / 1000}s 后（原因：$reason）")
        updateForeground("重连中（第 $attempt 次，${backoff / 1000}s 后）")
        handler.postDelayed({
            reconnectScheduled = false
            if (!stopped) connect()
        }, backoff)
    }

    /**
     * 令牌失效 —— **不能重试**。
     *
     * 这是与"网络抖动"必须分开的一类错误：重试一万次也永远不会成功，
     * 而用户只会看到"连不上"。这里停下来并明确要求重新配对。
     */
    private fun onAuthFailure(code: Int) {
        stopped = true
        state = STATE_AUTH_FAILED
        val message = "${RelayClient.httpMessage(code)} —— 请在 App 里重新配对"
        store.rememberLastError(message)
        log("令牌失效（HTTP $code）→ **停止重连**并要求重新配对（不重试：重试一万次也不会成功）")
        updateForeground("已停止：设备令牌失效")

        val enabled = RelayNotifications.notificationsEnabled(this)
        log("通知是否可用=$enabled（false 表示审批到了手机也不会显示）")
        if (enabled) {
            NotificationManagerCompat.from(this).notify(
                RelayNotifications.ID_STATUS,
                RelayNotifications.status(this, "需要重新配对", message),
            )
            log("已发出「需要重新配对」通知 id=${RelayNotifications.ID_STATUS}")
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ── 帧处理 ──────────────────────────────────────────────────────────────

    private fun handleFrame(text: String) {
        when (val frame = MuxCodec.decode(text)) {
            is ServerFrame.Item -> handleEvent(MuxCodec.decodeEvent(frame.value))
            is ServerFrame.End -> onDisconnected(null, "事件流被主机关闭")
            is ServerFrame.Failure -> scheduleReconnect(frame.message)
            // 坏帧不致命：一条解析不了的帧不该打断整条审批通道。
            is ServerFrame.Invalid -> Unit
        }
    }

    private fun handleEvent(event: EventMessage) {
        when (event) {
            is EventMessage.Ready -> {
                store.rememberClientId(event.clientId)
                store.rememberLastError(null)
                state = STATE_CONNECTED
                attempt = 0
                log("事件流就绪，clientId=${event.clientId}（应答必须带上它）")
                updateForeground("已连接 · 等待审批")
            }

            is EventMessage.Waterfall -> onWaterfall(event)

            is EventMessage.Cancelled -> {
                // 主机撤销了待办：账本里移除，通知也撤掉（否则用户点了一个已作废的审批）
                store.forgetAnswered(event.eventId)
                NotificationManagerCompat.from(this)
                    .cancel(RelayNotifications.notificationId(event.eventId))
            }

            is EventMessage.Emit, EventMessage.Ignored -> Unit
        }
    }

    private fun onWaterfall(event: EventMessage.Waterfall) {
        val prompt = PromptClassifier.classify(event.eventName, event.eventId, event.request) ?: run {
            log("收到 waterfall 但无法归类（event=${event.eventName} eventId='${event.eventId}'）→ 不弹通知")
            return
        }

        // 重启后不重复弹：账本已落盘。
        if (store.answered.isAnswered(prompt.eventId)) {
            log("审批 ${prompt.eventId} 已应答过（账本命中）→ 不重复弹")
            return
        }

        // 通知没授权 —— 审批确实到了手机，但用户看不到。必须如实上报，
        // 否则又是一个"看起来在守护、其实什么都没发生"。
        if (!RelayNotifications.notificationsEnabled(this)) {
            store.rememberLastError("通知权限未开启 —— 审批已到达手机，但无法提醒你")
            log("⚠️ 收到审批 ${prompt.eventId} 但通知未授权 → 用户什么都看不到")
            updateForeground("通知未授权 · 审批无法提醒")
            return
        }

        NotificationManagerCompat.from(this).notify(
            RelayNotifications.notificationId(prompt.eventId),
            RelayNotifications.approval(this, prompt),
        )
        log("已弹审批通知 eventId=${prompt.eventId} isApproval=${prompt.isApproval} 按钮数=${if (prompt.needsAllowReject) 2 else prompt.options.size}")
        updateForeground("有审批待处理")
    }

    // ── 前台通知 ────────────────────────────────────────────────────────────

    private fun updateForeground(text: String) {
        val notification = RelayNotifications.foreground(this, text)
        if (!foregroundStarted) {
            foregroundStarted = true
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            }
            ServiceCompat.startForeground(this, RelayNotifications.ID_FOREGROUND, notification, type)
        } else {
            NotificationManagerCompat.from(this).notify(RelayNotifications.ID_FOREGROUND, notification)
        }
    }

    private fun shutdown() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "client stopped")
        socket = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        /** 日志 tag：`adb logcat -s DshRelay` 即可看到整条审批通道的状态迁移。 */
        const val TAG = "DshRelay"

        const val ACTION_START = "io.github.dshmobile.app.relay.START"
        const val ACTION_STOP = "io.github.dshmobile.app.relay.STOP"

        const val STATE_STOPPED = "stopped"
        const val STATE_CONNECTING = "connecting"
        const val STATE_HANDSHAKING = "handshaking"
        const val STATE_CONNECTED = "connected"
        const val STATE_RETRYING = "retrying"
        const val STATE_AUTH_FAILED = "auth-failed"

        /** 供状态查询用。进程内可见即可，不需要跨进程。 */
        @Volatile
        var state: String = STATE_STOPPED

        fun start(context: Context) {
            val intent = Intent(context, ApprovalRelayService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ApprovalRelayService::class.java))
        }
    }
}