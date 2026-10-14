package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 审批 / 提问应答的**协议契约**测试（原生侧）。
 *
 * ## 历史
 *
 * 这组断言最早是 `ApprovalContractTest.kt`（11 条），随 Kotlin 代码库被整体删除而消失；
 * 迁移到 Web 栈时又以 `scripts/test-approval-contract.mjs`（27 条）复活。
 * 现在平台侧重新有了原生代码（审批中继服务），所以**原生侧也必须有自己的护栏** ——
 * Web 端的测试管不到 Kotlin，Kotlin 端的测试也管不到 Web。
 *
 * ## 钉死的陷阱
 *
 * 主机审批词表只有四个裸字符串：`allowed-once | rejected | cancelled | unavailable`。
 * **词表外的值不报错，而是被静默归一化成 `unavailable`（= 拒绝）** ——
 * 现象是「用户在通知栏点了允许，工具却被拒绝」，日志干净、极难排查。
 */
class ApprovalContractTest {

    private val vocabulary = setOf("allowed-once", "rejected", "cancelled", "unavailable")

    // ── 审批 outcome ────────────────────────────────────────────────────────

    @Test
    fun `approve uses the bare string allowed-once`() {
        val value = ApprovalContract.approvalOutcome(allow = true)["value"]
        assertTrue("value 必须是裸字符串，实际是 ${value?.let { it::class.simpleName }}", value is String)
        assertEquals("allowed-once", value)
    }

    @Test
    fun `reject uses the bare string rejected`() {
        val value = ApprovalContract.approvalOutcome(allow = false)["value"]
        assertTrue("value 必须是裸字符串", value is String)
        assertEquals("rejected", value)
    }

    @Test
    fun `outcome values stay inside the host vocabulary`() {
        val produced = listOf(
            ApprovalContract.approvalOutcome(allow = true)["value"],
            ApprovalContract.approvalOutcome(allow = false)["value"],
        )
        for (v in produced) {
            assertTrue(
                "产出的值 '$v' 不在主机词表 $vocabulary 内 —— 它会被静默归一化成 unavailable（= 拒绝）",
                vocabulary.contains(v),
            )
        }
    }

    @Test
    fun `approve and reject produce different values`() {
        assertNotEquals(
            "允许与拒绝必须产出不同的值，否则按钮形同虚设",
            ApprovalContract.approvalOutcome(allow = true)["value"],
            ApprovalContract.approvalOutcome(allow = false)["value"],
        )
    }

    @Test
    fun `outcome carries the result kind`() {
        assertEquals("result", ApprovalContract.approvalOutcome(allow = true)["kind"])
        assertEquals("result", ApprovalContract.approvalOutcome(allow = false)["kind"])
    }

    @Test
    fun `approval value is not an object shaped like approved true`() {
        val value = ApprovalContract.approvalOutcome(allow = true)["value"]
        assertFalse(
            "value 不能是对象 —— 早期发 {approved:true} 导致被归一化成 unavailable",
            value is Map<*, *>,
        )
    }

    /**
     * 新栈的**主动防御**：词表外的值必须在本地就炸，而不是发出去被主机静默吞掉。
     *
     * 这条是 2026-10-14 新增的 —— 原版契约测试只能"断言产出的值恰好对"，
     * 不能阻止别人写出一个错误的值。现在写错会立刻抛。
     */
    @Test
    fun `off-vocabulary value throws instead of being silently normalized by the host`() {
        for (bad in listOf("allow", "approved", "ALLOWED-ONCE", "", "unavailable-ish")) {
            try {
                ApprovalContract.requireInVocabulary(bad)
                fail("'$bad' 不在词表内，本该抛异常（否则会被主机静默归一化成 unavailable = 拒绝）")
            } catch (expected: IllegalArgumentException) {
                assertTrue(expected.message!!.contains(bad))
            }
        }
    }

    @Test
    fun `every vocabulary word is accepted by the guard`() {
        for (word in vocabulary) {
            assertEquals(word, ApprovalContract.requireInVocabulary(word))
        }
    }

    // ── 提问 outcome ────────────────────────────────────────────────────────

    @Test
    fun `question answer uses id plus selected array`() {
        val value = ApprovalContract.questionOutcome("q-1", listOf("选项A"))["value"] as Map<*, *>
        val answers = value["answers"] as List<*>
        assertEquals(1, answers.size)
        val first = answers[0] as Map<*, *>
        assertEquals("id 必须是**问题** id，不是选项 id", "q-1", first["id"])
        assertEquals("selected 里放的是选项 label", listOf("选项A"), first["selected"])
    }

    @Test
    fun `question answer supports multiple selections in order`() {
        val value = ApprovalContract.questionOutcome("q-2", listOf("A", "B", "C"))["value"] as Map<*, *>
        val first = (value["answers"] as List<*>)[0] as Map<*, *>
        assertEquals(listOf("A", "B", "C"), first["selected"])
    }

    @Test
    fun `question answer with empty selection is still well formed`() {
        val value = ApprovalContract.questionOutcome("q-3", emptyList())["value"] as Map<*, *>
        val first = (value["answers"] as List<*>)[0] as Map<*, *>
        assertEquals(emptyList<String>(), first["selected"])
    }

    @Test
    fun `question kind is result`() {
        assertEquals("result", ApprovalContract.questionOutcome("q", listOf("x"))["kind"])
    }

    @Test
    fun `rejection shape has non-empty name`() {
        val rej = ApprovalContract.rejected("用户拒绝")
        assertEquals("rejected", rej["kind"])
        val error = rej["error"] as Map<*, *>
        assertEquals("name 必须非空，否则主机还原 Error 会失败", "Error", error["name"])
        assertEquals("用户拒绝", error["message"])
    }

    // ── 传输形状（原生端新增，Web 端测不到）──────────────────────────────────

    @Test
    fun `result envelope is a client-request to the slash endpoint`() {
        val json = ApprovalContract.resultEnvelope(
            rpcId = "r123",
            clientId = "c1",
            eventId = "ev-7",
            outcome = ApprovalContract.approvalOutcome(allow = true),
        )
        val body = MiniJson.obj(MiniJson.parse(json))!!
        assertEquals("client-request", body["type"])
        assertEquals("\$events/result", body["method"])
        assertEquals("r123", body["rpcId"])

        val args = MiniJson.obj(MiniJson.obj(body["payload"])!!["args"])!!
        assertEquals(setOf("clientId", "eventId", "outcome"), args.keys)
        assertEquals("c1", args["clientId"])
        assertEquals("ev-7", args["eventId"])
    }

    @Test
    fun `outcome survives JSON round-trip as a bare string`() {
        val json = ApprovalContract.resultEnvelope(
            "r1", "c1", "ev",
            ApprovalContract.approvalOutcome(allow = true),
        )
        val outcome = MiniJson.obj(
            MiniJson.obj(MiniJson.obj(MiniJson.obj(MiniJson.parse(json))!!["payload"])!!["args"])!!["outcome"]
        )!!
        val value = outcome["value"]
        assertTrue("序列化后 value 退化成非字符串 = 必然被归一化成 unavailable", value is String)
        assertTrue("序列化后的值必须仍在词表内", vocabulary.contains(value))
        assertEquals("kind/value 之外不应多出字段（例如早期的 approved:true）", setOf("kind", "value"), outcome.keys)
    }

    @Test
    fun `event stream open frame has exactly four keys`() {
        // 网关要求精确 4 键（type/streamId/endpoint/payload），多一个少一个都以 1008 关连接。
        val frame = MiniJson.obj(MiniJson.parse(ApprovalContract.openEventStream("s-1")))!!
        assertEquals(setOf("type", "streamId", "endpoint", "payload"), frame.keys)
        assertEquals("open", frame["type"])
        assertEquals("s-1", frame["streamId"])
        assertEquals("\$events", frame["endpoint"])
        assertEquals(emptyMap<String, Any?>(), MiniJson.obj(MiniJson.obj(frame["payload"])!!["args"]))
    }

    @Test
    fun `endpoints match the real host and the dead one stays dead`() {
        assertEquals("\$events/result", ApprovalContract.EVENT_RESULT_ENDPOINT)
        assertEquals("/mobile-gateway/remote.mux", ApprovalContract.MUX_PATH)
        // 真实主机**没有** /api/respond 这个端点（旧实现用它，一直是错的）
        assertFalse(ApprovalContract.EVENT_RESULT_ENDPOINT.contains("api/respond"))
    }
}