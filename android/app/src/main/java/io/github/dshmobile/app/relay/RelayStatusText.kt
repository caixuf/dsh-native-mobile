package io.github.dshmobile.app.relay

/**
 * 中继状态 → 前台服务通知文案 —— **纯函数，零 Android 依赖**（见 `RelayStatusTextTest`）。
 *
 * ## 为什么必须由状态推导文案
 *
 * 真机上一眼可见的矛盾是「状态查询说 `handshaking`，通知栏却写着"已连接 · 等待审批"」。
 * 根因是两处各写各的：`state` 在迁移点赋值、通知文案是散落的字符串字面量，改一处忘一处。
 *
 * 所以文案**只由状态（+ 几个显式输入）推导**：`status()` 返回的 `state` 与前台通知文案
 * 出自同一组输入，结构上就不可能互相矛盾。
 *
 * ## 四个输入为什么都必须显式传
 *
 * - `configured`：没配对时"状态"仍是 stopped，但用户需要的是"先去配对"；
 * - `notificationsEnabled`：已连接但通知未授权 = **审批到了也不会响**，必须说出来
 *   （这正是"以为在守护、其实什么都没有"的成因）；
 * - `pendingApprovals`：让文案与 `status().pendingApprovals` 同源；
 * - `attempt` / `backoffSeconds`：重连文案要能回答"还要等多久"。
 */
object RelayStates {
    const val STOPPED = "stopped"
    const val CONNECTING = "connecting"
    const val HANDSHAKING = "handshaking"
    const val CONNECTED = "connected"
    const val RETRYING = "retrying"
    const val AUTH_FAILED = "auth-failed"

    /** 全部状态。**新增状态必须加进来**（`RelayStatusTextTest` 会遍历它）。 */
    val ALL = listOf(STOPPED, CONNECTING, HANDSHAKING, CONNECTED, RETRYING, AUTH_FAILED)
}

/** 前台通知文案的输入快照。 */
data class ForegroundStatus(
    val state: String,
    val configured: Boolean = true,
    val notificationsEnabled: Boolean = true,
    val pendingApprovals: Int = 0,
    val attempt: Int = 0,
    val backoffSeconds: Int = 0,
)

object RelayStatusText {

    /** 前台常驻通知的正文。同一个 [ForegroundStatus] 必须永远得到同一句话。 */
    fun foreground(status: ForegroundStatus): String {
        // 未配对优先：此时"stopped"会让用户以为是自己关掉了。
        if (!status.configured) return "未配对：请先在 App 里连接电脑"
        return when (status.state) {
            RelayStates.STOPPED -> "已停止守护（未连接电脑）"
            RelayStates.CONNECTING -> "正在连接电脑…"
            // ⚠️ 这里**绝不能**写"已连接"：握手还没完成，说了就是在骗用户。
            RelayStates.HANDSHAKING -> "已连上电脑，正在同步会话…"
            RelayStates.CONNECTED -> when {
                !status.notificationsEnabled -> "已连接 · 通知未授权，审批不会提醒"
                status.pendingApprovals > 0 -> "已连接 · 有 ${status.pendingApprovals} 项审批待你处理"
                else -> "已连接 · 等待审批"
            }
            RelayStates.RETRYING ->
                "重连中（第 ${status.attempt} 次，${status.backoffSeconds} 秒后）"
            RelayStates.AUTH_FAILED -> "已停止：设备令牌失效，请重新配对"
            else -> "状态未知（${status.state}）：中继可能没有在守护"
        }
    }
}