package io.github.dshmobile.app.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * 安装结果接收器（配合 [UpdateManager.install] 的 PackageInstaller 会话）。
 *
 * ## 为什么需要它
 *
 * `PackageInstaller.Session.commit(intentSender)` 的安装结果**只**通过这个
 * Broadcast 回来。没有接收器时：
 *   · 安装失败（签名不符、空间不足、用户取消）**完全没有提示**；
 *   · 用户以为"更新过了"，实际还是旧版本 —— 下次打开发现没变化，无从排查。
 *
 * 把结果写进 [RelayStore.lastError] 之外，主要靠日志与 Toast：安装界面本身
 * 已经盖在应用上，能看到的只有系统 UI；这里的作用是让"失败"留下痕迹。
 *
 * ⚠️ 必须 `exported=false`：只接收本 App 的 PendingIntent，外部应用无法伪造结果。
 */
class InstallResultReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_INSTALL_RESULT = "io.github.dshmobile.app.INSTALL_RESULT"
        const val EXTRA_SESSION_ID = "sessionId"
        private const val TAG = "DshInstall"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_INSTALL_RESULT) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val sessionId = intent.getIntExtra(EXTRA_SESSION_ID, -1)

        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // 系统需要用户确认：把确认界面拉起来（部分 ROM 需要这一步）
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    try {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(confirm)
                    } catch (t: Throwable) {
                        Log.w(TAG, "无法拉起安装确认界面", t)
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(TAG, "install success (session=$sessionId)")
                // 安装成功 → 清掉下载缓存，避免下次误判还有待装包
                try {
                    java.io.File(context.cacheDir, "ota").deleteRecursively()
                } catch (t: Throwable) {
                    Log.w(TAG, "清理 OTA 缓存失败", t)
                }
            }
            else -> {
                // 失败/被取消：留下可排查的日志。常见原因：
                //   INSTALL_FAILED_UPDATE_INCOMPATIBLE → 签名不一致（必须卸载重装）
                //   INSTALL_FAILED_INSUFFICIENT_STORAGE → 空间不足
                Log.w(TAG, "install failed: status=$status message=$message (session=$sessionId)")
            }
        }
    }
}
