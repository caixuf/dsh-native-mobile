package io.github.dshmobile.app.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 两端一致性契约（Kotlin 侧基线）。
 *
 * 🔴 Web 端 agent 无法执行 JVM，只能把本文件的判定逻辑转写成 JS 再比对。
 * 这里把**关键分支**固化成显式期望值，供两边对拍。
 *
 * 对拍方式：把每个 CASE 的输入喂给 Web 端 `src/lib/markdown.ts`，
 * 输出应与本测试的期望形态一致。
 */
class CrossPlatformParityTest {

    /** 期望的块类型序列（用简写，刻意不依赖完整 AST 结构）。 */
    private fun shape(src: String): List<String> = Markdown.parse(src).map { b ->
        when (b) {
            is MdNode.Paragraph -> "P"
            is MdNode.Heading -> "H${b.level}"
            is MdNode.CodeBlock -> "C(${b.language})"
            is MdNode.ListBlock -> "L(ordered=${b.ordered},n=${b.items.size},start=${b.startNumber})"
            is MdNode.Quote -> "Q"
            is MdNode.Divider -> "D"
            is MdNode.Table -> "T(h=${b.header.size},r=${b.rows.size})"
            is MdNode.Callout -> "A(${b.type})"
            is MdNode.Text -> "X"
            is MdNode.Image -> "IMG"
        }
    }

    @Test
    fun `parity 01 ordered list followed by task item`() {
        // 🔴 Web 端曾漏掉「任务项让列表转无序时先 flush」，
        // 导致 1 块 vs 2 块的差异。
        assertEquals(
            listOf("L(ordered=true,n=1,start=1)", "L(ordered=false,n=1,start=1)"),
            shape("1. 第一步\n- [x] 已完成"),
        )
    }

    @Test
    fun `parity 02 splitRow strips multiple pipes`() {
        // 🔴 Web 曾只剥一个竖线：`||a||b||` → 5 列；Kotlin trim('|') → 3 列
        val t = Markdown.parse("| a | b |\n|---|---|\n||x||y||").filterIsInstance<MdNode.Table>().first()
        assertEquals("表头应为 2 列", 2, t.header.size)
        assertEquals("数据行应为 2 列", 2, t.rows[0].size)
    }

    @Test
    fun `parity 03 streaming half table is still a table`() {
        assertEquals(listOf("T(h=2,r=0)"), shape("| A | B |\n| ---"))
    }

    @Test
    fun `parity 04 pipe without separator is not a table`() {
        assertEquals(listOf("P"), shape("路径 C:\\a|b\\c"))
    }

    @Test
    fun `parity 05 unclosed bold is plain text`() {
        val p = Markdown.parse("这里**加粗").filterIsInstance<MdNode.Paragraph>().single()
        assertTrue(
            "未闭合粗体不得产生 bold",
            p.children.filterIsInstance<MdNode.Text>().none { it.style.bold },
        )
        assertEquals("这里**加粗", p.children.joinToString("") { (it as MdNode.Text).value })
    }

    @Test
    fun `parity 06 unclosed fence is still a code block`() {
        assertEquals(listOf("C(ts)"), shape("```ts\nconst a = 1;"))
    }

    @Test
    fun `parity 07 all five callouts`() {
        val got = listOf("NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION")
            .map { kind -> shape("> [!$kind]\n> 内容").single() }
        assertEquals(
            listOf("A(Note)", "A(Tip)", "A(Important)", "A(Warning)", "A(Caution)"),
            got,
        )
    }

    @Test
    fun `parity 08 task item kinds`() {
        val items = Markdown.parse("- a\n- [x] b\n- c\n- [ ] d")
            .filterIsInstance<MdNode.ListBlock>().single().items
        assertEquals(4, items.size)
        assertTrue(items[0] is MdListItem.Item)
        assertTrue(items[1] is MdListItem.Task)
        assertTrue(items[2] is MdListItem.Item)
        assertTrue(items[3] is MdListItem.Task)
    }

    @Test
    fun `parity 09 indent clamping`() {
        val list = Markdown.parse("- a\n  - b\n    - c\n      - d").filterIsInstance<MdNode.ListBlock>().single()
        assertEquals(listOf(0, 1, 2, 3), list.indents)
    }

    @Test
    fun `parity 10 escaped pipe in cell`() {
        val t = Markdown.parse("| a | b |\n|---|---|\n| x \\| y | z |").filterIsInstance<MdNode.Table>().first()
        assertEquals("x | y", t.rows[0][0].joinToString("") { (it as MdNode.Text).value })
    }
}
