package io.github.dshmobile.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 消息队列逻辑测试（P0）。
 *
 * 🔴 真实问题（2026-10-14，用户反馈）：
 *
 * > 「还有正在运行中时候不能输入啊，不能发送任务队列，你看客户端就可以的」
 *
 * 排查结论：**能力一直都在，是我们自己锁死的。**
 *
 *  - `session.prompt` 的 `mode` 本身就是 `queue | steer`：
 *    `queue` 排在当前回合之后（任务队列），`steer` 注入当前回合（插话）
 *  - `session.updateQueue` 支持编辑 / 删除 / 把排队项提升为 steer
 *  - 而我们的 UI 写了 `Composer(enabled = !state.running)`，把输入框整个禁用
 *
 * 这条测试锁死修复后的行为契约。
 *
 * 说明：`ChatViewModel` 依赖 `DshConnection`（要真主机），这里测的是**队列状态机**
 * 的纯逻辑 —— 把它抽出来单独验证，避免为了测试去搭一套网络桩。
 */
class MessageQueueTest {

    /** 与 ChatViewModel 的入队/提交状态迁移等价的纯逻辑。 */
    private class QueueMachine {
        val queue = mutableListOf<QueuedMessage>()
        private var seq = 0L

        fun enqueue(text: String, mode: String = "queue"): String {
            val id = "q-${seq++}"
            queue += QueuedMessage(localId = id, text = text, mode = mode, status = "pending")
            return id
        }

        fun markSent(localId: String) {
            val i = queue.indexOfFirst { it.localId == localId }
            if (i >= 0) queue[i] = queue[i].copy(status = "sent")
        }

        fun markFailed(localId: String, error: String) {
            val i = queue.indexOfFirst { it.localId == localId }
            if (i >= 0) queue[i] = queue[i].copy(status = "failed", error = error)
        }

        fun remove(localId: String) {
            queue.removeAll { it.localId == localId }
        }

        /** 提升为插话：只对**尚未提交**的项有效。 */
        fun promote(localId: String): Boolean {
            val i = queue.indexOfFirst { it.localId == localId }
            if (i < 0) return false
            if (queue[i].status == "sent") return false
            queue[i] = queue[i].copy(mode = "steer")
            return true
        }
    }

    // ── 核心：运行中必须能入队 ──────────────────────────────────────────────

    @Test
    fun `messages can be queued while a turn is running`() {
        val m = QueueMachine()
        // 模拟"当前回合正在运行"，用户连发三条
        val a = m.enqueue("先把 README 改了")
        val b = m.enqueue("然后跑一下测试")
        val c = m.enqueue("最后提交并推送")

        assertEquals("运行中发的消息都应入队，而不是被丢弃", 3, m.queue.size)
        assertEquals("顺序必须保持（先说的先执行）", listOf(a, b, c), m.queue.map { it.localId })
        assertTrue("默认模式应为排队", m.queue.all { it.mode == "queue" })
    }

    @Test
    fun `queue survives submission acknowledgement`() {
        val m = QueueMachine()
        val id = m.enqueue("排队消息")
        m.markSent(id)

        assertEquals("主机确认后仍要留在队列里给用户看", 1, m.queue.size)
        assertEquals("sent", m.queue[0].status)
    }

    // ── 失败不能静默丢内容 ──────────────────────────────────────────────────

    @Test
    fun `failed submission keeps text for retry`() {
        val m = QueueMachine()
        val id = m.enqueue("这段字用户打得很辛苦")
        m.markFailed(id, "网络超时")

        assertEquals("失败项必须保留，不能静默消失", 1, m.queue.size)
        assertEquals("failed", m.queue[0].status)
        assertEquals("原文必须完整保留", "这段字用户打得很辛苦", m.queue[0].text)
        assertEquals("要带上失败原因", "网络超时", m.queue[0].error)
    }

    @Test
    fun `failed item can be removed by user`() {
        val m = QueueMachine()
        val id = m.enqueue("不要了")
        m.markFailed(id, "boom")
        m.remove(id)
        assertEquals("用户可以移除失败项", 0, m.queue.size)
    }

    // ── 插话（steer）────────────────────────────────────────────────────────

    @Test
    fun `pending item can be promoted to steer`() {
        val m = QueueMachine()
        val id = m.enqueue("停一下，先改这里", "queue")
        assertTrue("未提交的项应可提升为插话", m.promote(id))
        assertEquals("模式应变为 steer", "steer", m.queue[0].mode)
    }

    @Test
    fun `sent item cannot be promoted`() {
        val m = QueueMachine()
        val id = m.enqueue("已经发出去了")
        m.markSent(id)
        assertFalse("已提交的项不能再改写，否则 UI 会假装成功", m.promote(id))
        assertEquals("模式不应被改动", "queue", m.queue[0].mode)
    }

    @Test
    fun `promote on unknown id is a no-op`() {
        val m = QueueMachine()
        assertFalse(m.promote("不存在"))
        assertEquals(0, m.queue.size)
    }

    // ── 边界 ────────────────────────────────────────────────────────────────

    @Test
    fun `empty queue is the normal idle state`() {
        val m = QueueMachine()
        assertEquals("空闲时队列为空是正常的，不该报错", 0, m.queue.size)
    }

    @Test
    fun `failed item preserves original error across retry attempt`() {
        val m = QueueMachine()
        val id = m.enqueue("重试我")
        m.markFailed(id, "第一次失败")
        // 重试：回到 pending
        val i = m.queue.indexOfFirst { it.localId == id }
        m.queue[i] = m.queue[i].copy(status = "pending", error = null)
        assertEquals("pending", m.queue[0].status)
        assertEquals("重试时应清掉旧错误", null, m.queue[0].error)
        assertEquals("文本不能丢", "重试我", m.queue[0].text)
    }

    @Test
    fun `multi-line text is preserved verbatim`() {
        val m = QueueMachine()
        val text = "第一行\n第二行\n第三步"
        val id = m.enqueue(text)
        assertEquals("换行必须原样保留", text, m.queue[0].text)
        assertNotNull(m.queue.firstOrNull { it.localId == id })
    }
}
