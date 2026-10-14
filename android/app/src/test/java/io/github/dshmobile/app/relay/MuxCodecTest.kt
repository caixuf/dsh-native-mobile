package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * mux 帧解码测试。
 *
 * 关键纪律：**坏帧绝不能抛异常**。一条解析不了的帧不该把整条审批通道打断 ——
 * 断连的代价是用户收不到审批，比"少处理一条 emit"严重得多。
 */
class MuxCodecTest {

    @Test
    fun `decodes item frame`() {
        val frame = MuxCodec.decode("""{"type":"item","streamId":"s1","value":{"type":"ready","clientId":"c9"}}""")
        assertTrue(frame is ServerFrame.Item)
        val value = (frame as ServerFrame.Item).value
        assertEquals("ready", MiniJson.str(value, "type"))
    }

    @Test
    fun `decodes end frame`() {
        val frame = MuxCodec.decode("""{"type":"end","streamId":"s1"}""")
        assertEquals("s1", (frame as ServerFrame.End).streamId)
    }

    @Test
    fun `decodes error frame with message`() {
        val frame = MuxCodec.decode("""{"type":"error","error":{"message":"上游不可达"}}""")
        assertEquals("上游不可达", (frame as ServerFrame.Failure).message)
    }

    @Test
    fun `error frame without message still has a fallback`() {
        val frame = MuxCodec.decode("""{"type":"error"}""")
        assertTrue((frame as ServerFrame.Failure).message.isNotBlank())
    }

    @Test
    fun `malformed frames become Invalid instead of throwing`() {
        val bad = listOf(
            "not json at all",
            """["array","not","object"]""",
            """{"streamId":"s1"}""",
            """{"type":"whatever"}""",
            """{"type":"item","value":"not an object"}""",
            """{"type":"item"}""",
        )
        for (text in bad) {
            val frame = MuxCodec.decode(text)
            assertTrue("'$text' 应当解成 Invalid，实际是 $frame", frame is ServerFrame.Invalid)
            assertTrue((frame as ServerFrame.Invalid).reason.isNotBlank())
        }
    }

    // ── 内层事件 ────────────────────────────────────────────────────────────

    @Test
    fun `ready event carries clientId`() {
        val event = MuxCodec.decodeEvent(mapOf("type" to "ready", "clientId" to "c-42"))
        assertEquals("c-42", (event as EventMessage.Ready).clientId)
    }

    @Test
    fun `ready without clientId is ignored not crash`() {
        // 没有 clientId 就没法应答；当成 Ignored，别抛也别断连。
        assertEquals(EventMessage.Ignored, MuxCodec.decodeEvent(mapOf("type" to "ready")))
        assertEquals(EventMessage.Ignored, MuxCodec.decodeEvent(mapOf("type" to "ready", "clientId" to "")))
    }

    @Test
    fun `waterfall event carries name, id and request`() {
        val value = mapOf(
            "type" to "waterfall",
            "event" to "tool/approval",
            "eventId" to "ev-7",
            "request" to mapOf("toolName" to "shell"),
        )
        val event = MuxCodec.decodeEvent(value) as EventMessage.Waterfall
        assertEquals("tool/approval", event.eventName)
        assertEquals("ev-7", event.eventId)
        assertEquals("shell", MiniJson.str(event.request, "toolName"))
    }

    @Test
    fun `waterfall without request falls back to the frame itself`() {
        // 主机不保证一定包 request；退化用整帧，至少别丢事件。
        val event = MuxCodec.decodeEvent(
            mapOf("type" to "waterfall", "event" to "tool/approval", "eventId" to "ev-8")
        ) as EventMessage.Waterfall
        assertEquals("ev-8", event.eventId)
        assertTrue(event.request.isNotEmpty())
    }

    @Test
    fun `waterfall with blank eventId is still surfaced so caller can decide`() {
        val event = MuxCodec.decodeEvent(mapOf("type" to "waterfall", "event" to "tool/approval")) as EventMessage.Waterfall
        assertEquals("", event.eventId)
        // 分类器会因此返回 null（不能应答的事件不弹通知）
    }

    @Test
    fun `cancel event carries eventId`() {
        val event = MuxCodec.decodeEvent(mapOf("type" to "cancel", "eventId" to "ev-9"))
        assertEquals("ev-9", (event as EventMessage.Cancelled).eventId)
    }

    @Test
    fun `emit event is recognised`() {
        val event = MuxCodec.decodeEvent(mapOf("type" to "emit", "event" to "assistant/message"))
        assertEquals("assistant/message", (event as EventMessage.Emit).eventName)
    }

    @Test
    fun `unknown event types are ignored for forward compatibility`() {
        // 主机将来加新 type，老客户端必须静默忽略而不是崩
        assertEquals(EventMessage.Ignored, MuxCodec.decodeEvent(mapOf("type" to "some-future-thing")))
        assertEquals(EventMessage.Ignored, MuxCodec.decodeEvent(emptyMap()))
    }
}