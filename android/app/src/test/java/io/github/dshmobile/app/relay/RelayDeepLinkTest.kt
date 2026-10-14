package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通知点击 → 会话深链。
 *
 * 判据必须与 `src/App.tsx` 的 `handleHostRequest` 一致：真主机把会话 id 放在
 * `waterfall.request.sessionId`（`scripts/e2e-app-ui.mjs` 的假主机就是这个形状），
 * 部分形状回落 `request.address.sessionId`。
 */
class RelayDeepLinkTest {

    /** 假主机（= 真主机实测形状）发出的审批 request。 */
    private fun approvalRequest(extra: Map<String, Any?> = emptyMap()): Map<String, Any?> =
        buildMap<String, Any?> {
            put("toolName", "shell")
            put("displayReason", mapOf("zh" to "将要执行 rm -rf build/", "en" to "Will run rm -rf build/"))
            putAll(extra)
        }

    @Test
    fun `approval prompt carries the session id from the waterfall request`() {
        val prompt = PromptClassifier.classify(
            eventName = "tool/approval",
            eventId = "ev-deep-1",
            request = approvalRequest(mapOf("sessionId" to "session-project-init-01")),
        )!!
        assertEquals("session-project-init-01", prompt.sessionId)
    }

    @Test
    fun `session id falls back to request address`() {
        val prompt = PromptClassifier.classify(
            "tool/approval",
            "ev-deep-2",
            approvalRequest(mapOf("address" to mapOf("kind" to "session", "sessionId" to "session-addr-9"))),
        )!!
        assertEquals("session-addr-9", prompt.sessionId)
    }

    @Test
    fun `top level session id wins over address`() {
        val prompt = PromptClassifier.classify(
            "tool/approval",
            "ev-deep-3",
            approvalRequest(
                mapOf(
                    "sessionId" to "session-top",
                    "address" to mapOf("sessionId" to "session-addr"),
                )
            ),
        )!!
        assertEquals("session-top", prompt.sessionId)
    }

    @Test
    fun `no session id means null not empty string`() {
        assertNull(PromptClassifier.classify("tool/approval", "ev-deep-4", approvalRequest())!!.sessionId)
        assertNull(
            PromptClassifier.classify("tool/approval", "ev-deep-5", approvalRequest(mapOf("sessionId" to "  ")))!!.sessionId
        )
    }

    // ── 待投递深链（消费式，不重复跳转）──────────────────────────────────────

    @Test
    fun `pending link is consumed exactly once`() {
        val pending = PendingDeepLink()
        val link = pending.offer("ev-1", "session-1")!!
        assertEquals("ev-1", link.eventId)
        assertEquals("session-1", link.sessionId)

        assertEquals(link, pending.peek())
        assertEquals(link, pending.take())
        assertNull("take 之后本地就没有了（防重复跳转）", pending.peek())
        assertNull(pending.take())
    }

    @Test
    fun `blank link is ignored and does not clobber a pending one`() {
        val pending = PendingDeepLink()
        val kept = pending.offer("ev-keep", "session-keep")!!
        // 连接状态通知的点击不带 sessionId：不能把待投递的会话冲掉
        assertNull(pending.offer(null, null))
        assertNull(pending.offer("", "   "))
        assertEquals(kept, pending.take())
    }

    @Test
    fun `link values are trimmed`() {
        val link = PendingDeepLink().offer("  ev  ", "  session-x  ")!!
        assertEquals("ev", link.eventId)
        assertEquals("session-x", link.sessionId)
    }

    // ── 给网页的两种形状 ───────────────────────────────────────────────────

    @Test
    fun `pull shape is json the web can parse`() {
        val pending = PendingDeepLink().offer("ev-1", "session-1")!!
        val map = MiniJson.obj(MiniJson.parse(PendingDeepLink.toJson(pending)))!!
        assertTrue(map["pending"] == true)
        assertEquals("ev-1", map["eventId"])
        assertEquals("session-1", map["sessionId"])

        val empty = MiniJson.obj(MiniJson.parse(PendingDeepLink.toJson(null)))!!
        assertTrue(empty["pending"] == false)
        assertNull(empty["sessionId"])
    }

    @Test
    fun `push payload is plain json literal without the pending flag`() {
        val link = PendingDeepLink.Link(eventId = "ev-1", sessionId = "session-1")
        val map = MiniJson.obj(MiniJson.parse(PendingDeepLink.payloadLiteral(link)))!!
        assertEquals("ev-1", map["eventId"])
        assertEquals("session-1", map["sessionId"])
        assertFalse("push 载荷只给网页要的会话，不带 pull 专用的 pending 字段", map.containsKey("pending"))
    }

    @Test
    fun `push script calls the documented hook and reports whether it was accepted`() {
        val link = PendingDeepLink.Link(eventId = "ev-1", sessionId = "session-1")
        val script = PendingDeepLink.pushScript(link)
        assertTrue(script.contains(NativeDeepLink.JS_HOOK))
        assertTrue(script.contains(PendingDeepLink.payloadLiteral(link)))
        assertTrue("必须包住异常：网页抛错不能让壳崩", script.contains("catch"))
        assertTrue(script.contains(PendingDeepLink.PUSH_HANDLED))
    }

    @Test
    fun `push is only consumed when the web says handled`() {
        assertTrue(PendingDeepLink.pushAccepted("\"handled\"")) // evaluateJavascript 的结果是 JSON 编码的
        assertTrue(PendingDeepLink.pushAccepted("handled"))
        assertFalse(PendingDeepLink.pushAccepted("\"missing\""))
        assertFalse(PendingDeepLink.pushAccepted("\"error\""))
        assertFalse(PendingDeepLink.pushAccepted("null"))
        assertFalse(PendingDeepLink.pushAccepted(null))
    }

    @Test
    fun `payload escapes line separators that would break the injected script`() {
        // U+2028/U+2029 在 JSON 里合法、在 JS 源码里是换行符：不转义会直接语法错
        val link = PendingDeepLink.Link(eventId = "ev", sessionId = "a\u2028b\u2029c")
        val literal = PendingDeepLink.payloadLiteral(link)
        assertFalse(literal.contains('\u2028'))
        assertFalse(literal.contains('\u2029'))
        assertTrue(literal.contains("\\u2028"))
        // 转义后仍是合法 JSON，且取回来还是原值
        val map = MiniJson.obj(MiniJson.parse(literal))!!
        assertEquals("a\u2028b\u2029c", map["sessionId"])
    }
}