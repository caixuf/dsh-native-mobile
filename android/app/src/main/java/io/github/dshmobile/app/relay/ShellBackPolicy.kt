package io.github.dshmobile.app.relay

/**
 * 系统 BACK 键的判定 —— **纯逻辑，零 Android 依赖**（见 `ShellBackPolicyTest`）。
 *
 * ## 为什么要有这个文件（真机实测事故）
 *
 * 旧实现是 `if (webView.canGoBack()) goBack() else super.onBackPressed()`。
 * 网页是 SPA：路由切换**不产生** WebView 历史，所以 `canGoBack()` 永远是 false，
 * 于是在"会话列表"（根页面）按一下 BACK 就**直接退出 App** ——
 * 用户只是想回到上一级，却把整个 App 关掉了。
 *
 * ## 判定规则（与 `src/App.tsx` 的路由对齐：`hosts | pair | sessions | chat`）
 *
 * 网页通过 `DSHNative.setRoute(JSON.stringify({route, drawerOpen}))` 上报当前界面；
 * 壳在按下 BACK 时按下面的顺序判定：
 *
 * | 情形 | 动作 |
 * |---|---|
 * | 网页**从未上报**（壳与网页接线未生效） | 问网页；网页不接就**两次确认**才退，绝不一次就退 |
 * | 抽屉打开 | 问网页（关抽屉） |
 * | 路由不是 `sessions`（chat / hosts / pair） | 问网页（回上一级） |
 * | `sessions` + WebView 有历史 | `webView.goBack()` |
 * | `sessions` + 无历史 + 首次按 | 提示"再按一次退出"，**本次不退** |
 * | `sessions` + 无历史 + 2s 内再按 | 退出 |
 *
 * 一句话：**只有"确认在根页面（sessions）、无历史、且 2 秒内按了第二次"才退出**；
 * 其余任何情况都不退出（最坏是"什么都不做"，绝不能是"误退"）。
 *
 * ## 网页侧要接的两个钩子
 *
 * ```js
 * window.dshHandleBack = () => {
 *   if (drawerOpen) { setDrawerOpen(false); return true; }
 *   if (route === 'chat')  { setRoute('sessions'); return true; }
 *   if (route === 'pair')  { setRoute(hosts.length ? 'hosts' : 'sessions'); return true; }
 *   if (route === 'hosts') { setRoute('sessions'); return true; }
 *   return false;              // 根页面：交回原生，由上面的规则决定
 * };
 * DSHNative.setRoute(JSON.stringify({ route, drawerOpen }));  // 路由/抽屉一变就调
 * ```
 */
object ShellRoutes {
    /** 会话列表：**根页面**。 */
    const val SESSIONS = "sessions"

    /** 聊天页（深页）。 */
    const val CHAT = "chat"

    /** 主机管理（深页）。 */
    const val HOSTS = "hosts"

    /** 配对页（深页）。 */
    const val PAIR = "pair"

    /** 网页报了不认识的名字 / 根本没报。**绝不当作根页面**。 */
    const val UNKNOWN = "unknown"

    val ALL = listOf(SESSIONS, CHAT, HOSTS, PAIR)

    fun normalize(name: String?): String {
        val n = name?.trim()?.lowercase().orEmpty()
        return if (n in ALL) n else UNKNOWN
    }
}

/**
 * 网页上报的界面状态。
 *
 * [reported] = 网页是否**真的**上报过。它和 `route == sessions` 是两件事：
 * 没上报时我们**不知道**用户在哪一页，因此不能假设"在根页面可以退出"。
 */
data class WebRoute(
    val name: String = ShellRoutes.UNKNOWN,
    val drawerOpen: Boolean = false,
    val reported: Boolean = false,
) {
    /** 会话列表 = 本 App 的根页面。 */
    val isRoot: Boolean get() = name == ShellRoutes.SESSIONS

    companion object {
        /** 网页还没上报过（壳刚启动 / 网页是旧包）。 */
        val UNREPORTED = WebRoute()
    }
}

/** `setRoute` 的解析。**任何坏输入都退化成"未上报"，绝不抛异常跨 JS 边界。** */
object WebRouteCodec {

    fun parse(json: String?): WebRoute {
        val raw = json?.trim().orEmpty()
        if (raw.isEmpty()) return WebRoute.UNREPORTED
        val map = try {
            MiniJson.obj(MiniJson.parse(raw))
        } catch (e: MiniJson.JsonError) {
            null
        } ?: return WebRoute.UNREPORTED
        val name = MiniJson.str(map, "route")
        if (name.isNullOrBlank()) return WebRoute.UNREPORTED
        return WebRoute(
            name = ShellRoutes.normalize(name),
            // 非布尔（没传/传了字符串）一律当"抽屉是关的"：误判成"开着"会让 BACK 失效。
            drawerOpen = map["drawerOpen"] as? Boolean ?: false,
            reported = true,
        )
    }
}

/** 网页上报状态的持有者（`NativeBridge.setRoute` 写、`MainActivity` 读）。 */
class WebRouteTracker {

    @Volatile
    private var route: WebRoute = WebRoute.UNREPORTED

    fun current(): WebRoute = route

    fun update(json: String?): WebRoute = WebRouteCodec.parse(json).also { route = it }

    fun reset() {
        route = WebRoute.UNREPORTED
    }
}

/** 一次 BACK 的输入快照。 */
data class ShellBackState(
    val route: WebRoute,
    val webViewCanGoBack: Boolean,
)

/** BACK 的处置方式。 */
enum class ShellBackAction {
    /** 先问网页（关抽屉 / 回上一级）；网页说没处理再走 [ShellBackPolicy.nativeFallback]。 */
    DELEGATE_TO_WEB,

    /** WebView 自己还有历史页 → `goBack()`。 */
    WEB_HISTORY_BACK,

    /** 确实在根页面，但需要 2 秒内再按一次（本次只提示）。 */
    CONFIRM_EXIT,

    /** 退出 App。 */
    EXIT_APP,

    /** 什么都不做。用于"网页没接线 + 用户在深页"：宁可不响应，也不能退出。 */
    IGNORE,
}

/**
 * 解一层 `WebView.evaluateJavascript` 的回调结果。
 *
 * 🔴 `evaluateJavascript(script, callback)` 的回调拿到的是结果的 **JSON 编码**：
 * JS 里 `return 'true'`，回调里就是 `"\"true\""`（**带引号**）。直接写
 * `result == "true"` 会永远为 false —— 整条判定静默失效，BACK 就退回"什么都不做"。
 * 所以任何比较之前必须先过这一层（真机实测踩点，见 ShellBackPolicyTest）。
 */
fun decodeWebViewResult(raw: String?): String? {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty() || text == "null") return null
    return try {
        MiniJson.parse(text) as? String ?: text
    } catch (e: MiniJson.JsonError) {
        // 不是合法 JSON（老版本 WebView / 被截断）：原样返回，交给调用方判定。
        text
    }
}

/** 网页回答"我处理了"了吗。**只有 `true` 算处理**（含 JSON 编码的 `"true"`）。 */
fun webHandledBack(result: String?): Boolean = decodeWebViewResult(result) == "true"

object ShellBackPolicy {

    /** 二次确认的有效窗口。超过它就得重新确认。 */
    const val EXIT_CONFIRM_WINDOW_MS = 2_000L

    /** 该不该先问网页。 */
    fun shouldAskWeb(state: ShellBackState): Boolean {
        val route = state.route
        if (!route.reported) return true // 不知道在哪一页 → 绝不自己退
        if (route.drawerOpen) return true // 抽屉开着 → 由网页关掉
        if (!route.isRoot) return true // chat / hosts / pair → 由网页回上一级
        return false
    }

    /** 网页回答"我处理了"了吗。**只有字符串 `true` 算处理**。 */
    fun webHandled(result: String?): Boolean = webHandledBack(result)

    /** 网页说"我处理不了"时的原生兜底。 */
    fun nativeFallback(state: ShellBackState, nowMs: Long, lastExitConfirmMs: Long?): ShellBackAction {
        if (state.webViewCanGoBack) return ShellBackAction.WEB_HISTORY_BACK
        // 已确认在深页而网页没接线：不动（onBackPressed 不响应），也绝不退出。
        if (state.route.reported && !state.route.isRoot) return ShellBackAction.IGNORE
        return rootAction(nowMs, lastExitConfirmMs)
    }

    /** 不需要问网页时（已确认在根页面）的判定。 */
    fun nativeAction(state: ShellBackState, nowMs: Long, lastExitConfirmMs: Long?): ShellBackAction {
        if (state.webViewCanGoBack) return ShellBackAction.WEB_HISTORY_BACK
        if (!state.route.reported || !state.route.isRoot) {
            // 防呆：调用方本不该在这里问。宁可交给网页，也不误退。
            return ShellBackAction.DELEGATE_TO_WEB
        }
        return rootAction(nowMs, lastExitConfirmMs)
    }

    fun decide(state: ShellBackState, nowMs: Long, lastExitConfirmMs: Long?): ShellBackAction =
        if (shouldAskWeb(state)) {
            ShellBackAction.DELEGATE_TO_WEB
        } else {
            nativeAction(state, nowMs, lastExitConfirmMs)
        }

    /** 根页面 + 无 WebView 历史：首次 `CONFIRM_EXIT`，窗口内再按 `EXIT_APP`。 */
    private fun rootAction(nowMs: Long, lastExitConfirmMs: Long?): ShellBackAction {
        val confirmed = lastExitConfirmMs != null &&
            nowMs >= lastExitConfirmMs &&
            nowMs - lastExitConfirmMs <= EXIT_CONFIRM_WINDOW_MS
        return if (confirmed) ShellBackAction.EXIT_APP else ShellBackAction.CONFIRM_EXIT
    }

    /**
     * 交给网页处理的脚本：`window.dshHandleBack()` 返回 `true` 表示已处理。
     *
     * 用一次性 IIFE 包住并 catch：网页抛异常时返回 `'false'`（回退到原生兜底），
     * 而不是让 `evaluateJavascript` 拿到一个 JS 异常。
     */
    fun webBackScript(): String =
        "(function(){ try { return (typeof window.${NativeDeepLink.JS_BACK_HANDLER} === 'function')" +
            " && window.${NativeDeepLink.JS_BACK_HANDLER}() === true ? 'true' : 'false'; }" +
            " catch (e) { return 'false'; } })()"
}