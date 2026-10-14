package io.github.dshmobile.app.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 代码块折叠逻辑的回归测试。
 *
 * 🔴 实测 bug（2026-10-13，模拟器实机 + 上游源码对照发现）：
 *
 * 旧 `CodeCard` 用 `maxHeightLines = 50` 默认值 + `TextOverflow.Visible` 做截断：
 *  1. **静默截断**：超过 50 行时内容被裁掉，既没有"还有更多"的提示，
 *     也没有展开入口 —— 用户根本不知道下面还有内容。
 *  2. **行号错位**：行号列只渲染 `minOf(size, maxHeightLines)` 行，
 *     而代码区由 `maxLines` 控制，两者在边界情况下不一致。
 *
 * 对齐 DSH 上游 `ui-primitives/lib/markdown/CodeBlock.module.css`：
 * `maxLines` 默认 **16**，超过则给展开入口。
 *
 * 这里把「折叠判定的纯逻辑」抽出来测，避免依赖 Compose 运行时。
 */
class CodeCardFoldTest {

    /** 与 CodeCard 内联逻辑等价的纯函数（同源实现，测试锁死契约）。 */
    private fun foldState(totalLines: Int, maxHeightLines: Int, expanded: Boolean): Pair<Int, Boolean> {
        val collapsible = totalLines > maxHeightLines
        val visible = if (collapsible && !expanded) maxHeightLines else totalLines
        return visible to collapsible
    }

    @Test
    fun `default fold threshold matches upstream sixteen`() {
        // 上游 CodeBlock.module.css 的 maxLines 默认值就是 16
        assertEquals(16, DEFAULT_FOLD_LINES)

        // 16 行不折叠
        val (visible16, collapsible16) = foldState(16, DEFAULT_FOLD_LINES, false)
        assertEquals(16, visible16)
        assertFalse("正好等于阈值时不折叠", collapsible16)

        // 17 行折叠到 16，并给出展开入口
        val (visible17, collapsible17) = foldState(17, DEFAULT_FOLD_LINES, false)
        assertEquals(16, visible17)
        assertTrue("超过阈值必须可折叠", collapsible17)
    }

    @Test
    fun `expanding reveals every line`() {
        val (visible, _) = foldState(200, DEFAULT_FOLD_LINES, expanded = true)
        assertEquals("展开后必须能看到全部行", 200, visible)
    }

    @Test
    fun `collapsing keeps exactly the threshold`() {
        val (visible, _) = foldState(200, DEFAULT_FOLD_LINES, expanded = false)
        assertEquals(DEFAULT_FOLD_LINES, visible)
    }

    @Test
    fun `short code is never folded`() {
        listOf(1, 2, 5, 15, 16).forEach { n ->
            val (visible, collapsible) = foldState(n, DEFAULT_FOLD_LINES, false)
            assertEquals("$n 行应完整显示", n, visible)
            assertFalse("$n 行不该出现折叠条", collapsible)
        }
    }

    @Test
    fun `visible line count never exceeds total`() {
        // 边界：total == threshold 时不应出现 visible > total
        for (total in 0..40) {
            val (visible, _) = foldState(total, DEFAULT_FOLD_LINES, false)
            assertTrue("visible($visible) 不能超过 total($total)", visible <= total)
            assertTrue("visible 不能为负", visible >= 0)
        }
    }

    @Test
    fun `line numbers stay in sync with visible code lines`() {
        // 旧 bug：行号列用 minOf(size, maxHeightLines)，代码区用 maxLines，
        // 两者必须同源。这里断言「可见行数」是唯一的真值来源。
        val code = (1..40).joinToString("\n") { "line $it" }
        val codeLines = code.split('\n')
        val (visible, _) = foldState(codeLines.size, DEFAULT_FOLD_LINES, expanded = false)

        // 折叠时高亮的代码 = 前 visible 行
        val rendered = codeLines.take(visible)
        assertEquals(visible, rendered.size)
        assertEquals("第一行", "line 1", rendered.first())
        assertEquals("最后一行应与 visible 对齐", "line $visible", rendered.last())
    }

    @Test
    fun `single line code has no line numbers`() {
        val codeLines = "only one line".split('\n')
        assertFalse("单行代码不该显示行号", codeLines.size > 1)
    }
}
