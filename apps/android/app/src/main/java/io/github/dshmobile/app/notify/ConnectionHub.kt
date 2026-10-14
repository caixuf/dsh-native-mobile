package io.github.dshmobile.app.notify

import android.content.Context
import android.content.Intent
import io.github.dshmobile.app.net.DshConnection
import io.github.dshmobile.app.net.Envelopes
import io.github.dshmobile.app.net.HostRequest
import io.github.dshmobile.app.net.LinkState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 进程级连接中心。
 *
 * ## 为什么必须存在（这是「后台通知」的前提）
 *
 * 原实现里 `DshConnection` 由 `AppViewModel` 的 **`viewModelScope`** 持有：
 *
 * ```
 * val conn = DshConnection(viewModelScope, record.baseUrl, record.token)
 * ```
 *
 * `viewModelScope` 的生命周期挂在 **Activity** 上 —— 用户一切到后台、
 * 系统回收掉 Activity，连接就断了。后果是：
 *
 * > **电脑端卡在「等待授权」，而手机完全不知道** —— 这正是用户反馈的场景。
 *
 * 官方客户端不会有这个问题，因为它的连接是**进程级**的。
 *
 * 所以这里把连接提升到**进程级 scope**：
 *  - `scope` 用 `SupervisorJob`，不随任何 Activity/ViewModel 销毁
 *  - 连接对象常驻，App 退到后台后 WebSocket 依然活着
 *  - 配合 [RemoteSessionService]（前台服务）防止**进程**被系统回收
 *
 * 两者缺一不可：只有进程级 scope，进程被杀了照样收不到；
 * 只有前台服务而不改 scope，Activity 一销毁连接就断了。
 */
object ConnectionHub {

    /**
     * 进程级协程作用域。
     *
     * `Dispatchers.IO` —— 这里跑的是网络 IO（WebSocket 读、HTTP 调用），
     * 不是 UI 计算。用户界面通过 StateFlow/SharedFlow 跨线层拿到结果。
     */
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var appContext: Context? = null

    @Volatile
    var connection: DshConnection? = null
        private set

    /**
     * App 是否在前台。
     *
     * 用于**避免重复打扰**：App 正在前台时，审批/提问由应用内的卡片呈现，
     * 再弹一条系统通知是噪音。只有用户没在看 App 时才发通知
     * —— 这恰好就是本功能要解决的场景。
     */
    @Volatile
    var appInForeground: Boolean = false

    private var observeJob: Job? = null

    /** 观察连接状态的 job（用于启停前台服务）。 */
    private var stateJob: Job? = null

    /** 前台服务是否已启动 —— 避免重复 start/stop 造成闪烁。 */
    @Volatile
    private var serviceRunning = false

    /** 当前待处理的请求（rpcId → 原始请求），用于通知的撤销与应答。 */
    private val pending = ConcurrentHashMap<String, HostRequest>()

    /**
     * 已从**通知**应答过的 rpcId。
     *
     * 🔴 为什么必须有这条流：
     *
     * 审批有两个应答入口 —— App 内的审批卡、锁屏通知的按钮。用户可能在锁屏点了
     * 「允许一次」，然后才打开 App。此时 `ChatViewModel.pending` 里那条还在
     * （它没参与锁屏那次应答），界面会**继续显示一个已经答过的审批卡**，
     * 用户再点一次就会重复应答。
     *
     * 所以应答完成后广播出去，让 UI 清掉对应卡片。
     */
    private val _answeredIds = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val answeredIds: SharedFlow<String> = _answeredIds.asSharedFlow()

    /** 当前活跃会话 id，用于前台判断是否需要通知。 */
    @Volatile
    var activeSessionId: String? = null

    fun init(context: Context) {
        appContext = context.applicationContext
        ApprovalNotifier.createChannels(context.applicationContext)
    }

    /**
     * 绑定一条连接并开始观察它的事件流。
     *
     * 注意 `DshConnection.hostRequests` 是 `MutableSharedFlow(replay = 8)`，
     * **支持多订阅者**：这里收一份用于发通知，`ChatViewModel` 同时收一份用于
     * 显示应用内卡片。两者互不干扰，不构成竞争。
     */
    fun attach(conn: DshConnection) {
        connection = conn
        observeJob?.cancel()
        observeJob = scope.launch {
            conn.hostRequests.collect { req -> onRequest(req) }
        }
        // 观察连接状态：一旦真正就绪就拉起前台服务。
        //
        // 🔴 只在 `Ready` 时拉起，不在 `Connecting` 时拉起 —— 否则连不上主机
        // （密码错、电脑关机）时也会挂一个"正在守护连接"的常驻通知，
        // 那是**骗用户**：明明没连上却说在守护。
        stateJob?.cancel()
        stateJob = scope.launch {
            conn.state.collect { s ->
                when (s) {
                    is LinkState.Ready -> startServiceIfNeeded()
                    // 🔴 `Disconnected` **绝不停止服务**（2026-10-14 模拟器实测抓到的自造 bug）。
                    //
                    // 原实现在这里调 `stopServiceIfNeeded()` —— 那是**逻辑反转**：
                    // 前台服务的全部意义就是「断线时保住进程，好让重连能发生」。
                    // 一断线就停服务，等于**一旦掉线就永远回不来**（进程随 Activity
                    // 一起被回收，再没人发起重连）。
                    //
                    // 实测现象：连接掉了一次后就再也连不上，顶部一直红着
                    // 「未连接到电脑」，而前台服务在 `dumpsys activity services`
                    // 里查不到 —— 服务被自己停掉了。
                    //
                    // 只有用户**主动断开**（切主机 / 删除主机 → `detach()`）才该停服务。
                    is LinkState.Disconnected -> Unit
                    // Connecting / Degraded：保持现状，不反复起停（避免通知闪烁）
                    else -> Unit
                }
            }
        }
    }

    fun detach() {
        observeJob?.cancel()
        observeJob = null
        stateJob?.cancel()
        stateJob = null
        connection = null
        pending.clear()
        stopServiceIfNeeded()
    }

    /**
     * 启动前台服务。
     *
     * ⚠️ Android 12+ 限制**从后台启动前台服务**（BackgroundExecutionLimits）。
     * 本方法的调用时机是连接变 Ready —— 而连接只在用户打开 App 后才建立，
     * 所以现实中总是在前台触发，不违反限制。
     * 若将来做开机自启，必须改用 `startForegroundService` 的豁免场景或 WorkManager。
     */
    private fun startServiceIfNeeded() {
        if (serviceRunning) return
        val ctx = appContext ?: return
        runCatching {
            ctx.startForegroundService(Intent(ctx, RemoteSessionService::class.java))
            serviceRunning = true
        }
    }

    private fun stopServiceIfNeeded() {
        if (!serviceRunning) return
        val ctx = appContext ?: return
        runCatching {
            ctx.stopService(Intent(ctx, RemoteSessionService::class.java))
            serviceRunning = false
        }
    }

    private fun onRequest(req: HostRequest) {
        // 🔴 只处理**需要应答**的请求。
        //
        // `DshConnection` 用同一条 `hostRequests` 流同时投递两类东西：
        //   - answerable=true  → 审批/提问（主机在等我们回话）
        //   - answerable=false → 纯通知（schedule/changed、api-session/activity）
        //
        // 不加这道闸门，`schedule/changed` 这种过程噪音也会弹「需要授权」——
        // 本项目在应用内 UI 上曾踩过一模一样的坑（见 ChatViewModel 的注释）。
        if (!req.answerable) return

        pending[req.rpcId] = req
        val ctx = appContext ?: return

        // App 在前台 → 由应用内卡片处理，不重复打扰
        if (appInForeground) return

        ApprovalNotifier.show(ctx, req)
    }

    /** 从通知/服务应答一条请求。 */
    fun respond(rpcId: String, outcome: JsonObject) {
        val conn = connection ?: return
        val req = pending.remove(rpcId) ?: return
        scope.launch {
            conn.respond(rpcId, outcome)
            appContext?.let { ApprovalNotifier.cancel(it, req) }
            // 广播出去，让可能已经打开的 App 清掉那张已经答过的审批卡。
            _answeredIds.tryEmit(rpcId)
        }
    }

    /**
     * 审批应答（通知按钮）。
     *
     * 🔴 `outcome.value` 必须是**裸字符串** `allowed-once | rejected` ——
     * 词表外的值主机**不报错，而是静默归一化成 `unavailable`**（把"允许"变成"拒绝"）。
     * 所以这里统一走 [Envelopes.approvalOutcome]，不手拼 JSON。
     */
    fun respondApproval(rpcId: String, approved: Boolean) {
        respond(rpcId, Envelopes.approvalOutcome(approved))
    }

    /** 提问应答（通知按钮里选了一个选项）。 */
    fun respondQuestion(rpcId: String, questionId: String, answer: String) {
        respond(rpcId, Envelopes.questionOutcome(questionId, listOf(answer)))
    }

    /** 应用内已应答 → 撤销对应通知。 */
    fun cancelNotification(rpcId: String) {
        val ctx = appContext ?: return
        val req = pending.remove(rpcId) ?: return
        ApprovalNotifier.cancel(ctx, req)
    }
}
