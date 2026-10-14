package io.github.dshmobile.app.notify

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import io.github.dshmobile.app.MainActivity
import io.github.dshmobile.app.R

/**
 * 常驻前台服务：保持与电脑的连接，确保授权请求能**立刻**送达。
 *
 * ## 为什么必须有它（不做的话功能就是残的）
 *
 * 即使连接提升到进程级（见 [ConnectionHub]），Android 仍会在内存紧张时
 * **回收整个进程** —— 进程一死，WebSocket 断开，电脑端的授权请求就石沉大海。
 *
 * 前台服务是 Android 给"用户明确知道并同意你在后台干活"的应用的合法通路：
 *  - 系统知道这个进程不能随便杀
 *  - 用户能在通知栏看到「正在守护连接」并能随时关掉（这是**必要的透明度**，
 *    不是打扰 —— 偷偷在后台保持网络连接才是应该被质疑的）
 *
 * 通知用 `IMPORTANCE_LOW` + 无声无震：它是**状态标识**，不是事件提醒。
 *
 * ## 与 Doze / 省电策略的关系
 *
 * 前台服务能显著降低被杀概率，但**不能保证**在厂商激进省电（小米/华为/OPPO
 * 的"深度睡眠"）下永远存活。真要 100% 可靠需要用户手动加白名单 ——
 * 这是平台现实，不在这里假装能绕过。App 内应引导用户去加白。
 */
class RemoteSessionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startAsForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY：被系统杀掉后**自动重启**。
        // 这是本服务的全部意义所在 —— 连接断了要自己回来，不能等用户发现。
        return START_STICKY
    }

    private fun startAsForeground() {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification: Notification = NotificationCompat.Builder(this, ApprovalNotifier.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("正在守护与电脑的连接")
            .setContentText("有授权请求会立刻通知你")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .build()

        // Android 14（API 34）起必须**显式声明服务类型**，否则抛
        // MissingForegroundServiceTypeException。
        //
        // 用 `dataSync` 是因为它的语义正是「与远端同步数据」——
        // 我们的连接就是持久数据通道。⚠️ 不要用 `specialUse`（需要额外说明与审核理由）
        // 也不要滥用 `location`（会误导用户且违规）。
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }

        ServiceCompat.startForeground(
            this,
            ApprovalNotifier.SERVICE_NOTIFICATION_ID,
            notification,
            type,
        )
    }
}
