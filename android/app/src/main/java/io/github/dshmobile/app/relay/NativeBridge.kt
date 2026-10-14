package io.github.dshmobile.app.relay

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.JavascriptInterface

/**
 * WebView ↔ 原生 的桥。
 *
 * ## 为什么需要它
 *
 * 中继服务是**原生**的，它需要主机地址与设备令牌。这两样东西现在只存在于网页端的
 * `localStorage` 里。让原生去解析 WebView 的 leveldb 是脆的；让网页端在**连接成功时
 * 主动把凭据交给原生**才是可靠的：
 *
 * ```js
 * window.DSHNative?.setConnection(baseUrl, token, label)
 * ```
 *
 * ## 安全边界
 *
 * 这个桥**只暴露连接配置、状态查询、通知设置入口与路由/深链上报**，
 * 不提供文件访问、不提供任意 URL 请求。
 * 网页来自 `file:///android_asset/web/`（本地打包资产，非远程内容），
 * 因此不存在"远程页面调用本地能力"的注入面。
 *
 * ⚠️ 所有方法**都不抛异常**，一律返回 JSON 字符串：跨 JS 边界抛出的异常会变成
 * 网页里一个难以归因的 "Java exception was raised"，不如老老实实返回错误对象。
 */
class NativeBridge(
    private val activity: Activity,
    /** 网页上报的路由（`setRoute`），BACK 判定读它。 */
    private val routes: WebRouteTracker = WebRouteTracker(),
    /** 通知点击带来的会话深链，网页用 `takePendingDeepLink()` 取走。 */
    private val deepLinks: PendingDeepLink = PendingDeepLink(),
) {

    private val store: RelayStore get() = RelayStore(activity)

    /** 当前网页路由（供 `MainActivity` 的 BACK 判定读取）。 */
    fun route(): WebRoute = routes.current()

    /** 深链暂存区（供 `MainActivity` 从 intent 写入 / 推送给网页）。 */
    fun deepLinks(): PendingDeepLink = deepLinks

    /** 网页端连接成功时调用：持久化凭据并拉起中继服务。 */
    @JavascriptInterface
    fun setConnection(baseUrl: String, token: String, label: String): String {
        if (baseUrl.isBlank() || token.isBlank()) {
            return error("baseUrl/token 不能为空")
        }
        store.saveConnection(baseUrl.trim().trimEnd('/'), token.trim(), label.trim())
        ApprovalRelayService.start(activity)
        return status()
    }

    /** 用户在网页端忘记/切换主机时调用：停服务并清凭据。 */
    @JavascriptInterface
    fun clearConnection(): String {
        ApprovalRelayService.stop(activity)
        store.clearConnection()
        return status()
    }

    /** 主动重连（用户点了"重试"）。 */
    @JavascriptInterface
    fun reconnect(): String {
        if (!store.isConfigured()) return error("尚未配对")
        ApprovalRelayService.start(activity)
        return status()
    }

    /**
     * 该事件是否已经**从中继（通知栏）作答过**。
     *
     * 网页端据此把已经处理掉的待办弹窗收起来。没有它就会出现
     * 「通知栏点过允许了，App 里还挂着一个让我点的弹窗」——用户会怀疑自己到底批没批，
     * 甚至再点一次（对同一个 eventId 重复应答）。
     */
    @JavascriptInterface
    fun isAnswered(eventId: String): Boolean = store.answered.isAnswered(eventId)

    /**
     * 网页上报当前路由 —— BACK 判定的**唯一**依据。
     *
     * ```js
     * DSHNative.setRoute(JSON.stringify({ route, drawerOpen }));
     * ```
     *
     * 输入坏掉/没上报时退化成"未上报"：壳就**绝不自己退出 App**（见 [ShellBackPolicy]）。
     * 参数可空：网页漏传时桥给的是 `null`，不能因此抛 "Java exception was raised"。
     *
     * @return 解析后的状态（`reported=false` 表示这次没被采纳）。
     */
    @JavascriptInterface
    fun setRoute(stateJson: String?): String {
        val route = routes.update(stateJson)
        return MiniJson.write(
            mapOf(
                "ok" to true,
                "route" to route.name,
                "drawerOpen" to route.drawerOpen,
                "reported" to route.reported,
            )
        )
    }

    /**
     * 取走一条"从通知点进来"的会话深链（**消费式**，取过就没了）。
     *
     * 网页有两种拿法，谁先拿到都行：注册 `window.dshNativeOnDeepLink(link)` 回调，
     * 或者调本方法主动拉。返回值：
     * `{"pending":true,"eventId":"…","sessionId":"…"}` 或 `{"pending":false}`。
     */
    @JavascriptInterface
    fun takePendingDeepLink(): String = PendingDeepLink.toJson(deepLinks.take())

    /**
     * 打开系统通知设置页（Android 13+ 未授权时的一键入口）。
     *
     * 网页不该只说"通知没开" —— 用户得知道**去哪开**。少数 ROM 没有通知设置页，
     * 这里回落到应用详情页；两条都失败也必须如实返回错误，不能"点了没反应"。
     */
    @JavascriptInterface
    fun openNotificationSettings(): String {
        val enabled = RelayNotifications.notificationsEnabled(activity)
        try {
            activity.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            return MiniJson.write(mapOf("ok" to true, "notificationsEnabled" to enabled))
        } catch (e: Exception) {
            return try {
                activity.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.fromParts("package", activity.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                MiniJson.write(
                    mapOf("ok" to true, "fallback" to true, "notificationsEnabled" to enabled)
                )
            } catch (e2: Exception) {
                MiniJson.write(
                    mapOf(
                        "ok" to false,
                        "error" to (e2.message ?: "无法打开系统设置"),
                        "notificationsEnabled" to enabled,
                    )
                )
            }
        }
    }

    /**
     * 中继状态。
     *
     * `notificationsEnabled=false` 是**必须让用户看到**的事实：服务在守护，
     * 但审批到了手机也不会响 —— 这正是"以为在守护、其实什么都没有"的成因。
     */
    @JavascriptInterface
    fun status(): String = MiniJson.write(
        mapOf(
            "available" to true,
            "configured" to store.isConfigured(),
            "state" to ApprovalRelayService.state,
            "clientId" to store.clientId,
            "label" to store.label,
            "notificationsEnabled" to RelayNotifications.notificationsEnabled(activity),
            "lastError" to store.lastError,
            // 与前台通知文案同源：通知栏说"有 N 项待处理"时这里也是 N。
            "pendingApprovals" to ApprovalRelayService.pendingApprovals,
            // 网页上报的路由（`reported=false` 说明壳与网页的接线还没生效）。
            "route" to routes.current().name,
            "routeReported" to routes.current().reported,
        )
    )

    private fun error(message: String): String =
        MiniJson.write(mapOf("available" to true, "error" to message))
}