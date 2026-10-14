package io.github.dshmobile.app.notify

import io.github.dshmobile.app.net.Envelopes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 审批 / 提问应答的**协议契约**测试。
 *
 * ## 为什么这个文件必须存在（2026-10-14）
 *
 * 锁屏审批是本 App 最关键的交互：用户在锁屏上点「允许一次」，
 * 应答经 `$events/result` 发回主机。这条链路上有一个**静默失败**陷阱：
 *
 * > 主机的 `ApprovalOutcome` 词表只有**四个裸字符串**：
 * > `allowed-once | rejected | cancelled | unavailable`。
 * > **词表外的值不报错、不崩、日志干净 —— 而是被静默归一化成 `unavailable`。**
 *
 * 而 `unavailable` 的语义是「没有审批通道」，落到工具层就是**拒绝**。
 * 所以一旦把值写错（比如发 `{approved:true}` 对象、或写成 `"allow"`），
 * 现象是「**用户点了允许，工具却被拒绝**」——没有任何报错，极难排查。
 *
 * 真机验证时 USB 恰好断开（无法端到端实测），因此这里用测试把这个契约钉死：
 * 任何改动只要让值偏离词表，测试立刻变红，而不是等到用户线上被静默拒绝。
 */
class ApprovalContractTest {

    // ── 审批 outcome ────────────────────────────────────────────────────────

    @Test
    fun `approve uses the bare string allowed-once`() {
        val outcome = Envelopes.approvalOutcome(allow = true)
        val value = outcome["value"]

        // 必须是**裸字符串**，不能是对象 —— 发对象会被归一化成 unavailable
        assertTrue(
            "value 必须是 JsonPrimitive（裸字符串），实际是 ${value?.let { it::class.simpleName }}",
            value is JsonPrimitive,
        )
        assertEquals("allowed-once", value?.jsonPrimitive?.content)
    }

    @Test
    fun `reject uses the bare string rejected`() {
        val outcome = Envelopes.approvalOutcome(allow = false)
        val value = outcome["value"]
        assertTrue("value 必须是裸字符串", value is JsonPrimitive)
        assertEquals("rejected", value?.jsonPrimitive?.content)
    }

    @Test
    fun `outcome values stay inside the host vocabulary`() {
        // 主机词表（逐字，来自 dsh-user-approval 的 OUTCOMES）
        val vocabulary = setOf("allowed-once", "rejected", "cancelled", "unavailable")

        val produced = listOf(
            Envelopes.approvalOutcome(allow = true),
            Envelopes.approvalOutcome(allow = false),
        ).map { it["value"]?.jsonPrimitive?.content }

        for (v in produced) {
            assertTrue(
                "产出的值 '$v' 不在主机词表 $vocabulary 内 —— 它会被静默归一化成 unavailable（= 拒绝）",
                v in vocabulary,
            )
        }
    }

    @Test
    fun `approve and reject produce different values`() {
        val a = Envelopes.approvalOutcome(allow = true)["value"]?.jsonPrimitive?.content
        val r = Envelopes.approvalOutcome(allow = false)["value"]?.jsonPrimitive?.content
        assertNotEquals("允许与拒绝必须产出不同的值，否则按钮形同虚设", a, r)
    }

    @Test
    fun `outcome carries the result kind`() {
        // `kind` 必须是 "result" —— 主机按它区分"这是应答"还是"这是拒绝"
        assertEquals("result", Envelopes.approvalOutcome(allow = true)["kind"]?.jsonPrimitive?.content)
        assertEquals("result", Envelopes.approvalOutcome(allow = false)["kind"]?.jsonPrimitive?.content)
    }

    // ── 提问 outcome ────────────────────────────────────────────────────────

    @Test
    fun `question answer uses id plus selected array`() {
        val outcome = Envelopes.questionOutcome("q-1", listOf("选项A"))
        val value = outcome["value"]?.jsonObject ?: error("value 必须是对象")

        val answers = value["answers"] as? JsonArray ?: error("必须有 answers 数组")
        assertEquals(1, answers.size)

        val first = answers[0].jsonObject
        assertEquals("id 必须是**问题** id，不是选项 id", "q-1", first["id"]?.jsonPrimitive?.content)

        val selected = first["selected"] as? JsonArray ?: error("必须有 selected 数组")
        assertEquals(1, selected.size)
        assertEquals("selected 里放的是选项 label", "选项A", selected[0].jsonPrimitive.content)
    }

    @Test
    fun `question answer supports multiple selections`() {
        val outcome = Envelopes.questionOutcome("q-2", listOf("A", "B", "C"))
        val answers = outcome["value"]!!.jsonObject["answers"] as JsonArray
        val selected = answers[0].jsonObject["selected"] as JsonArray
        assertEquals("多选必须全部保序写入", listOf("A", "B", "C"), selected.map { it.jsonPrimitive.content })
    }

    @Test
    fun `question answer with empty selection is still well formed`() {
        // 用户可能一个都不选就提交 —— 形状仍必须合法，不能崩也不能变形
        val outcome = Envelopes.questionOutcome("q-3", emptyList())
        val answers = outcome["value"]!!.jsonObject["answers"] as JsonArray
        val selected = answers[0].jsonObject["selected"] as JsonArray
        assertEquals(0, selected.size)
    }

    @Test
    fun `question kind is result not rejected`() {
        assertEquals("result", Envelopes.questionOutcome("q", listOf("x"))["kind"]?.jsonPrimitive?.content)
    }

    // ── 容易被误用的形状 ────────────────────────────────────────────────────

    @Test
    fun `approval value is not an object shaped like approved true`() {
        // 历史 bug：曾发 `{approved:true}`。这里显式钉死"不许回到那个形状"。
        val value = Envelopes.approvalOutcome(allow = true)["value"]
        assertTrue(
            "value 不能是对象 —— 早期发 {approved:true} 导致被归一化成 unavailable",
            value !is JsonObject,
        )
    }

    @Test
    fun `rejection shape has non-empty name`() {
        // rejected() 用于 waterfall 拒绝：{name, message}，name 必须非空
        val rej = Envelopes.rejected("用户拒绝")
        assertEquals("rejected", rej["kind"]?.jsonPrimitive?.content)
        val err = rej["error"]?.jsonObject ?: error("必须有 error 对象")
        val name = err["name"]?.jsonPrimitive?.content
        assertTrue("name 必须非空，否则主机还原 Error 会失败", !name.isNullOrBlank())
        assertEquals("Error", name)
        assertEquals("用户拒绝", err["message"]?.jsonPrimitive?.content)
    }
}
