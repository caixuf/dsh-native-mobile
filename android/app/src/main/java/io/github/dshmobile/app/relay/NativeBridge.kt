package io.github.dshmobile.app.relay

import android.app.Activity
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
 * 这个桥**只暴露连接配置与状态查询**，不提供文件访问、不提供任意 URL 请求。
 * 网页来自 `file:///android_asset/web/`（本地打包资产，非远程内容），
 * 因此不存在"远程页面调用本地能力"的注入面。
 *
 * ⚠️ 所有方法**都不抛异常**，一律返回 JSON 字符串：跨 JS 边界抛出的异常会变成
 * 网页里一个难以归因的 "Java exception was raised"，不如老老实实返回错误对象。
 */
class NativeBridge(private val activity: Activity) {

    private val store: RelayStore get() = RelayStore(activity)

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
        )
    )

    private fun error(message: String): String =
        MiniJson.write(mapOf("available" to true, "error" to message))
}