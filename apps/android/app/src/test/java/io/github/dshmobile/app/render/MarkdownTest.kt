package io.github.dshmobile.app.render

import kotlinx.serialization.json.putJsonObject

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Markdown 解析器测试。
 *
 * 🔴 重点测**流式半截语法** —— 这是本项目特有的场景：
 * 模型输出一边来，UI 一边显示，所以解析器**必然**会收到半个语法。
 * 这类输入的处理原则是「宁可当普通文本，也不要渲染成错的」。
 */
class MarkdownTest {

    // ── 基础行内 ────────────────────────────────────────────────────────────

    @Test
    fun `bold is parsed`() {
        val nodes = Markdown.parse("这是**加粗**文字")
        val text = nodes.filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue("应有加粗片段", text.any { it is MdNode.Text && it.style.bold })
        assertEquals("这是加粗文字", plainText(nodes))
    }

    @Test
    fun `italic and strike`() {
        val nodes = Markdown.parse("*斜体* 和 ~~删除~~")
        val text = nodes.filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue(text.any { it is MdNode.Text && it.style.italic })
        assertTrue(text.any { it is MdNode.Text && it.style.strike })
    }

    @Test
    fun `inline code is not parsed as markdown`() {
        // 关键：代码里的 ** 不应该变成粗体
        val nodes = Markdown.parse("执行 `adb shell **x**` 结束")
        val text = nodes.filterIsInstance<MdNode.Paragraph>().first().children
        val codeSeg = text.filterIsInstance<MdNode.Text>().first { it.style.code }
        assertEquals("adb shell **x**", codeSeg.value)
        assertTrue("代码内的 ** 不该解析成粗体", text.none { it is MdNode.Text && it.style.bold })
    }

    @Test
    fun `link keeps text and url`() {
        val nodes = Markdown.parse("见 [文档](https://example.com/a) 说明")
        val link = nodes.filterIsInstance<MdNode.Paragraph>().first().children
            .filterIsInstance<MdNode.Text>().first { it.style.link != null }
        assertEquals("文档", link.value)
        assertEquals("https://example.com/a", link.style.link)
    }

    // ── 🔴 流式半截语法：宁可当普通文本 ──────────────────────────────────────

    @Test
    fun `unclosed bold stays plain text`() {
        val src = "这是**加粗"
        val nodes = Markdown.parse(src)
        val text = nodes.filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue("未闭合时不该产生粗体", text.none { it is MdNode.Text && it.style.bold })
        assertEquals("原文必须完整保留", src, plainText(nodes))
    }

    @Test
    fun `unclosed inline code stays plain text`() {
        val src = "执行 `ls -la"
        val nodes = Markdown.parse(src)
        assertEquals("原文必须完整保留", src, plainText(nodes))
        assertTrue(
            "未闭合时不该产生 code 样式",
            nodes.filterIsInstance<MdNode.Paragraph>().first().children
                .none { it is MdNode.Text && it.style.code },
        )
    }

    @Test
    fun `completing the syntax later makes it styled`() {
        // 流式的核心性质：文本补齐后，结果从「纯文本」变成「正确排版」，
        // 不会出现「先错后对」的闪烁。
        val partial = Markdown.parse("这是**加粗")
        val complete = Markdown.parse("这是**加粗**文字")
        assertTrue("半截时无样式", partial.plainTextNodes().none { it.style.bold })
        assertTrue("补齐后有样式", complete.plainTextNodes().any { it.style.bold })
    }

    @Test
    fun `lone asterisk is not italic`() {
        // `2 * 3 * 4` 不该被当成斜体
        val nodes = Markdown.parse("计算 2 * 3 * 4 的结果")
        assertEquals("计算 2 * 3 * 4 的结果", plainText(nodes))
    }

    // ── 块级 ────────────────────────────────────────────────────────────────

    @Test
    fun `fenced code block captures inner syntax verbatim`() {
        val src = """
            ```kotlin
            val x = **not bold**
            ```
        """.trimIndent()
        val blocks = Markdown.parse(src).filterIsInstance<MdNode.CodeBlock>()
        assertEquals(1, blocks.size)
        assertEquals("kotlin", blocks[0].language)
        assertTrue("代码内容原样保留", blocks[0].code.contains("**not bold**"))
    }

    @Test
    fun `unclosed fence still renders as code block`() {
        // 🔴 流式：代码块正在输出时还没有结束围栏，必须已经按代码块渲染，
        // 否则会出现"闪一下变成正文"的抖动。
        val blocks = Markdown.parse("```py\nprint(1)\n").filterIsInstance<MdNode.CodeBlock>()
        assertEquals("未闭合围栏也应渲染为代码块", 1, blocks.size)
        assertEquals("py", blocks[0].language)
    }

    @Test
    fun `unordered and ordered lists`() {
        val nodes = Markdown.parse("- 第一项\n- 第二项")
        val list = nodes.filterIsInstance<MdNode.ListBlock>().first()
        assertEquals(false, list.ordered)
        assertEquals(2, list.items.size)

        val ordered = Markdown.parse("1. 甲\n2. 乙").filterIsInstance<MdNode.ListBlock>().first()
        assertEquals(true, ordered.ordered)
    }

    @Test
    fun `quote strips marker`() {
        val nodes = Markdown.parse("> 这是引用")
        val quote = nodes.filterIsInstance<MdNode.Quote>().first()
        assertEquals("这是引用", plainText(quote.children))
    }

    @Test
    fun `heading levels are capped at three`() {
        val nodes = Markdown.parse("# H1\n### H3\n###### H6")
        val headings = nodes.filterIsInstance<MdNode.Heading>()
        assertEquals(listOf(1, 3, 3), headings.map { it.level })
    }

    // ── 健壮性 ──────────────────────────────────────────────────────────────

    @Test
    fun `never throws on odd input`() {
        val nasty = listOf(
            "", "   ", "\n\n\n", "***", "```", "```\n", "#", "# ",
            "[](", "[a](", "> ", "- ", "| a | b |", "\u0000",
            "a**b", "_", "`".repeat(50), "**".repeat(200),
        )
        nasty.forEach { Markdown.parse(it) } // 只要不抛异常即通过
    }

    @Test
    fun `plain text round trips without loss`() {
        val src = "第一行\n第二行\n第三行"
        assertEquals(src, plainText(Markdown.parse(src)))
    }

    // ── 角色判定回归（真实 bug，2026-10-13） ────────────────────────────────
    //
    // 🔴 实测踩到：`JsonRender.roleOf` 原来用**裸子串**匹配：
    //      "assistant" in r || "model" in r || "ai" in r  → "assistant"
    //      "tool" in r                                    → "tool"
    // 但 **"assistant" 本身就含 "ai"**，而 "detail"/"email"/"maintain" 也含 "ai"；
    // 更糟的是 `"tool" in "assistantToolResult"` 为真。于是正文被误判，
    // 最后落到 `else -> raw` 原样返回，角色彻底失配 ——
    // **UI 表现就是「`**粗体**` 仍显示星号」**，很容易被误判成渲染器坏了。
    //
    // 修复：先精确匹配、再前缀匹配、认不出来归 assistant。
    // 这里锁死回归，防止再被改回裸子串匹配。

    @Test
    fun `assistant is not mistaken for user or tool`() {
        assertEquals("assistant", role("assistant"))
        assertEquals("assistant", role("Assistant"))
        // 以下都含 "ai" 或 "tool" 子串，但都不是 user/tool
        assertEquals("assistant", role("detail"))
        assertEquals("assistant", role("email"))
        assertEquals("assistant", role("maintain"))
        assertEquals("assistant", role("assistantToolResult"))
    }

    @Test
    fun `user recognized without loose substring`() {
        assertEquals("user", role("user"))
        assertEquals("user", role("human"))
        assertEquals("user", role("prompt"))
        assertEquals("user", role("userInput"))
    }

    @Test
    fun `tool only when it really is tool`() {
        assertEquals("tool", role("tool"))
        assertEquals("tool", role("toolCall"))
        assertEquals("tool", role("tool_result"))
        assertEquals("tool", role("function"))
    }

    @Test
    fun `system recognized`() {
        assertEquals("system", role("system"))
        assertEquals("system", role("systemMessage"))
    }

    @Test
    fun `unknown role falls back to assistant not raw`() {
        // 🔴 认不出来的 role 必须归 assistant，**不能原样返回**。
        // 原样返回的后果：下游 `when(role)` 全不匹配 → 正文被当工具/未知，
        // 表现就是「`**粗体**` 不渲染」。这是本项目真实踩过的坑。
        assertEquals("assistant", role("weird-value"))
        assertEquals("assistant", role("some-future-provider-role"))
        // 混合大小写也要归一
        assertEquals("assistant", role("ASSISTANT"))
        assertEquals("user", role("USER"))
    }

    // ── 富文本扩展（表格 / 任务列表 / 分隔线 / 图片） ────────────────────────
    //
    // 🔴 这些不是"锦上添花"：DSH 的真实输出里表格非常常见
    // （方法/参数/必填/源码位置这类对照表），不渲染的话整段就是一串竖线。

    @Test
    fun `table is parsed with header rows and alignment`() {
        val src = """
            | 方法 | 参数 | 必填 |
            |:---|:---:|---:|
            | a | b | c |
            | d | e | f |
        """.trimIndent()
        val tables = Markdown.parse(src).filterIsInstance<MdNode.Table>()
        assertEquals("应识别出 1 个表格", 1, tables.size)
        val t = tables[0]
        assertEquals(3, t.header.size)
        assertEquals("数据行数", 2, t.rows.size)
        assertEquals(listOf(Align.Left, Align.Center, Align.Right), t.aligns)
    }

    @Test
    fun `pipe without separator row is not a table`() {
        // 正文里出现 `a|b` 不该被当表格 —— 必须要求第二行是分隔行
        val nodes = Markdown.parse("路径 C:\\a|b\\c 继续")
        assertTrue("无分隔行不应产生表格", nodes.none { it is MdNode.Table })
    }

    @Test
    fun `task list checkbox is parsed`() {
        val items = Markdown.parse("- [x] 已完成\n- [ ] 未完成")
            .filterIsInstance<MdNode.ListBlock>().first().items
        assertEquals(2, items.size)
        assertTrue("第一个应勾选", (items[0].first() as MdNode.TaskItem).checked)
        assertTrue("第二个应未勾选", !(items[1].first() as MdNode.TaskItem).checked)
    }

    @Test
    fun `divider is parsed`() {
        val nodes = Markdown.parse("上面\n\n---\n\n下面")
        assertTrue("应识别出分隔线", nodes.any { it is MdNode.Divider })
    }

    @Test
    fun `divider not confused with list item`() {
        // `- - -` 三段横杠是分隔线，不是三个列表项
        val nodes = Markdown.parse("- - -")
        assertTrue(nodes.any { it is MdNode.Divider })
    }

    @Test
    fun `image becomes placeholder node with alt and url`() {
        val nodes = Markdown.parse("![示意图](https://example.com/a.png)")
        val img = nodes.flatMap { it.flatten() }.filterIsInstance<MdNode.Image>().first()
        assertEquals("示意图", img.alt)
        assertEquals("https://example.com/a.png", img.url)
    }

    // ── 辅助 ────────────────────────────────────────────────────────────────

    /** 递归收集所有节点（测试辅助）。 */
    private fun MdNode.flatten(): List<MdNode> = buildList {
        add(this@flatten)
        when (this@flatten) {
            is MdNode.Paragraph -> children.forEach { addAll(it.flatten()) }
            is MdNode.Heading -> children.forEach { addAll(it.flatten()) }
            is MdNode.Quote -> children.forEach { addAll(it.flatten()) }
            is MdNode.ListBlock -> items.forEach { list -> list.forEach { addAll(it.flatten()) } }
            is MdNode.TaskItem -> children.forEach { addAll(it.flatten()) }
            is MdNode.Table -> {
                header.forEach { cell -> cell.forEach { addAll(it.flatten()) } }
                rows.forEach { row -> row.forEach { cell -> cell.forEach { addAll(it.flatten()) } } }
            }
            else -> Unit
        }
    }

    /** 直接调被测的 role 归一逻辑（它是 companion 上的 internal 函数，包内可见）。 */
    private fun role(raw: String): String = JsonRender.roleOf(
        kotlinx.serialization.json.buildJsonObject {
            putJsonObject("data") {
                put("role", kotlinx.serialization.json.JsonPrimitive(raw))
            }
        },
    )

    private fun List<MdNode>.plainTextNodes(): List<MdNode.Text> = buildList {
        fun walk(nodes: List<MdNode>) {
            nodes.forEach { n ->
                when (n) {
                    is MdNode.Text -> add(n)
                    is MdNode.Paragraph -> walk(n.children)
                    is MdNode.Heading -> walk(n.children)
                    is MdNode.Quote -> walk(n.children)
                    is MdNode.ListBlock -> n.items.forEach { walk(it) }
                    is MdNode.CodeBlock -> Unit
                    // else 兜底：新增 MdNode 类型时测试辅助函数不必跟着改
                    else -> Unit
                }
            }
        }
        walk(this@plainTextNodes)
    }

    /** 提取纯文本，忽略样式。 */
    private fun plainText(nodes: List<MdNode>): String =
        buildString {
            fun walk(list: List<MdNode>) {
                list.forEach { n ->
                    when (n) {
                        is MdNode.Text -> append(n.value)
                        is MdNode.Paragraph -> { append('\n'); walk(n.children); append('\n') }
                        is MdNode.Heading -> walk(n.children)
                        is MdNode.Quote -> walk(n.children)
                        is MdNode.ListBlock -> n.items.forEach { walk(it) }
                        is MdNode.CodeBlock -> append(n.code)
                        else -> Unit
                    }
                }
            }
            walk(nodes)
        }.trim()
}
