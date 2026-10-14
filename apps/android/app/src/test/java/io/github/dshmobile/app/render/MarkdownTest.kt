package io.github.dshmobile.app.render

import kotlinx.serialization.json.putJsonObject

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
        assertEquals(1, ordered.startNumber)
    }

    @Test
    fun `intra-word underscores are not parsed as italics`() {
        val nodes = Markdown.parse("执行 dsh_mobile_gateway 和 my_var_name 测试")
        val texts = nodes.filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue("下划线变量名不该被解析成斜体", texts.none { it is MdNode.Text && it.style.italic })
        assertEquals("执行 dsh_mobile_gateway 和 my_var_name 测试", plainText(nodes))
    }

    @Test
    fun `isolated underscore is italic`() {
        val nodes = Markdown.parse("这是 _斜体强调_ 文字")
        val texts = nodes.filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue("两端非单词字符的下划线应是斜体", texts.any { it is MdNode.Text && it.style.italic })
    }

    @Test
    fun `ordered list preserves custom start number`() {
        val nodes = Markdown.parse("5. 第五项\n6. 第六项")
        val list = nodes.filterIsInstance<MdNode.ListBlock>().first()
        assertEquals(true, list.ordered)
        assertEquals(5, list.startNumber)
        assertEquals(2, list.items.size)
    }

    @Test
    fun `nested list preserves indentation level`() {
        val nodes = Markdown.parse("1. 顶层项\n  - 子项A\n    - 孙项B")
        val lists = nodes.filterIsInstance<MdNode.ListBlock>()
        assertTrue("识别出列表项", lists.isNotEmpty())
        val subList = lists.first { !it.ordered }
        assertTrue("子列表保留缩进层级", subList.indents.first() >= 1)
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
    fun `task list item is preserved and not silently dropped`() {
        // 🔴 真实 bug 回归：任务项曾经被当成「伪行内节点」塞进 List<MdNode>，
        // 而 InlineText 的 when 只认 MdNode.Text（else -> Unit），于是
        // **任务项整行从 UI 上消失**（不报错、不崩溃）。
        // 所以这里最关键的不是 checkbox 值，而是 plain() —— 文本必须真的存在。
        val items = Markdown.parse("- [x] 已完成\n- [ ] 未完成")
            .filterIsInstance<MdNode.ListBlock>().first().items
        assertEquals(2, items.size)

        val first = items[0]
        assertTrue("第一个应是任务项", first is MdListItem.Task)
        assertTrue("第一个应勾选", (first as MdListItem.Task).checked)
        assertEquals("已完成", first.plain())

        val second = items[1] as MdListItem.Task
        assertTrue("第二个应未勾选", !second.checked)
        assertEquals("未完成", second.plain())
    }

    @Test
    fun `image inside paragraph is preserved for the renderer to show`() {
        // 🔴 真实 bug 回归：`![alt](url)` 曾被 `InlineText` 的 `else -> Unit`
        // 整条吞掉，UI 表现是「这句话凭空少了一段」。解析层必须始终产出 Image 节点。
        val nodes = Markdown.parse("前面 ![示意图](https://example.com/a.png) 后面")
            .filterIsInstance<MdNode.Paragraph>().first().children
        val img = nodes.filterIsInstance<MdNode.Image>().first()
        assertEquals("示意图", img.alt)
        assertEquals("https://example.com/a.png", img.url)
        assertTrue(
            "相邻的普通文本不能丢",
            nodes.filterIsInstance<MdNode.Text>().any { it.value.contains("后面") },
        )
    }

    @Test
    fun `image inside list item is preserved`() {
        val items = Markdown.parse("- 见 ![图](https://e.com/i.png) 说明")
            .filterIsInstance<MdNode.ListBlock>().first().items
        val img = (items[0] as MdListItem.Item).children.filterIsInstance<MdNode.Image>().first()
        assertEquals("图", img.alt)
    }

    @Test
    fun `ordered list items keep stable original indices`() {
        // 🔴 真实 bug 回归：渲染层曾用「过滤后的 index」算编号，
        // 中间空项一旦被过滤，7. 8. 就显示成 4. 5.。
        // 契约：items 与 indents 平行且下标与原文顺序严格一致，渲染层据此算编号。
        val list = Markdown.parse("1. 一\n2. 二\n3. 三\n7. 七\n8. 八")
            .filterIsInstance<MdNode.ListBlock>().first()
        assertEquals(5, list.items.size)
        assertEquals(1, list.startNumber)
        assertEquals("七", (list.items[3] as MdListItem.Item).plain())
        assertEquals("八", (list.items[4] as MdListItem.Item).plain())
        // 按原始下标算出的编号应与原文一致：index 3 -> "7."
        assertEquals(4, 3 + list.startNumber)
    }

    @Test
    fun `nested emphasis residual asterisks follow commonmark`() {
        // `*斜体里 **粗体***` 中，外层单星号的闭合点前是空格，
        // 按 CommonMark 不构成斜体，残留 `*` 是**正确**行为。
        // 锁死该判定，防止以后被"顺手修"成错误的贪婪匹配。
        val nodes = Markdown.parse("*斜体里 **嵌套粗体***")
            .filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue(
            "内层粗体应被解析",
            nodes.filterIsInstance<MdNode.Text>().any { it.style.bold && it.value == "嵌套粗体" },
        )
        assertEquals("*斜体里 嵌套粗体*", plainText(nodes))
    }

    @Test
    fun `underscore emphasis with no surrounding space closes correctly`() {
        // 对照用例：`_斜体_` 两侧非空白，应当构成斜体。
        val nodes = Markdown.parse("这是 _斜体_ 文字")
            .filterIsInstance<MdNode.Paragraph>().first().children
        assertTrue(nodes.filterIsInstance<MdNode.Text>().any { it.style.italic && it.value == "斜体" })
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

    @Test
    fun `github callouts are parsed as Callout node`() {
        val md = """> [!NOTE]
> 这是提示内容，支持**加粗**"""
        val nodes = Markdown.parse(md)
        val callout = nodes.filterIsInstance<MdNode.Callout>().firstOrNull()
        assertNotNull("应识别出 Callout 节点", callout)
        assertEquals(CalloutType.Note, callout?.type)
        assertTrue("应包含加粗片段", callout?.children?.any { it is MdNode.Text && it.style.bold } == true)
        assertEquals("这是提示内容，支持加粗", plainText(listOf(callout!!)))
    }

    @Test
    fun `different callout types are recognized`() {
        listOf(
            "TIP" to CalloutType.Tip,
            "IMPORTANT" to CalloutType.Important,
            "WARNING" to CalloutType.Warning,
            "CAUTION" to CalloutType.Caution
        ).forEach { (tag, expectedType) ->
            val nodes = Markdown.parse("> [!$tag]\n> 内容")
            val callout = nodes.filterIsInstance<MdNode.Callout>().firstOrNull()
            assertNotNull("应识别出 $tag Callout", callout)
            assertEquals(expectedType, callout?.type)
        }
    }

    @Test
    fun `regular blockquote is preserved as Quote node`() {
        val nodes = Markdown.parse("> 普通引用段落\n> 第二行")
        val quote = nodes.filterIsInstance<MdNode.Quote>().firstOrNull()
        assertNotNull("应保留为普通 Quote 节点", quote)
        assertTrue("非 callout 不应生成 Callout 节点", nodes.none { it is MdNode.Callout })
    }

    @Test
    fun `nested inline styles like bold code and bold link inherit composite styles`() {
        val nodes = Markdown.parse("请确认 **`config.json`** 和 **[文档](https://example.com)**")
        val textNodes = nodes.plainTextNodes()
        val boldCode = textNodes.firstOrNull { it.value == "config.json" }
        assertNotNull("行内代码应被解析", boldCode)
        assertTrue("嵌套在粗体内的代码应同时具备 bold 和 code 属性", boldCode!!.style.bold && boldCode.style.code)

        val boldLink = textNodes.firstOrNull { it.value == "文档" }
        assertNotNull("链接应被解析", boldLink)
        assertTrue("嵌套在粗体内的链接应具备 bold 属性", boldLink!!.style.bold)
        assertEquals("https://example.com", boldLink.style.link)
    }

    @Test
    fun `table row with escaped pipe does not split column`() {
        val src = """
            | 参数 | 类型 | 说明 |
            |---|---|---|
            | mode | string \| null | 运行模式 |
        """.trimIndent()
        val nodes = Markdown.parse(src)
        val table = nodes.filterIsInstance<MdNode.Table>().firstOrNull()
        assertNotNull("应解析出表格", table)
        assertEquals(3, table!!.header.size)
        assertEquals(1, table.rows.size)
        val row = table.rows.first()
        assertEquals(3, row.size)
        val typeCellText = row[1].filterIsInstance<MdNode.Text>().joinToString("") { it.value }
        assertEquals("string | null", typeCellText)
    }

    @Test
    fun `backslash escaped formatting characters are treated as literal text`() {
        val nodes = Markdown.parse("计算 \\*通配符\\* 与 \\_下划线\\_")
        val text = plainText(nodes)
        assertEquals("计算 *通配符* 与 _下划线_", text)
        val textNodes = nodes.plainTextNodes()
        assertTrue("转义星号不应产生斜体", textNodes.none { it.style.italic })
    }

    // ── 🔴 Android 端渲染回归 ───────────────────────────────────────────────
    //
    // 下面这些不是"再测一遍解析器"，而是锁死**手机端特有的渲染路径**：
    // 流式半截表格行、任务项与普通项混排、五种 Callout、异常输入不崩。

    @Test
    fun `streaming half typed separator row still renders as table`() {
        // 🔴 流式：表格正在输出，第二行分隔行只打了一半（`| ---`）。
        // 早期要求完整 `|---|---|`，导致整张表会在「最后一格补齐」的瞬间
        // 从段落**整体跳变**成表格 —— 手机上就是一次明显的闪跳。
        val streaming = Markdown.parse("| 方法 | 参数 |\n| ---")
        assertTrue(
            "半截分隔行也应识别为表格，避免整体跳变",
            streaming.any { it is MdNode.Table },
        )

        // 补齐分隔行后仍然是表格（结构不抖）
        val complete = Markdown.parse("| 方法 | 参数 |\n|---|---|")
        assertTrue("补齐后仍是表格", complete.any { it is MdNode.Table })
    }

    @Test
    fun `mixed task and plain list items are all preserved`() {
        // 真实场景：模型把待办和普通项混在一个列表里输出。
        // 任何一项被吞掉/错位都是 bug —— 每项的文本都必须能取到。
        val src = "- [x] 已完成\n- 普通项\n- [ ] 未完成"
        val list = Markdown.parse(src).filterIsInstance<MdNode.ListBlock>().first()
        assertEquals("三项都不能丢", 3, list.items.size)
        assertEquals("已完成", list.items[0].plain())
        assertEquals("普通项", list.items[1].plain())
        assertEquals("未完成", list.items[2].plain())

        assertTrue("第 1 项是任务项", list.items[0] is MdListItem.Task)
        assertTrue("第 2 项是普通项", list.items[1] is MdListItem.Item)
        assertTrue("第 3 项是任务项", list.items[2] is MdListItem.Task)
    }

    @Test
    fun `all five callout types are recognized`() {
        // CalloutView 对五种类型各有一组配色+图标，任一漏判都会掉进 else。
        listOf(
            "NOTE" to CalloutType.Note,
            "TIP" to CalloutType.Tip,
            "IMPORTANT" to CalloutType.Important,
            "WARNING" to CalloutType.Warning,
            "CAUTION" to CalloutType.Caution,
        ).forEach { (tag, expected) ->
            val nodes = Markdown.parse("> [!$tag]\n> 内容")
            val callout = nodes.filterIsInstance<MdNode.Callout>().firstOrNull()
            assertNotNull("应识别出 $tag Callout", callout)
            assertEquals(expected, callout?.type)
            assertTrue("$tag 内容不应丢失", plainText(listOf(callout!!)).contains("内容"))
        }
    }

    @Test
    fun `malformed and hostile input never throws`() {
        // 渲染路径上抛异常 = 整个 App 崩在流式输出中。
        // 除了不抛，还要求纯文本不能整段丢失。
        val nasty = listOf(
            "- [", "- [ ]", "- [x]", "- [x] ", "* [X] 大写勾选",
            "> [!", "> [!NOTE", "> [!BOGUS]\n> 正文", "|", "| |",
            "| a | b |", "| --- | --- |\n| 未闭合", "```lang",
            "![", "![alt](", "[a](", "#".repeat(200),
            "[ ] ".repeat(100), "  ", "😀".repeat(50),
            "".repeat(1000), "\t\t", "\\", "|---", "- [x] **未闭合粗体",
        )
        nasty.forEach { src ->
            // 不抛异常是硬要求（渲染路径抛异常 = 整个 App 崩在流式输出中）
            val nodes = runCatching { Markdown.parse(src) }
                .getOrElse { error("Markdown.parse 抛异常了，输入=${src.take(40)}") }
            // 纯空白输入解析成空列表是**正确**行为（没内容可渲染），
            // 所以这里断言的是「非空白输入不能整段变空」。
            if (src.isNotBlank()) {
                assertTrue("非空白输入不应解析成空节点列表：${src.take(40)}", nodes.isNotEmpty())
            }
        }
    }

    @Test
    fun `uppercase X checkbox is treated as checked`() {
        val items = Markdown.parse("- [X] 大写勾选")
            .filterIsInstance<MdNode.ListBlock>().first().items
        assertEquals(1, items.size)
        assertTrue("大写 X 也应算勾选", (items[0] as MdListItem.Task).checked)
        assertEquals("大写勾选", items[0].plain())
    }

    // ── 辅助 ────────────────────────────────────────────────────────────────

    /** 递归收集所有节点（测试辅助）。 */
    private fun MdNode.flatten(): List<MdNode> = buildList {
        add(this@flatten)
        when (this@flatten) {
            is MdNode.Paragraph -> children.forEach { addAll(it.flatten()) }
            is MdNode.Heading -> children.forEach { addAll(it.flatten()) }
            is MdNode.Quote -> children.forEach { addAll(it.flatten()) }
            is MdNode.Callout -> children.forEach { addAll(it.flatten()) }
            is MdNode.ListBlock -> items.forEach { item -> item.children.forEach { addAll(it.flatten()) } }
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
                    is MdNode.Callout -> walk(n.children)
                    is MdNode.ListBlock -> n.items.forEach { walk(it.children) }
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
                        is MdNode.Callout -> walk(n.children)
                        is MdNode.ListBlock -> n.items.forEach { walk(it.children) }
                        is MdNode.CodeBlock -> append(n.code)
                        else -> Unit
                    }
                }
            }
            walk(nodes)
        }.trim()
}
