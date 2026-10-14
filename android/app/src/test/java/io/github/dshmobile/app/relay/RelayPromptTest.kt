package io.github.dshmobile.app.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 待作答项 → 通知内容的分类测试。
 *
 * 判据必须与 `src/App.tsx` 的 `handleHostRequest` 一致：手机通知上显示的标题/正文，
 * 与用户在电脑端、App 内看到的是同一件事。两端判据漂移会让用户不敢点。
 */
class RelayPromptTest {

    private fun approvalRequest(reason: String? = null, tool: String? = null) = buildMap<String, Any?> {
        if (reason != null) put("displayReason", reason)
        if (tool != null) put("toolName", tool)
    }

    @Test
    fun `approval event by name produces allow-reject prompt`() {
        val prompt = PromptClassifier.classify(
            eventName = "tool/approval",
            eventId = "ev-1",
            request = approvalRequest(reason = "将要执行 rm -rf build/"),
        )!!
        assertTrue(prompt.isApproval)
        assertTrue(prompt.needsAllowReject)
        assertEquals("工具调用需要批准", prompt.title)
        assertEquals("将要执行 rm -rf build/", prompt.body)
    }

    @Test
    fun `approval falls back from displayReason to reason to toolName`() {
        assertEquals(
            "fallback reason",
            PromptClassifier.classify("x/approval", "e", mapOf("reason" to "fallback reason"))!!.body,
        )
        val toolOnly = PromptClassifier.classify("x/approval", "e", mapOf("toolName" to "shell"))!!
        assertTrue("没有任何说明时至少要显示工具名", toolOnly.body.contains("shell"))
    }

    @Test
    fun `approval detection matches any event name containing approval`() {
        for (name in listOf("approval", "tool/approval", "tool/approval.request", "x/approvals")) {
            assertTrue(name, PromptClassifier.classify(name, "e", emptyMap())!!.isApproval)
        }
        for (name in listOf("question", "tool/question", "ask")) {
            assertFalse(name, PromptClassifier.classify(name, "e", emptyMap())!!.isApproval)
        }
    }

    @Test
    fun `question prompt takes header, question and option labels`() {
        val prompt = PromptClassifier.classify(
            eventName = "tool/question",
            eventId = "ev-2",
            request = mapOf(
                "questions" to listOf(
                    mapOf(
                        "id" to "q-1",
                        "header" to "选择部署环境",
                        "question" to "要部署到哪个环境？",
                        "options" to listOf(
                            mapOf("label" to "生产"),
                            mapOf("label" to "预发"),
                        ),
                    )
                )
            ),
        )!!
        assertFalse(prompt.isApproval)
        assertEquals("选择部署环境", prompt.title)
        assertEquals("要部署到哪个环境？", prompt.body)
        assertEquals(listOf("生产", "预发"), prompt.options)
        assertEquals("必须用**问题** id（不是选项 id）—— 用错会被静默当成拒绝", "q-1", prompt.questionId)
    }

    @Test
    fun `question without header falls back to the question text`() {
        val prompt = PromptClassifier.classify(
            "tool/question",
            "ev-3",
            mapOf("questions" to listOf(mapOf("id" to "q", "question" to "继续吗？"))),
        )!!
        assertEquals("继续吗？", prompt.title)
    }

    @Test
    fun `question with non-object options does not crash`() {
        val prompt = PromptClassifier.classify(
            "tool/question",
            "ev-4",
            mapOf("questions" to listOf(mapOf("id" to "q", "options" to listOf("裸字符串", "另一个")))),
        )!!
        assertEquals(emptyList<String>(), prompt.options)
    }

    @Test
    fun `missing eventId yields no prompt at all`() {
        // 没有 eventId 就无法应答；弹一个点了没用的通知比不弹更糟。
        assertNull(PromptClassifier.classify("tool/approval", "", emptyMap()))
        assertNull(PromptClassifier.classify("tool/approval", "   ", emptyMap()))
    }

    @Test
    fun `title and body are never blank`() {
        val prompt = PromptClassifier.classify("tool/question", "ev-5", emptyMap())!!
        assertTrue(prompt.title.isNotBlank())
        assertTrue(prompt.body.isNotBlank())
    }

    // ── 正文截断 ────────────────────────────────────────────────────────────

    @Test
    fun `long bodies are truncated with an ellipsis`() {
        val long = "x".repeat(1000)
        val prompt = PromptClassifier.classify("tool/approval", "ev-6", mapOf("displayReason" to long))!!
        assertEquals(PromptClassifier.MAX_BODY, prompt.notificationBody.length)
        assertTrue(prompt.notificationBody.endsWith("…"))
    }

    @Test
    fun `truncation collapses newlines and runs of whitespace`() {
        val text = "第一行\n\n\n第二行\t\t第三行"
        assertEquals("第一行 第二行 第三行", PromptClassifier.truncate(text))
    }

    @Test
    fun `short bodies are untouched`() {
        assertEquals("短正文", PromptClassifier.truncate("短正文"))
    }

    // ── 已应答账本（重启后不重复弹）─────────────────────────────────────────

    @Test
    fun `ledger reports first-time only once`() {
        val ledger = AnswerLedger()
        assertFalse(ledger.isAnswered("ev-1"))
        assertTrue("第一次记录应返回 true（据此弹通知）", ledger.markAnswered("ev-1"))
        assertTrue(ledger.isAnswered("ev-1"))
        assertFalse("重复记录必须返回 false —— 否则会重复弹已处理的审批", ledger.markAnswered("ev-1"))
    }

    @Test
    fun `ledger survives a restart via snapshot and restore`() {
        // 这正是"用户点过的审批重启后又冒出来"的根因：账本曾经只在内存里。
        val before = AnswerLedger()
        before.markAnswered("ev-a")
        before.markAnswered("ev-b")

        val afterRestart = AnswerLedger()
        afterRestart.restore(before.snapshot())

        assertTrue(afterRestart.isAnswered("ev-a"))
        assertTrue(afterRestart.isAnswered("ev-b"))
        assertFalse(afterRestart.markAnswered("ev-a"))
    }

    @Test
    fun `ledger evicts oldest entries beyond capacity`() {
        val ledger = AnswerLedger(capacity = 3)
        listOf("a", "b", "c").forEach { ledger.markAnswered(it) }
        ledger.markAnswered("d")
        assertEquals(3, ledger.size)
        assertFalse("最旧的条目应被淘汰，避免 SharedPreferences 无限增长", ledger.isAnswered("a"))
        assertTrue(ledger.isAnswered("d"))
    }

    @Test
    fun `forget removes an event so a cancelled request can prompt again`() {
        val ledger = AnswerLedger()
        ledger.markAnswered("ev-x")
        ledger.forget("ev-x")
        assertFalse(ledger.isAnswered("ev-x"))
    }

    @Test
    fun `restore also respects capacity`() {
        val ledger = AnswerLedger(capacity = 2)
        ledger.restore(listOf("1", "2", "3", "4"))
        assertEquals(2, ledger.size)
        assertTrue(ledger.isAnswered("4"))
    }

    @Test
    fun `prompt carries the method for tracing`() {
        val prompt = PromptClassifier.classify("tool/approval", "ev-7", emptyMap())
        assertNotNull(prompt)
        assertEquals("tool/approval", prompt!!.method)
        assertEquals("ev-7", prompt.eventId)
    }
}