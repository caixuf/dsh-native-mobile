package io.github.dshmobile.app.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.github.dshmobile.app.MainActivity
import io.github.dshmobile.app.R
import io.github.dshmobile.app.net.HostRequest
import io.github.dshmobile.app.render.JsonRender
import kotlinx.serialization.json.JsonObject

/**
 * 审批 / 提问通知。
 *
 * ## 设计标准（先声明，再动手 —— 对齐 ui-design skill 红线二）
 *
 * ```
 * 1. 目的：用户没看 App（锁屏/别的应用）时，电脑端卡在等你授权 →
 *         手机立刻响铃+震动，锁屏上就能批准或拒绝，不必先打开 App
 * 2. 层级：① 标题   —「需要授权」/「需要你回答」，一眼知道是什么事
 *         ② 正文   — 工具名 + 单行摘要，够判断且不刷屏
 *         ③ 动作   —「允许一次」/「拒绝」/ 提问选项
 *         ④ 点进 App 才显示完整参数与审批卡
 * 3. 约束：用系统通知样式（深色/浅色自适应，不自造配色）；
 *         审批与提问视觉可分（渠道名 + 图标语义 + 标题用词）
 * 4. 不确定项：❓ 正文该显示多少参数
 * ```
 *
 * ## 关于「正文显示多少参数」的取舍依据
 *
 * 我选择**只显示工具名 + 单行摘要**，依据是**系统约束**而非我的偏好：
 *  - Android 通知的 `BigTextStyle` 折叠态只保证 1 行正文；锁屏进一步截断
 *  - 审批的关键信息是「谁要做什么」，不是完整参数（参数在 App 里看）
 *  - 把 JSON 塞进通知会挤掉「允许/拒绝」按钮的注意力
 *
 * 但如果用户觉得不够，这里可以改成 `BigTextStyle` 展示完整参数 ——
 * 这是**我不确定、需要你拍板**的一处。
 */
object ApprovalNotifier {

    /** 审批：高优先级（横幅+声音+震动）—— 电脑正卡着等你。 */
    private const val CHANNEL_APPROVAL = "dsh_approval"

    /** 提问：同级别，但渠道分开，便于用户单独静音某一类。 */
    private const val CHANNEL_QUESTION = "dsh_question"

    /** 前台服务常驻通知：低优先级、无声，不该打扰用户。 */
    const val CHANNEL_SERVICE = "dsh_service"

    /** 前台服务通知固定 id。 */
    const val SERVICE_NOTIFICATION_ID = 1000

    private const val ACTION_APPROVE = "io.github.dshmobile.app.APPROVE"
    private const val ACTION_REJECT = "io.github.dshmobile.app.REJECT"
    private const val ACTION_ANSWER = "io.github.dshmobile.app.ANSWER"

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return

        // 审批/提问：IMPORTANCE_HIGH 才会出**浮动横幅**（heads-up）。
        // 这是本功能的核心 —— 用 DEFAULT 只会静静躺在通知栏里，用户看不到。
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_APPROVAL,
                "需要授权",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "电脑端等你批准某个操作时提醒你"
                enableVibration(true)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_QUESTION,
                "需要你回答",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "电脑端有选择题等你作答时提醒你"
                enableVibration(true)
            },
        )
        // 常驻服务通知：LOW 且无声无震 —— 它是"我在后台守着"的状态标识，
        // 不是事件提醒，不能打扰用户。
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SERVICE,
                "后台连接",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "保持与电脑的连接，以便随时收到授权请求"
                setShowBadge(false)
                enableVibration(false)
            },
        )
    }

    /** 是否已获得通知权限（API 33+ 需要运行时授权）。 */
    fun canNotify(ctx: Context): Boolean =
        NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    /**
     * 显示一条审批/提问通知。
     *
     * 通知 id 用 `rpcId.hashCode()` —— 同一请求重连重放时**覆盖**而非叠加，
     * 避免用户看到三条一样的「需要授权」。
     */
    fun show(ctx: Context, req: HostRequest) {
        if (!canNotify(ctx)) return

        val isApproval = req.method.contains("approval")
        val id = req.rpcId.hashCode()

        val builder = NotificationCompat.Builder(
            ctx,
            if (isApproval) CHANNEL_APPROVAL else CHANNEL_QUESTION,
        )
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (isApproval) "需要授权" else "需要你回答")
            .setContentText(bodyText(req, isApproval))
            .setStyle(NotificationCompat.BigTextStyle().bigText(bodyText(req, isApproval)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // 审批是"电脑被卡住了"的语义 —— 用 REMINDER 而非 MESSAGE，
            // 让系统知道这是需要动作的，会给予更醒目的呈现。
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(ctx, req))

        if (isApproval) {
            builder.addAction(
                R.drawable.ic_notification,
                "允许一次",
                actionIntent(ctx, ACTION_APPROVE, req.rpcId, approved = true),
            )
            builder.addAction(
                R.drawable.ic_notification,
                "拒绝",
                actionIntent(ctx, ACTION_REJECT, req.rpcId, approved = false),
            )
        } else {
            // 提问：把选项做成动作按钮。
            //
            // ⚠️ 通知最多 3 个动作。选项超过 3 个时**不能硬塞** ——
            // 那会让用户以为选项只有 3 个。此时改为提示「打开应用作答」，
            // 并保留一个「打开」动作。宁可少给快捷方式，不要给错误的快捷方式。
            val options = optionLabels(req)
            if (options.isNotEmpty() && options.size <= 3) {
                options.forEach { label ->
                    builder.addAction(
                        R.drawable.ic_notification,
                        label,
                        answerIntent(ctx, req, label),
                    )
                }
            } else if (options.isNotEmpty()) {
                builder.addAction(
                    R.drawable.ic_notification,
                    "打开作答（${options.size} 个选项）",
                    openAppIntent(ctx, req),
                )
            }
        }

        runCatching {
            NotificationManagerCompat.from(ctx).notify(id, builder.build())
        }
    }

    fun cancel(ctx: Context, req: HostRequest) {
        runCatching { NotificationManagerCompat.from(ctx).cancel(req.rpcId.hashCode()) }
    }

    // ---- 内部 -------------------------------------------------------------

    /**
     * 正文：工具名 + 单行摘要。
     *
     * 摘要取 `displayReason` → `reason`（都在 approval/request 的 payload 里），
     * 提问则取问题文本。整体截断到 120 字 —— 超过这个长度在锁屏上会被切掉后半段，
     * 不如主动截断并加省略号，让用户知道还有内容。
     */
    private fun bodyText(req: HostRequest, isApproval: Boolean): String {
        val raw = if (isApproval) {
            val tool = JsonRender.str(req.payload, "toolName") ?: "某个操作"
            val why = JsonRender.str(req.payload, "displayReason", "reason")
            if (why.isNullOrBlank()) tool else "$tool · $why"
        } else {
            val q = firstQuestion(req)
            q?.let { JsonRender.str(it, "header", "question") }
                ?: JsonRender.str(req.payload, "question")
                ?: "电脑端有问题需要你确认"
        }
        return if (raw.length > 120) raw.take(117) + "…" else raw
    }

    /**
     * 取 `questions[0]`。
     *
     * ⚠️ `JsonRender.arr` 的形参是 `JsonObject`，而 `JsonArray` 的元素类型是
     * `JsonElement` —— 必须显式 `as? JsonObject`，否则编译不过（踩过）。
     * 提问的选项是**对象数组**（`{label, ...}`），不是字符串数组，
     * 所以这里统一按对象处理。
     */
    private fun firstQuestion(req: HostRequest): JsonObject? =
        JsonRender.arr(req.payload, "questions")?.firstOrNull() as? JsonObject

    /** 提取提问的选项文本（`questions[0].options[].label`）。 */
    private fun optionLabels(req: HostRequest): List<String> {
        val q = firstQuestion(req) ?: return emptyList()
        val opts = JsonRender.arr(q, "options") ?: return emptyList()
        return opts.mapNotNull { (it as? JsonObject)?.let { o -> JsonRender.str(o, "label", "text") } }
    }

    /** 提问的第一题 id —— 应答必须带回它。 */
    private fun questionId(req: HostRequest): String? {
        val q = firstQuestion(req) ?: return null
        return JsonRender.str(q, "id")
    }

    private fun openAppIntent(ctx: Context, req: HostRequest): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN_RPC, req.rpcId)
            JsonRender.str(req.payload, "sessionId")?.let { putExtra(EXTRA_SESSION, it) }
        }
        return PendingIntent.getActivity(
            ctx,
            req.rpcId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(
        ctx: Context,
        action: String,
        rpcId: String,
        approved: Boolean,
    ): PendingIntent {
        val intent = Intent(ctx, ApprovalActionReceiver::class.java).apply {
            this.action = action
            putExtra("rpcId", rpcId)
            putExtra("approved", approved)
        }
        // requestCode 必须区分「同一个请求的允许 vs 拒绝」，否则后者会覆盖前者。
        val rc = rpcId.hashCode() * 31 + if (approved) 1 else 0
        return PendingIntent.getBroadcast(
            ctx,
            rc,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun answerIntent(ctx: Context, req: HostRequest, label: String): PendingIntent {
        val intent = Intent(ctx, ApprovalActionReceiver::class.java).apply {
            action = ACTION_ANSWER
            putExtra("rpcId", req.rpcId)
            putExtra("answer", label)
            questionId(req)?.let { putExtra("questionId", it) }
        }
        val rc = (req.rpcId.hashCode() * 31) + label.hashCode()
        return PendingIntent.getBroadcast(
            ctx,
            rc,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * 点击通知打开 App 时携带的 extras。
     *
     * 放在这里而不是 MainActivity：通知是**唯一**的生产者，常量跟着生产者走
     * 比散落在 Activity 里更好追踪。MainActivity 需要读时引用这两个常量。
     */
    const val EXTRA_OPEN_RPC = "io.github.dshmobile.app.OPEN_RPC"
    const val EXTRA_SESSION = "io.github.dshmobile.app.SESSION_ID"
}
