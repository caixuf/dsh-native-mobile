package io.github.dshmobile.app.relay

/**
 * 通知点击 → 会话深链的**契约**（常量 + 纯逻辑，可在 JVM 单测里直接跑）。
 *
 * ## 为什么需要它
 *
 * 真主机的审批载荷里带 `sessionId`（`waterfall.request.sessionId`，实测形状见
 * `scripts/e2e-app-ui.mjs` 的假主机）。用户在通知栏点一下，期望的是**直接跳到出事的那个
 * 会话**，而不是落到会话列表自己再找一遍。所以：
 *
 * 1. 通知的 content intent 把 `sessionId` / `eventId` 写进 extra（[NativeDeepLink.EXTRA_*]）；
 * 2. `MainActivity` 从 intent 读出后交给 [PendingDeepLink] 暂存；
 * 3. 网页两种拿法（**二选一，谁先拿到都行**）：
 *    - 注册回调：`window.dshNativeOnDeepLink = (link) => {...}`（壳在页面就绪/`onNewIntent` 时推一次）；
 *    - 主动拉取：`DSHNative.takePendingDeepLink()` → `{"pending":true,"eventId":..,"sessionId":..}`
 *      或 `{"pending":false}`。
 *
 * ## 不重复投递
 *
 * 推送只在网页**确实接住**（返回 `'handled'`）时才消费；网页没接住（回调还没注册）就一直
 * 留在本地，由网页自己 `takePendingDeepLink()` 取走。[PendingDeepLink.take] 是**消费式**的，
 * 取过就没了 —— 不会出现"跳两次"。
 */
object NativeDeepLink {
    const val EXTRA_SESSION_ID = "dsh_session_id"
    const val EXTRA_EVENT_ID = "dsh_event_id"

    /** 网页注册的深链回调：`window.dshNativeOnDeepLink(link)`。 */
    const val JS_HOOK = "dshNativeOnDeepLink"

    /** 网页注册的 BACK 处理函数：`window.dshHandleBack()`，返回 true 表示已处理。 */
    const val JS_BACK_HANDLER = "dshHandleBack"
}

/** 待投递的深链（内存态即可：通知点击一定会把 Activity 拉起来）。 */
class PendingDeepLink {

    data class Link(val eventId: String = "", val sessionId: String = "") {
        val isEmpty: Boolean get() = eventId.isEmpty() && sessionId.isEmpty()
    }

    @Volatile
    private var pending: Link? = null

    /**
     * 记下一条待投递深链。
     *
     * @return 记下的内容；**两者都为空时返回 null 且不覆盖已有的**（
     *         比如状态通知的点击不带 sessionId，不能把待投递的会话冲掉）。
     */
    fun offer(eventId: String?, sessionId: String?): Link? {
        val link = Link(
            eventId = eventId?.trim().orEmpty(),
            sessionId = sessionId?.trim().orEmpty(),
        )
        if (link.isEmpty) return null
        pending = link
        return link
    }

    /** 看看有没有，不消费。 */
    fun peek(): Link? = pending

    /** **消费**：取走之后本地就没有了（不会重复投递）。 */
    fun take(): Link? {
        val link = pending
        pending = null
        return link
    }

    fun clear() {
        pending = null
    }

    companion object {
        /** 网页钩子接住推送时的返回值。 */
        const val PUSH_HANDLED = "handled"

        /** `takePendingDeepLink()` 的返回形状（`MiniJson.write`）。 */
        fun toJson(link: Link?): String = if (link == null) {
            MiniJson.write(mapOf("pending" to false))
        } else {
            MiniJson.write(
                linkedMapOf(
                    "pending" to true,
                    "eventId" to link.eventId,
                    "sessionId" to link.sessionId,
                )
            )
        }

        /**
         * 推送载荷：**不带 `pending` 字段**（它只用于 pull 形状），只给网页它要的会话。
         *
         * U+2028/U+2029 在 JSON 里合法、在 JS 源码里是换行符，必须转义，否则嵌进脚本会语法错。
         */
        fun payloadLiteral(link: Link): String =
            MiniJson.write(linkedMapOf("eventId" to link.eventId, "sessionId" to link.sessionId))
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029")

        /**
         * 推送给网页的脚本。
         *
         * 返回值只有 `'handled'` 表示网页真的接住了 —— 壳据此决定是否消费，
         * 否则（`'missing'` / `'error'`）留在本地等网页 pull。
         */
        fun pushScript(link: Link): String =
            "(function(){ if (typeof window.${NativeDeepLink.JS_HOOK} !== 'function') return 'missing';" +
                " try { window.${NativeDeepLink.JS_HOOK}(${payloadLiteral(link)}); return '$PUSH_HANDLED'; }" +
                " catch (e) { return 'error'; } })()"

        fun pushAccepted(result: String?): Boolean =
            decodeWebViewResult(result) == PUSH_HANDLED
    }
}