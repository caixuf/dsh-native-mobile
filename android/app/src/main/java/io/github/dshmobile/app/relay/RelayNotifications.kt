package io.github.dshmobile.app.relay

import android.app.Notification
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

/**
 * 通知构建。
 *
 * ## 三条真机事实（决定了这里的写法）
 *
 * 1. **Android 13+ 需要运行时 `POST_NOTIFICATIONS`**；没授权时通知**静默丢弃**，
 *    不报错。所以 [notificationsEnabled] 必须被上层如实读取并展示，
 *    不能假设"服务在跑 = 用户能看到"。
 * 2. **通知渠道建立后，重要性不可改**（改渠道属性是 no-op）。所以审批渠道第一次
 *    创建就必须是 `IMPORTANCE_HIGH`，否则以后永远只能小声提醒。
 * 3. **正文过长会被系统截断/撑爆布局**，所以正文走 [PromptClassifier.truncate]。
 */
object RelayNotifications {

    const val CHANNEL_APPROVALS = "dsh-approvals"
    const val CHANNEL_STATUS = "dsh-relay-status"

    /** 常驻通知：告诉用户"通道在守着"。 */
    const val ID_FOREGROUND = 0x4453 /* "DS" */

    /** 通道/令牌出问题时的提示通知。 */
    const val ID_STATUS = 0x4454

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return

        if (manager.getNotificationChannel(CHANNEL_APPROVALS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_APPROVALS,
                    "审批请求",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "电脑端等待你授权时立刻提醒，可在通知上直接允许/拒绝"
                    enableVibration(true)
                    setShowBadge(true)
                },
            )
        }

        if (manager.getNotificationChannel(CHANNEL_STATUS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_STATUS,
                    "连接状态",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "通道断开、设备令牌失效等提示" },
            )
        }
    }

    /** 用户到底能不能看到通知（Android 13+ 未授权 / 用户关闭渠道都是 false）。 */
    fun notificationsEnabled(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun openApp(context: Context, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** 常驻的前台服务通知：**低重要性、常驻、不响**。 */
    fun foreground(context: Context, text: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setContentTitle("DSH 遥控")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            .setContentIntent(openApp(context, 10))
            .build()

    /**
     * 审批通知。
     *
     * 🔴 两个动作按钮是**这条通知的全部意义**：用户不该为了点一个"允许"而先解锁、
     * 找 App、等 WebView 启动。按钮 → [RelayActionReceiver] → 直接回执主机。
     */
    fun approval(context: Context, prompt: RelayPrompt): Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setContentTitle(prompt.title)
            .setContentText(prompt.notificationBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(prompt.notificationBody))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL /* 高优先级：绕开勿扰的提示级别 */)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(openApp(context, notificationId(prompt.eventId)))

        if (prompt.needsAllowReject) {
            builder.addAction(
                android.R.drawable.ic_menu_send,
                "允许一次",
                action(context, prompt.eventId, allow = true, choiceIndex = -1, questionId = null),
            )
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "拒绝",
                action(context, prompt.eventId, allow = false, choiceIndex = -1, questionId = null),
            )
        } else {
            // 提问：每个选项一个动作（最多 3 个，超出部分让用户进 App 选）。
            prompt.options.take(3).forEachIndexed { index, label ->
                val selected = listOf(label)
                builder.addAction(
                    android.R.drawable.ic_menu_edit,
                    label,
                    action(
                        context,
                        prompt.eventId,
                        allow = true,
                        choiceIndex = index,
                        questionId = prompt.questionId,
                        choiceText = selected,
                    ),
                )
            }
        }

        return builder.build()
    }

    /** 连接状态提示（令牌失效 / 重连失败等）。 */
    fun status(context: Context, title: String, text: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(openApp(context, ID_STATUS))
            .build()

    fun notificationId(eventId: String): Int = 0x5000 + (eventId.hashCode() and 0x0FFF)

    private fun action(
        context: Context,
        eventId: String,
        allow: Boolean,
        choiceIndex: Int,
        questionId: String?,
        choiceText: List<String>? = null,
    ): PendingIntent {
        val intent = Intent(context, RelayActionReceiver::class.java).apply {
            this.action = RelayActionReceiver.ACTION_DECIDE
            putExtra(RelayActionReceiver.EXTRA_EVENT_ID, eventId)
            putExtra(RelayActionReceiver.EXTRA_ALLOW, allow)
            putExtra(RelayActionReceiver.EXTRA_CHOICE_INDEX, choiceIndex)
            putExtra(RelayActionReceiver.EXTRA_QUESTION_ID, questionId)
            if (choiceText != null) {
                putStringArrayListExtra(RelayActionReceiver.EXTRA_CHOICE, ArrayList(choiceText))
            }
        }
        // requestCode 必须逐事件唯一，否则多个待审批项会共用同一个 PendingIntent，
        // 点第二个通知等于点了第一个（extra 被 FLAG_UPDATE_CURRENT 覆盖）。
        val requestCode = (eventId.hashCode() * 31 + (if (allow) 1 else 0) + choiceIndex + 1)
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}