package io.github.dshmobile.app.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * 通知按钮的落点。
 *
 * 用户在通知栏点「允许一次」/「拒绝」/ 某个选项 → 这里直接把应答投递给主机。
 * **不经过 WebView、不经过 Activity** —— 这是"锁屏上就能处理"的关键：
 * 如果需要先启动 App、等 WebView 起来再回执，用户就会错过它。
 *
 * 用 `goAsync()` + 后台线程：广播接收器的 `onReceive` 在主线程且必须在 10s 内返回，
 * 而网络请求绝不能放在主线程（`NetworkOnMainThreadException`）。
 */
class RelayActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECIDE) return
        val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
        val allow = intent.getBooleanExtra(EXTRA_ALLOW, false)
        val choiceIndex = intent.getIntExtra(EXTRA_CHOICE_INDEX, -1)
        val choice = intent.getStringArrayListExtra(EXTRA_CHOICE)
        val questionId = intent.getStringExtra(EXTRA_QUESTION_ID)

        val appContext = context.applicationContext
        val pending = goAsync()
        Thread({
            try {
                RelayDecision.submit(appContext, eventId, allow, choice, questionId, choiceIndex)
            } finally {
                pending.finish()
            }
        }, "dsh-relay-decision").start()
    }

    companion object {
        const val ACTION_DECIDE = "io.github.dshmobile.app.relay.DECIDE"
        const val EXTRA_EVENT_ID = "eventId"
        const val EXTRA_ALLOW = "allow"
        const val EXTRA_CHOICE_INDEX = "choiceIndex"
        const val EXTRA_CHOICE = "choice"
        const val EXTRA_QUESTION_ID = "questionId"
    }
}

/**
 * 把用户的选择投递给主机。
 *
 * ## 两条"绝不静默"的规则
 *
 * 1. **只有投递成功才标记 `answered`。** 失败时通知保留、用户可再点一次 ——
 *    绝不能出现「通知消失了但主机还在等」。
 * 2. **形状不对宁可报错也不发。** 提问应答缺 `questionId` 时，发出去的
 *    `value` 会变成审批用的裸字符串，主机只会静默归一化成 `unavailable`。
 *    这里直接拒绝并如实提示。
 */
object RelayDecision {

    /** 与 [ApprovalRelayService] 同一个 tag：`adb logcat -s DshRelay` 一次看完整条链。 */
    private const val TAG = "DshRelay"

    fun submit(
        context: Context,
        eventId: String,
        allow: Boolean,
        choice: List<String>?,
        questionId: String?,
        choiceIndex: Int = -1,
    ): Boolean {
        val store = RelayStore(context)
        val manager = NotificationManagerCompat.from(context)
        val baseUrl = store.baseUrl
        val token = store.token
        val clientId = store.clientId

        if (baseUrl.isNullOrBlank() || token.isNullOrBlank() || clientId.isNullOrBlank()) {
            val why = "连接信息不完整（clientId=${clientId != null}）—— 请在 App 里重新连接电脑"
            store.rememberLastError(why)
            notifyFailure(context, manager, "应答失败", why)
            return false
        }

        val outcome: Map<String, Any?> = if (choice != null) {
            if (questionId.isNullOrBlank()) {
                val why = "无法回答这个问题：主机没下发问题 id，贸然发送会被静默当成拒绝"
                store.rememberLastError(why)
                notifyFailure(context, manager, "应答失败", why)
                return false
            }
            ApprovalContract.questionOutcome(questionId, choice)
        } else {
            ApprovalContract.approvalOutcome(allow)
        }

        val delivery = RelayClient.sendOutcome(baseUrl, token, clientId, eventId, outcome)
        Log.i(TAG, "应答投递 eventId=$eventId allow=$allow choice=${choice ?: "-"} → ok=${delivery.ok} status=${delivery.status}")
        if (delivery.ok) {
            store.markAnswered(eventId)
            store.rememberLastError(null)
            manager.cancel(RelayNotifications.notificationId(eventId))
            Log.i(TAG, "应答已送达，通知已撤回（该事件不会再重复弹）")
            return true
        }

        // 失败：不标记已答，保留通知，让用户能重试。
        val why = delivery.message ?: "未知错误"
        store.rememberLastError(why)
        Log.w(TAG, "应答未送达：$why —— 通知保留，用户可再点一次")
        notifyFailure(context, manager, "应答未送达", "$why（通知已保留，可再点一次）")
        return false
    }

    private fun notifyFailure(
        context: Context,
        manager: NotificationManagerCompat,
        title: String,
        text: String,
    ) {
        if (!RelayNotifications.notificationsEnabled(context)) return
        manager.notify(
            RelayNotifications.ID_STATUS,
            RelayNotifications.status(context, title, text),
        )
    }
}