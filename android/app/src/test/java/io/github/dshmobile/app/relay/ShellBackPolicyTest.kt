package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BACK 判定 —— 这是真机实测事故的回归测试。
 *
 * 事故：旧实现 `if (webView.canGoBack()) goBack() else super.onBackPressed()`。
 * 网页是 SPA，路由切换不产生 WebView 历史 → `canGoBack()` 恒为 false →
 * **在会话列表按一下 BACK 就直接退出 App**。
 *
 * 下面第一条测试就是这个场景：它必须**不**得出"退出"。
 */
class ShellBackPolicyTest {

    private val now = 1_000_000L

    private fun route(name: String, drawerOpen: Boolean = false): WebRoute =
        WebRoute(name = name, drawerOpen = drawerOpen, reported = true)

    private fun state(
        name: String,
        drawerOpen: Boolean = false,
        canGoBack: Boolean = false,
    ): ShellBackState = ShellBackState(route = route(name, drawerOpen), webViewCanGoBack = canGoBack)

    private fun unreported(canGoBack: Boolean = false): ShellBackState =
        ShellBackState(route = WebRoute.UNREPORTED, webViewCanGoBack = canGoBack)

    private fun decide(s: ShellBackState, last: Long? = null) =
        ShellBackPolicy.decide(s, now, last)

    // ── 事故回归 ────────────────────────────────────────────────────────────

    @Test
    fun `back on sessions list with no webview history does NOT exit`() {
        // 旧代码在这里就是 finish()。修复后：先问网页（抽屉/上一级），网页不接也只是提示。
        assertEquals(ShellBackAction.DELEGATE_TO_WEB, decide(unreported()))

        val afterWebDeclined = ShellBackPolicy.nativeFallback(unreported(), now, null)
        assertNotEquals(ShellBackAction.EXIT_APP, afterWebDeclined)
        assertEquals(ShellBackAction.CONFIRM_EXIT, afterWebDeclined)
    }

    @Test
    fun `sessions list needs a second press inside the window to exit`() {
        val s = state(ShellRoutes.SESSIONS)
        assertEquals(ShellBackAction.CONFIRM_EXIT, decide(s))
        assertEquals(ShellBackAction.EXIT_APP, decide(s, last = now - 200))
        // 窗口边界（含）仍算确认
        assertEquals(ShellBackAction.EXIT_APP, decide(s, last = now - ShellBackPolicy.EXIT_CONFIRM_WINDOW_MS))
        // 超出窗口要重新确认
        assertEquals(ShellBackAction.CONFIRM_EXIT, decide(s, last = now - ShellBackPolicy.EXIT_CONFIRM_WINDOW_MS - 1))
    }

    @Test
    fun `webview history is used before ever considering exit`() {
        assertEquals(ShellBackAction.WEB_HISTORY_BACK, decide(state(ShellRoutes.SESSIONS, canGoBack = true)))
        // 有历史时，即使刚确认过退出也不该 finish()
        assertEquals(
            ShellBackAction.WEB_HISTORY_BACK,
            decide(state(ShellRoutes.SESSIONS, canGoBack = true), last = now - 100),
        )
    }

    // ── 优先"关抽屉 / 回上一级" ─────────────────────────────────────────────

    @Test
    fun `open drawer is delegated to the web first`() {
        assertEquals(ShellBackAction.DELEGATE_TO_WEB, decide(state(ShellRoutes.SESSIONS, drawerOpen = true)))
        // 抽屉开着 + 刚按过退出：仍然先关抽屉，不能退出
        assertEquals(
            ShellBackAction.DELEGATE_TO_WEB,
            decide(state(ShellRoutes.SESSIONS, drawerOpen = true), last = now - 10),
        )
    }

    @Test
    fun `deep routes are delegated to the web`() {
        for (name in listOf(ShellRoutes.CHAT, ShellRoutes.HOSTS, ShellRoutes.PAIR)) {
            assertEquals("路由 $name 应交给网页回上一级", ShellBackAction.DELEGATE_TO_WEB, decide(state(name)))
        }
    }

    @Test
    fun `unknown route is never treated as root`() {
        // 网页报了不认识的名字：保守处理，绝不退出
        assertEquals(ShellBackAction.DELEGATE_TO_WEB, decide(state(ShellRoutes.UNKNOWN)))
        assertEquals(ShellBackAction.IGNORE, ShellBackPolicy.nativeFallback(state(ShellRoutes.UNKNOWN), now, null))
        assertEquals(ShellBackAction.IGNORE, ShellBackPolicy.nativeFallback(state(ShellRoutes.CHAT), now, null))
    }

    // ── 网页没接线时的兜底 ───────────────────────────────────────────────────

    @Test
    fun `web not wired never exits on a single press`() {
        // 网页是旧包（没上报路由、也没注册 dshHandleBack）：两次确认才退，绝不一次就退
        assertEquals(ShellBackAction.CONFIRM_EXIT, ShellBackPolicy.nativeFallback(unreported(), now, null))
        assertEquals(ShellBackAction.EXIT_APP, ShellBackPolicy.nativeFallback(unreported(), now, now - 50))
    }

    @Test
    fun `fallback prefers webview history over root exit`() {
        assertEquals(ShellBackAction.WEB_HISTORY_BACK, ShellBackPolicy.nativeFallback(unreported(canGoBack = true), now, null))
    }

    @Test
    fun `nativeAction refuses to exit when route is not a confirmed root`() {
        // 防呆：调用方本不该在深页调 nativeAction。结果只能是"交给网页"，不会是退出。
        assertEquals(ShellBackAction.DELEGATE_TO_WEB, ShellBackPolicy.nativeAction(state(ShellRoutes.CHAT), now, now - 10))
        assertEquals(ShellBackAction.DELEGATE_TO_WEB, ShellBackPolicy.nativeAction(unreported(), now, now - 10))
    }

    // ── 网页回话的解析（JSON 编码这一层最容易写错）──────────────────────────

    @Test
    fun `evaluateJavascript result is json encoded and must be decoded`() {
        // ⚠️ 真机事实：JS `return 'true'` → 回调拿到的是带引号的 "\"true\""
        assertEquals("true", decodeWebViewResult("\"true\""))
        assertEquals("false", decodeWebViewResult("\"false\""))
        assertNull(decodeWebViewResult("null"))
        assertNull(decodeWebViewResult(null))
        assertNull(decodeWebViewResult("  "))
        // 没有编码的结果也要能认（不同 WebView 版本/脚本写法）
        assertEquals("true", decodeWebViewResult("true"))

        assertTrue(ShellBackPolicy.webHandled("\"true\""))
        assertTrue(ShellBackPolicy.webHandled("true"))
        assertFalse(ShellBackPolicy.webHandled("\"false\""))
        assertFalse(ShellBackPolicy.webHandled("null"))
        assertFalse(ShellBackPolicy.webHandled(null))
        assertFalse(ShellBackPolicy.webHandled(""))
    }

    @Test
    fun `back script calls the documented handler and swallows exceptions`() {
        val script = ShellBackPolicy.webBackScript()
        assertTrue("必须调用网页注册的处理器", script.contains(NativeDeepLink.JS_BACK_HANDLER))
        assertTrue("网页抛异常要回落成 false，不能让回调拿到异常", script.contains("catch"))
        assertTrue(script.contains("'false'"))
    }

    // ── 路由解析 / 上报 ─────────────────────────────────────────────────────

    @Test
    fun `route json is parsed and normalized`() {
        val parsed = WebRouteCodec.parse("""{"route":"chat","drawerOpen":true}""")
        assertEquals(ShellRoutes.CHAT, parsed.name)
        assertTrue(parsed.drawerOpen)
        assertTrue(parsed.reported)

        assertEquals(ShellRoutes.SESSIONS, WebRouteCodec.parse("""{"route":"SESSIONS "}""").name)
        assertEquals(ShellRoutes.UNKNOWN, WebRouteCodec.parse("""{"route":"whatever"}""").name)
        assertTrue(WebRouteCodec.parse("""{"route":"whatever"}""").reported)
    }

    @Test
    fun `bad route input degrades to unreported instead of throwing`() {
        for (bad in listOf(null, "", "   ", "{", "[]", """{"nope":1}""", """{"route":123}""")) {
            val parsed = WebRouteCodec.parse(bad)
            assertFalse("坏输入 '$bad' 不能算已上报", parsed.reported)
            assertEquals(ShellRoutes.UNKNOWN, parsed.name)
            assertFalse(parsed.drawerOpen)
        }
    }

    @Test
    fun `drawer flag only accepts real booleans`() {
        // 传成字符串时按"抽屉是关的"处理：误判成"开着"会让 BACK 永远先问网页（表现为按键无反应）
        assertFalse(WebRouteCodec.parse("""{"route":"chat","drawerOpen":"true"}""").drawerOpen)
    }

    @Test
    fun `tracker keeps the latest reported route and can reset`() {
        val tracker = WebRouteTracker()
        assertFalse(tracker.current().reported)

        tracker.update("""{"route":"chat"}""")
        assertEquals(ShellRoutes.CHAT, tracker.current().name)

        // 坏输入不保留上一次的有效状态，而是退化成"未上报" ——
        // 保守方向是对的：不知道在哪一页时，壳绝不自己退出。
        tracker.update("{")
        assertFalse(tracker.current().reported)

        tracker.update("""{"route":"sessions"}""")
        tracker.reset()
        assertFalse(tracker.current().reported)
    }
}