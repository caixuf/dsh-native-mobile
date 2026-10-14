package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 手写 JSON 解析器的测试。
 *
 * 它承载协议解码，一旦错了就是"帧解析不出来 → 审批静默丢失"，
 * 所以边界必须钉死：转义、Unicode、嵌套、以及**非法输入必须抛而不是返回半截**。
 */
class MiniJsonTest {

    @Test
    fun `parses flat object`() {
        val value = MiniJson.obj(MiniJson.parse("""{"type":"ready","clientId":"c-1"}"""))!!
        assertEquals("ready", MiniJson.str(value, "type"))
        assertEquals("c-1", MiniJson.str(value, "clientId"))
    }

    @Test
    fun `parses nested objects and arrays`() {
        val json = """{"a":{"b":[1,2,{"c":"d"}]},"e":true,"f":null,"g":1.5}"""
        val root = MiniJson.obj(MiniJson.parse(json))!!
        val list = MiniJson.arr(MiniJson.obj(root["a"])!!["b"])!!
        assertEquals(3, list.size)
        assertEquals(1.0, list[0])
        assertEquals("d", MiniJson.str(MiniJson.obj(list[2])!!, "c"))
        assertEquals(true, root["e"])
        assertNull(root["f"])
        assertEquals(1.5, root["g"])
    }

    @Test
    fun `parses empty containers`() {
        assertEquals(emptyMap<String, Any?>(), MiniJson.obj(MiniJson.parse("{}")))
        assertEquals(emptyList<Any?>(), MiniJson.arr(MiniJson.parse("[]")))
        // 网关对 open 帧的 payload 就是 {"args":{}}
        val frame = MiniJson.obj(MiniJson.parse("""{"payload":{"args":{}}}"""))!!
        assertEquals(emptyMap<String, Any?>(), MiniJson.obj(MiniJson.obj(frame["payload"])!!["args"]))
    }

    @Test
    fun `decodes escapes including unicode`() {
        val json = """{"msg":"line1\nline2\ttab\"quote\\slash\u4e2d\u6587"}"""
        val value = MiniJson.str(MiniJson.obj(MiniJson.parse(json))!!, "msg")!!
        assertEquals("line1\nline2\ttab\"quote\\slash中文", value)
    }

    @Test
    fun `keeps raw non-ascii characters`() {
        val value = MiniJson.str(MiniJson.obj(MiniJson.parse("""{"t":"工具调用需要批准"}"""))!!, "t")
        assertEquals("工具调用需要批准", value)
    }

    @Test
    fun `duplicate keys take the last value`() {
        val value = MiniJson.obj(MiniJson.parse("""{"a":"1","a":"2"}"""))!!
        assertEquals("2", value["a"])
    }

    @Test
    fun `rejects malformed input instead of returning half a result`() {
        val bad = listOf(
            """{"a":}""",
            """{"a":"unterminated}""",
            """{"a" 1}""",
            """[1,2""",
            """{"a":1}}""",
            """{'a':1}""",
            """{"a":tru}""",
            """""",
            """{"a":"\q"}""",
        )
        for (text in bad) {
            try {
                MiniJson.parse(text)
                fail("非法输入 '$text' 本该抛 JsonError（半截结果比崩溃更难查）")
            } catch (expected: MiniJson.JsonError) {
                assertTrue(expected.message!!.isNotBlank())
            }
        }
    }

    @Test
    fun `writers escapes are parseable back`() {
        val original = mapOf(
            "quote" to "he said \"hi\"",
            "newline" to "a\nb",
            "backslash" to "C:\\path\\to",
            "中文" to "值",
            "nested" to listOf(mapOf("k" to "v"), 1.0, true, null),
        )
        val roundTripped = MiniJson.obj(MiniJson.parse(MiniJson.write(original)))!!
        assertEquals(original["quote"], roundTripped["quote"])
        assertEquals(original["newline"], roundTripped["newline"])
        assertEquals(original["backslash"], roundTripped["backslash"])
        assertEquals("值", roundTripped["中文"])
        val nested = MiniJson.arr(roundTripped["nested"])!!
        assertEquals("v", MiniJson.str(MiniJson.obj(nested[0])!!, "k"))
        assertEquals(1.0, nested[1])
        assertEquals(true, nested[2])
        assertNull(nested[3])
    }

    @Test
    fun `writes whole numbers without a decimal point`() {
        // 主机对数字形态敏感；1.0 不该写成 "1.0" 之外的怪形状
        assertEquals("""{"n":1}""", MiniJson.write(mapOf("n" to 1.0)))
        assertEquals("""{"n":1.5}""", MiniJson.write(mapOf("n" to 1.5)))
    }

    @Test
    fun `helpers never throw on wrong shapes`() {
        assertNull(MiniJson.obj("not an object"))
        assertNull(MiniJson.arr("not an array"))
        assertNull(MiniJson.str(null, "k"))
        assertNull(MiniJson.str(mapOf("k" to 42), "k"))
        assertEquals("fallback", MiniJson.strOr(mapOf("k" to ""), "k", "fallback"))
        assertEquals("fallback", MiniJson.strOr(null, "k", "fallback"))
    }
}