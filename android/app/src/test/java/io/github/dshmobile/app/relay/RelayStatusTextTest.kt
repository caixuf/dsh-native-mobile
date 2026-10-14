package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 前台通知文案 ≡ 状态查询。
 *
 * 真机上的矛盾：`status()` 返回 `handshaking`，通知栏却写着"已连接 · 等待审批"。
 * 根因是 `state` 与文案各写各的。现在两者都由 [ForegroundStatus] 推导 ——
 * 下面的测试把这个"不可能矛盾"钉住。
 */
class RelayStatusTextTest {

    private fun text(
        state: String,
        configured: Boolean = true,
        notificationsEnabled: Boolean = true,
        pending: Int = 0,
        attempt: Int = 0,
        backoffSeconds: Int = 0,
    ) = RelayStatusText.foreground(
        ForegroundStatus(
            state = state,
            configured = configured,
            notificationsEnabled = notificationsEnabled,
            pendingApprovals = pending,
            attempt = attempt,
            backoffSeconds = backoffSeconds,
        )
    )

    @Test
    fun `every known state has its own non-blank text`() {
        val texts = RelayStates.ALL.associateWith { text(it) }
        assertEquals(RelayStates.ALL.size, texts.values.toSet().size) // 不能有两态同一句话
        for ((state, value) in texts) {
            assertTrue("状态 $state 的文案不能是空的", value.isNotBlank())
        }
    }

    @Test
    fun `handshaking never claims the channel is connected and waiting`() {
        val value = text(RelayStates.HANDSHAKING)
        // 这正是真机上的那句谎话：握手还没完成就说"已连接 · 等待审批"
        assertFalse("握手中不能说'等待审批'", value.contains("等待审批"))
        assertFalse("握手中不能说'已连接'", value.contains("已连接"))
        assertTrue(value.contains("同步"))
    }

    @Test
    fun `notifications disabled is called out even while connected`() {
        val value = text(RelayStates.CONNECTED, notificationsEnabled = false, pending = 3)
        assertTrue("通知未授权必须说出来", value.contains("通知未授权"))
        assertFalse("通知未授权时不能说'等待审批'（会让人以为能收到）", value.contains("等待审批"))
    }

    @Test
    fun `pending approvals appear in the text and match the count`() {
        assertEquals("已连接 · 有 2 项审批待你处理", text(RelayStates.CONNECTED, pending = 2))
        assertEquals("已连接 · 等待审批", text(RelayStates.CONNECTED, pending = 0))
    }

    @Test
    fun `unpaired wins over state text`() {
        // 没配对时状态仍是 stopped，但用户要看到的是"去配对"
        for (state in RelayStates.ALL) {
            assertEquals("未配对：请先在 App 里连接电脑", text(state, configured = false))
        }
    }

    @Test
    fun `retrying text answers how long the user must wait`() {
        val value = text(RelayStates.RETRYING, attempt = 3, backoffSeconds = 8)
        assertTrue(value.contains("重连中"))
        assertTrue(value.contains("第 3 次"))
        assertTrue(value.contains("8 秒"))
    }

    @Test
    fun `auth failure tells the user what to do`() {
        val value = text(RelayStates.AUTH_FAILED)
        assertTrue("必须给出下一步动作", value.contains("重新配对"))
        assertFalse("令牌失效不是'重连中'", value.contains("重连中"))
    }

    @Test
    fun `stopped and unknown states are never blank or pretending to work`() {
        assertTrue(text(RelayStates.STOPPED).contains("停止"))
        val unknown = text("some-future-state")
        assertTrue("未知状态要如实报出来，不能装作正常", unknown.contains("some-future-state"))
    }

    @Test
    fun `text is a pure function of the inputs`() {
        val status = ForegroundStatus(state = RelayStates.CONNECTED, pendingApprovals = 1)
        assertEquals(RelayStatusText.foreground(status), RelayStatusText.foreground(status.copy()))
    }
}