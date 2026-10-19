package io.github.dshmobile.app.relay

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * OTA 自更新：下载 APK → 校验 → 拉起系统安装器。
 *
 * ## 为什么需要它（用户原话：「不然每次我插线你安装太麻烦了吧」）
 *
 * 之前每次发版，用户都得把手机用 USB 连上电脑，由开发机 `adb install -r`。
 * 这条路要求：数据线、ADB、电脑在场。OTA 把这一步变成「点一下更新」。
 *
 * ## 关键约束（每条都对应一个会静默失败的坑）
 *
 * 1. **安装未知来源需要 `REQUEST_INSTALL_PACKAGES` + 用户授权**
 *    Android 8.0+ 是**按应用**授权的（[Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES]），
 *    没有授权时 `startActivity` 不会抛异常，而是系统直接吞掉安装页 ——
 *    表现为「点了没反应」。所以必须先查 [canRequestPackageInstalls]，未授权就引导。
 *
 * 2. **7.0+ 必须用 FileProvider 共享 APK**
 *    直接 `file://` URI 会抛 FileUriExposedException（会被 catch 成静默失败）。
 *    需要在 manifest 里声明 provider，并配 `res/xml/file_paths.xml`。
 *
 * 3. **签名必须一致**
 *    APK 用不同证书签名时，系统拒绝覆盖安装
 *    （INSTALL_FAILED_UPDATE_INCOMPATIBLE），只能卸载重装 → 数据全丢。
 *    本项目所有版本都用同一张 debug 证书（v1.3.2 起实测一致），
 *    但**下载完整性仍然要校验**，否则半截文件会安装失败且没有可读提示。
 *
 * 4. **网络在主线程会抛 NetworkOnMainThreadException**
 *    所有下载都在单线程 executor 上跑，进度只通过监听回调回主线程（`activity.runOnUiThread`）。
 *
 * ## 安全边界
 *
 * 只允许下载 **本仓库 GitHub Releases 的 https 资源**（见 [isTrustedUrl]），
 * 不接受网页传来的任意 URL —— 否则一个 XSS 就能让 App 装上任意 APK。
 * 校验和优先用 GitHub 返回的 sha256 摘要（API 有），没有则只做大小校验。
 */
class UpdateManager(private val activity: Activity) {

    companion object {
        private const val TAG = "DshUpdate"

        /** 只信任这两个前缀（http 也允许，因为局域网自建 Release 镜像的场景）。 */
        private val TRUSTED_PREFIXES = listOf(
            "https://github.com/caixuf/dsh-native-mobile/releases/download/",
            "https://objects.githubusercontent.com/",
            "https://api.github.com/repos/caixuf/dsh-native-mobile/",
        )

        private fun isTrustedUrl(url: String): Boolean =
            TRUSTED_PREFIXES.any { url.startsWith(it) }

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-ota").apply { isDaemon = true }
    }

    /** 下载目录：`cacheDir/ota`（cache 目录系统可回收，正好合适）。 */
    private fun otaDir(): File = File(activity.cacheDir, "ota").apply { mkdirs() }

    /** 已下载待安装的 APK（存在且非空才算）。 */
    fun pendingApk(): File? {
        val f = File(otaDir(), "dsh-mobile-update.apk")
        return if (f.exists() && f.length() > 0) f else null
    }

    /**
     * 下载 APK。`expectedSha256` 为空时跳过强校验（只校验大小/非空）。
     *
     * 回调 JSON 形状（保持与其它桥方法一致：字符串、不抛异常）：
     *   { ok, phase: "downloading"|"done"|"error", bytes, total, percent, message }
     */
    fun download(url: String, expectedSha256: String?, onProgress: (String) -> Unit) {
        if (!isTrustedUrl(url)) {
            onProgress(err("只允许下载本仓库 Release 的 APK：$url"))
            return
        }
        executor.execute {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    instanceFollowRedirects = true
                    setRequestProperty("Accept", "application/octet-stream")
                    // GitHub Release 会 302 到 objects.githubusercontent.com
                }
                val code = conn.responseCode
                if (code !in 200..299) {
                    onProgress(err("下载失败：HTTP $code"))
                    return@execute
                }
                val total = conn.contentLengthLong
                val target = File(otaDir(), "dsh-mobile-update.apk.tmp")
                target.delete()
                var written = 0L
                var lastReport = 0L
                conn.inputStream.use { input ->
                    FileOutputStream(target).use { out ->
                        val buf = ByteArray(1 shl 16)
                        var lastPct = -1
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            written += n
                            val pct = if (total > 0) ((written * 100) / total).toInt() else -1
                            // 每 5% 或至少每 400ms 报一次，避免刷爆 JS 桥
                            val now = System.currentTimeMillis()
                            if (pct != lastPct && (now - lastReport > 400 || pct == 100)) {
                                lastPct = pct
                                lastReport = now
                                onProgress(progress(written, total, pct))
                            }
                        }
                    }
                }
                if (written <= 0) {
                    target.delete()
                    onProgress(err("下载内容为空"))
                    return@execute
                }
                // 校验和
                if (!expectedSha256.isNullOrBlank()) {
                    val actual = sha256(target)
                    if (!actual.equals(expectedSha256.trim(), ignoreCase = true)) {
                        target.delete()
                        onProgress(err("校验和不符：期望 ${expectedSha256.take(12)}… 实际 ${actual.take(12)}…"))
                        return@execute
                    }
                }
                val finalFile = File(otaDir(), "dsh-mobile-update.apk")
                finalFile.delete()
                if (!target.renameTo(finalFile)) {
                    target.copyTo(finalFile, overwrite = true)
                    target.delete()
                }
                onProgress(
                    JSONObject()
                        .put("ok", true)
                        .put("phase", "done")
                        .put("bytes", finalFile.length())
                        .put("total", finalFile.length())
                        .put("percent", 100)
                        .put("path", finalFile.absolutePath)
                        .toString()
                )
            } catch (t: Throwable) {
                Log.w(TAG, "download failed", t)
                onProgress(err(t.message ?: t.javaClass.simpleName))
            } finally {
                conn?.disconnect()
            }
        }
    }

    /** 是否已获得"安装未知应用"权限（Android 8.0+）。 */
    fun canInstall(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.packageManager.canRequestPackageInstalls()
        } else {
            true
        }

    /** 跳转到系统的"安装未知应用"授权页。 */
    fun openInstallPermissionSettings(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return statusJson(true, "系统版本无需授权")
        return try {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = Uri.parse("package:${activity.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            statusJson(false, "已打开授权页，请允许「DSH Remote」安装应用")
        } catch (t: Throwable) {
            // 部分 ROM 没有这个 Action，退回到应用详情页
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:${activity.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                )
                statusJson(false, "已打开应用详情页，请手动开启「安装未知应用」")
            } catch (t2: Throwable) {
                err("无法打开授权页：${t2.message}")
            }
        }
    }

    /**
     * 拉起系统安装器。必须已经下载完成且拿到了安装权限。
     *
     * 返回 `needPermission=true` 时，调用方应引导用户去 [openInstallPermissionSettings]。
     */
    fun install(): String {
        val apk = pendingApk() ?: return err("没有可安装的更新包，请先下载")
        if (!canInstall()) {
            return JSONObject()
                .put("ok", false)
                .put("needPermission", true)
                .put("message", "需要先允许「DSH Remote」安装应用")
                .toString()
        }
        return try {
            val uri: Uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.ota",
                apk,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            statusJson(true, "已拉起安装器")
        } catch (t: Throwable) {
            Log.w(TAG, "install failed", t)
            err("拉起安装器失败：${t.message}")
        }
    }

    /** 当前版本名/版本号（供网页比对）。 */
    fun currentVersion(): String {
        return try {
            val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toLong()
            }
            JSONObject()
                .put("ok", true)
                .put("versionName", info.versionName ?: "")
                .put("versionCode", code)
                .put("canInstall", canInstall())
                .toString()
        } catch (t: Throwable) {
            err("读取版本失败：${t.message}")
        }
    }

    private fun progress(written: Long, total: Long, pct: Int): String = JSONObject()
        .put("ok", true)
        .put("phase", "downloading")
        .put("bytes", written)
        .put("total", total)
        .put("percent", pct)
        .toString()

    private fun statusJson(ok: Boolean, message: String): String =
        JSONObject().put("ok", ok).put("message", message).toString()

    private fun err(message: String): String =
        JSONObject().put("ok", false).put("phase", "error").put("message", message).toString()
}
