package io.github.dshmobile.app.render

/**
 * 极简 Markdown 解析器。
 *
 * ## 为什么自己写，不引第三方库
 *
 * 我们的场景很特殊，是**流式增量渲染**：
 *  - 模型输出一边来，UI 一边显示，每次只多几个 token；
 *  - 文本中途经常只有半个语法（比如 `**加粗` 还没闭合），必须**不渲染成错的**；
 *  - APK 体积敏感（本项目无 native 代码，release 13.9 MB）。
 *
 * 引 `compose-markdown` 之类会带来：体积 + 一个 JVM/Android 兼容风险 +
 * 我们仍要自己处理「半个语法」的降级。那不如写一个**行为完全可控**的。
 *
 * ## 支持的语法（够用且可控）
 *
 * | 语法 | 处理 |
 * |---|---|
 * | ` ```lang ` 围栏 | 代码块，等宽字体 + 底色，不解析内部 |
 * | `**粗体**` / `__粗体__` | 粗体 |
 * | `*斜体*` / `_斜体_` | 斜体 |
 * | `` `行内代码` `` | 等宽 + 浅底 |
 * | `~~删除线~~` | 删除线 |
 * | `- ` / `* ` / `1. ` | 无序/有序列表 |
 * | `> 引用` | 引用块（左边线） |
 * | `# 标题` | 标题（只到 h3，再深就当正文） |
 * | `[文字](链接)` | 链接（可点击） |
 *
 * ## 🔴 流式的核心规则：未闭合的一律按纯文本
 *
 * 流式输出时半截语法极常见。渲染成「加粗到一半突然结束」比不渲染更糟 ——
 * 用户看到的是闪烁的、错的排版。所以这里的原则是：
 *
 *   **找不到闭合标记，就当普通字符显示。**
 *
 * 这样随着 token 补齐，渲染结果只会「从普通文本变成正确排版」，
 * 不会出现「先错后对」的闪烁。
 */
sealed interface MdNode {
    /** 普通文本 */
    data class Text(val value: String, val style: MdStyle = MdStyle()) : MdNode

    /** 段落（连续文本的容器） */
    data class Paragraph(val children: List<MdNode>) : MdNode

    /** 代码块 */
    data class CodeBlock(val language: String?, val code: String) : MdNode

    /**
     * 列表项序列。
     *
     * 🔴 每个元素是 `MdListItem` 而不是 `List<MdNode>`，因为**列表项有两种形态**：
     * 普通文本项与任务项（`- [x]`）。早期把任务项当成「伪行内节点」塞进
     * `List<MdNode>`，而 `InlineText` 的 `when` 只认 `MdNode.Text`
     * （`else -> Unit`），于是 **列表里的任务项整行静默消失**，
     * 不报错、不崩溃 —— 用户只看到「- [x] 写完文档」凭空不见了。
     */
    data class ListBlock(
        val ordered: Boolean,
        val items: List<MdListItem>,
        val startNumber: Int = 1,
        val indents: List<Int> = emptyList(),
    ) : MdNode

    /** 引用块 */
    data class Quote(val children: List<MdNode>) : MdNode

    /** 标题 */
    data class Heading(val level: Int, val children: List<MdNode>) : MdNode

    /**
     * 表格。
     *
     * 🔴 DSH 的真实输出里表格很常见（对比测试结果、列配置、执行计划）。
     * 手机上必须能渲染成**可横向滚动的网格**，而不是一堆竖线字符。
     */
    data class Table(
        val header: List<List<MdNode>>,
        /** 第二行是分隔行 `|---|---|`，不作为数据 */
        val rows: List<List<List<MdNode>>>,
        val aligns: List<Align>,
    ) : MdNode

    /** 分隔线 `---` / `***` / `___` */
    data object Divider : MdNode

    /**
     * 图片 `![alt](url)`。
     *
     * 保留节点但**默认不加载远程图**（安全 + 省流量）：
     * 由上层决定是否显示占位。本项目只渲染远程资源链接，
     * 避免在聊天流里引入不可控的网络请求。
     */
    data class Image(val alt: String, val url: String) : MdNode

    /** GitHub 风格 Callout 引述警告块（> [!NOTE] / > [!TIP] / > [!WARNING]） */
    data class Callout(
        val type: CalloutType,
        val customTitle: String? = null,
        val children: List<MdNode>,
    ) : MdNode
}

/**
 * 列表项：普通项 or 任务项。
 *
 * 🔴 为什么不用 `List<MdNode>`：列表项有两种形态，而 `InlineText` 的 `when` 只认
 * `MdNode.Text`（`else -> Unit`）。早期把任务项当成「伪行内节点」塞进 `List<MdNode>`，
 * 结果**列表里的任务项整行静默消失** —— 不报错、不崩溃，用户只看到
 * 「- [x] 写完文档」凭空不见了。
 *
 * 用密封类而非 `data class` + `kind` 字段，让编译器强制所有 `when` 都覆盖两种形态。
 */
sealed interface MdListItem {
    val children: List<MdNode>

    data class Item(override val children: List<MdNode>) : MdListItem

    data class Task(
        val checked: Boolean,
        override val children: List<MdNode>,
    ) : MdListItem

    /** 取纯文本（过滤空项用）。 */
    fun plain(): String = buildString { appendChildren(children, this) }
}

/** 递归把节点里的字面文本拼进 [sink]（列表项 / Callout / 表格列宽共用）。 */
internal fun appendChildren(nodes: List<MdNode>, sink: StringBuilder) {
    nodes.forEach { node ->
        when (node) {
            is MdNode.Text -> sink.append(node.value)
            is MdNode.Paragraph -> appendChildren(node.children, sink)
            is MdNode.Heading -> appendChildren(node.children, sink)
            is MdNode.Quote -> appendChildren(node.children, sink)
            is MdNode.Callout -> appendChildren(node.children, sink)
            is MdNode.CodeBlock -> sink.append(node.code)
            is MdNode.Image -> sink.append(node.alt)
            else -> Unit
        }
    }
}

/** 行内样式（可叠加）。 */
data class MdStyle(
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val strike: Boolean = false,
    val link: String? = null,
) {
    fun isPlain(): Boolean =
        !bold && !italic && !code && !strike && link == null
}

/** 表格列对齐。 */
enum class Align { Left, Center, Right }

/** GitHub / 现代富文本警告块类型。 */
enum class CalloutType(val defaultTitle: String, val keyword: String) {
    Note("说明", "NOTE"),
    Tip("提示", "TIP"),
    Important("重要", "IMPORTANT"),
    Warning("警告", "WARNING"),
    Caution("危险", "CAUTION");

    companion object {
        fun from(tag: String): CalloutType? {
            val upper = tag.uppercase().trim()
            return entries.firstOrNull { it.keyword == upper }
        }
    }
}

object Markdown {

    /**
     * 解析。永不抛异常 —— 渲染路径上抛异常等于整个 App 崩在流式输出中，
     * 这是不可接受的降级。
     */
    fun parse(source: String): List<MdNode> = runCatching { parseUnsafe(source) }
        .getOrElse { listOf(MdNode.Text(source)) }

    private fun parseUnsafe(src: String): List<MdNode> {
        val lines = src.split('\n')
        val out = mutableListOf<MdNode>()
        val para = mutableListOf<MdNode>()
        var listOrdered = false
        var listStartNumber = 1
        val listItems = mutableListOf<MdListItem>()
        val listIndents = mutableListOf<Int>()
        val quoteRawLines = mutableListOf<String>()

        fun flushPara() {
            if (para.isNotEmpty()) {
                out += MdNode.Paragraph(para.toList())
                para.clear()
            }
        }

        fun flushList() {
            if (listItems.isNotEmpty()) {
                out += MdNode.ListBlock(listOrdered, listItems.toList(), listStartNumber, listIndents.toList())
                listItems.clear()
                listIndents.clear()
                listStartNumber = 1
            }
        }

        fun flushQuote() {
            if (quoteRawLines.isNotEmpty()) {
                val first = quoteRawLines.first().trim()
                val calloutMatch = Regex("""^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$""", RegexOption.IGNORE_CASE).find(first)
                if (calloutMatch != null) {
                    val type = CalloutType.from(calloutMatch.groupValues[1]) ?: CalloutType.Note
                    val titleSuffix = calloutMatch.groupValues[2].trim().takeIf { it.isNotBlank() }
                    val bodyLines = quoteRawLines.drop(1)
                    val bodyNodes = mutableListOf<MdNode>()
                    if (bodyLines.isEmpty() && titleSuffix != null) {
                        bodyNodes += inline(titleSuffix)
                    } else {
                        bodyLines.forEachIndexed { idx, bl ->
                            if (idx > 0) bodyNodes += MdNode.Text("\n")
                            bodyNodes += inline(bl)
                        }
                    }
                    out += MdNode.Callout(type, titleSuffix, bodyNodes)
                } else {
                    val nodes = mutableListOf<MdNode>()
                    quoteRawLines.forEachIndexed { idx, ql ->
                        if (idx > 0) nodes += MdNode.Text("\n")
                        nodes += inline(ql)
                    }
                    out += MdNode.Quote(nodes)
                }
                quoteRawLines.clear()
            }
        }

        fun flushAll() {
            flushPara(); flushList(); flushQuote()
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]

            // ── 代码块围栏 ──
            val fence = line.trimStart()
            if (fence.startsWith("```")) {
                flushAll()
                val lang = fence.removePrefix("```").trim().takeIf { it.isNotEmpty() }
                val buf = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    if (buf.isNotEmpty()) buf.append('\n')
                    buf.append(lines[i])
                    i++
                }
                i++ // 跳过结束围栏（没有也无所谓，流式时常见）
                out += MdNode.CodeBlock(lang, buf.toString())
                continue
            }

            // ── 空行 ──
            if (line.isBlank()) {
                flushAll()
                i++
                continue
            }

            // ── 标题 ──
            val heading = Regex("^(#{1,6})\\s+(.*)$").find(line)
            if (heading != null) {
                flushAll()
                val level = heading.groupValues[1].length
                out += MdNode.Heading(level.coerceAtMost(3), inline(heading.groupValues[2]))
                i++
                continue
            }

            // ── 分隔线 `---` / `***` / `___` ──
            // 必须先于列表判断，否则 `- - -` 会被当成列表项。
            //
            // ⚠️ 正则里**不能写 `$`**：Kotlin 字符串里 `\$` 是转义的美元符号，
            // 不是正则的"行尾锚点"。锚点要用 `\$` 转义的正则形式时，
            // 整个 pattern 要放在**raw string**（`"""..."""`）里，
            // 否则 `Regex("...\$")` 匹配的是字面 $ 字符（踩过这个坑）。
            val dividerRe = Regex("""^\s*([-*_])\s*(?:\1\s*){2,}$""")
            if (dividerRe.matches(line)) {
                flushAll()
                out += MdNode.Divider
                i++
                continue
            }

            // ── 表格：`|a|b|` + 下一行必须是 `|---|---|` ──
            // 要求"下一行是分隔行"是必须的，否则正文里出现的竖线会被误判成表格。
            // ⚠️ 正则用 raw string：普通字符串里的 `\$` 是「转义的美元符号」，
            // 不是正则锚点（同一个坑，踩第二次）。
            //
            // 🔴 流式妥协：分隔行还没打完时（`| ---`）也放行，让表格从第一帧起
            // 就是表格。否则整张表会在「最后一格补齐」的瞬间从段落**整体跳变**
            // 成表格 —— 手机上就是一次明显的闪跳。
            val tableSepRe = Regex("""^\|?[\s:|-]+\|[\s:|-]*$""")
            val tableSepPrefixRe = Regex("""^\|?\s*:?-{1,}""")
            if (line.contains('|') && i + 1 < lines.size) {
                val sep = lines[i + 1].trim()
                val isSep = tableSepRe.matches(sep) || tableSepPrefixRe.matches(sep)
                if (!isSep) {
                    // 不是表格 → 落回普通正文处理
                } else {
                    flushAll()
                    val header = splitRow(line)
                    val aligns = parseAligns(sep)
                    i += 2
                    val rows = mutableListOf<List<List<MdNode>>>()
                    while (i < lines.size) {
                        val r = lines[i]
                        if (!r.contains('|') || r.isBlank()) break
                        val cells = splitRow(r)
                        // 列数不一致时按表头补齐/截断，避免渲染错位
                        val padded = (cells + List(header.size - cells.size.coerceAtMost(header.size)) { "" })
                            .take(header.size)
                        rows += padded.map { inline(it) }
                        i++
                    }
                    out += MdNode.Table(header.map { inline(it) }, rows, aligns)
                    continue
                }
            }

            // ── 引用 ──
            val quote = Regex("^\\s*>\\s?(.*)$").find(line)
            if (quote != null) {
                flushPara(); flushList()
                quoteRawLines += quote.groupValues[1]
                i++
                continue
            }

            // ── 列表（含任务列表）──
            val unordered = Regex("^(\\s*)[-*+]\\s+(.*)$").find(line)
            val ordered = Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$").find(line)
            if (unordered != null || ordered != null) {
                flushPara(); flushQuote()
                val isOrdered = ordered != null
                val indentSpaces = if (isOrdered) ordered!!.groupValues[1].length else unordered!!.groupValues[1].length
                val indentLevel = (indentSpaces / 2).coerceAtMost(3)
                val body = if (isOrdered) ordered!!.groupValues[3] else unordered!!.groupValues[2]
                val itemNum = if (isOrdered) ordered!!.groupValues[2].toIntOrNull() ?: 1 else 1

                // 任务列表：`- [ ]` / `- [x]`
                val task = Regex("^\\[([ xX])\\]\\s+(.*)$").find(body)
                if (task != null) {
                    val isChecked = task.groupValues[1].lowercase() == "x"
                    // 任务项让当前列表变成无序（不再画 1. / • 标记，勾选框自带）
                    if (listItems.isNotEmpty() && listOrdered) flushList()
                    listOrdered = false
                    listItems += MdListItem.Task(
                        checked = isChecked,
                        children = inline(task.groupValues[2]),
                    )
                    listIndents += indentLevel
                    i++
                    continue
                }

                if (listItems.isNotEmpty() && listOrdered != isOrdered) flushList()
                if (listItems.isEmpty() && isOrdered) {
                    listStartNumber = itemNum
                }
                listOrdered = isOrdered
                listItems += MdListItem.Item(inline(body))
                listIndents += indentLevel
                i++
                continue
            }

            // ── 普通正文 ──
            flushList(); flushQuote()
            // 保留行内软换行（Web 端是 white-space:pre-wrap）
            if (para.isNotEmpty()) para += MdNode.Text("\n")
            para += inline(line)
            i++
        }
        flushAll()
        return out
    }

    /** 表格行拆分：去掉首尾竖线，支持转义竖线 `\|`，逐格 trim。 */
    private fun splitRow(line: String): List<String> {
        val trimmed = line.trim().trim('|')
        val cells = mutableListOf<String>()
        val sb = StringBuilder()
        var i = 0
        while (i < trimmed.length) {
            val c = trimmed[i]
            if (c == '\\' && i + 1 < trimmed.length && trimmed[i + 1] == '|') {
                sb.append('|')
                i += 2
                continue
            }
            if (c == '|') {
                cells.add(sb.toString().trim())
                sb.clear()
                i++
                continue
            }
            sb.append(c)
            i++
        }
        cells.add(sb.toString().trim())
        return cells
    }

    /** 解析对齐行 `|---|:--:|---:|`。 */
    private fun parseAligns(line: String): List<Align> =
        line.trim().trim('|').split('|').map { cell ->
            val c = cell.trim()
            when {
                c.startsWith(":") && c.endsWith(":") -> Align.Center
                c.endsWith(":") -> Align.Right
                else -> Align.Left
            }
        }

    /**
     * 行内解析（支持嵌套样式组合、转义符保护与流式降级）。
     *
     * 规范要求：
     * - `**加粗中包含 `代码`**` 或 `**[链接](url)**` 能复合继承外层样式；
     * - `\` 转义字符（如 `\*`、`\_`）不被误判为标记语法；
     * - 行内代码 `` ` `` 内保持纯字面量不二次解析；
     * - 未闭合语法统一当纯文本，杜绝流式闪烁。
     */
    private fun inline(text: String, baseStyle: MdStyle = MdStyle()): List<MdNode> {
        val out = mutableListOf<MdNode>()
        val sb = StringBuilder()

        fun flush() {
            if (sb.isNotEmpty()) {
                out += MdNode.Text(sb.toString(), baseStyle)
                sb.clear()
            }
        }

        var i = 0
        while (i < text.length) {
            val c = text[i]

            // 反斜杠转义：\* \_ \` \[ \] \~ \\ 直接输出字面字符
            if (c == '\\' && i + 1 < text.length) {
                val next = text[i + 1]
                if (next in "*_`[]~\\") {
                    sb.append(next)
                    i += 2
                    continue
                }
            }

            // 行内代码优先：` 里不做任何嵌套解析，但继承外层样式（如粗体）
            if (c == '`') {
                val end = text.indexOf('`', i + 1)
                if (end > i) {
                    flush()
                    out += MdNode.Text(
                        text.substring(i + 1, end),
                        baseStyle.copy(code = true),
                    )
                    i = end + 1
                    continue
                }
                // 未闭合 → 当普通字符（流式常见）
                sb.append(c); i++; continue
            }

            // 图片 ![alt](url)
            if (c == '!' && i + 1 < text.length && text[i + 1] == '[') {
                val closeText = text.indexOf(']', i + 2)
                if (closeText > i && closeText + 1 < text.length && text[closeText + 1] == '(') {
                    val closeUrl = text.indexOf(')', closeText)
                    if (closeUrl > closeText) {
                        flush()
                        out += MdNode.Image(
                            alt = text.substring(i + 2, closeText),
                            url = text.substring(closeText + 2, closeUrl),
                        )
                        i = closeUrl + 1
                        continue
                    }
                }
            }

            // 链接 [text](url)（内部支持解析嵌套加粗或行内代码）
            if (c == '[') {
                val closeText = text.indexOf(']', i)
                if (closeText > i && closeText + 1 < text.length && text[closeText + 1] == '(') {
                    val closeUrl = text.indexOf(')', closeText)
                    if (closeUrl > closeText) {
                        flush()
                        val linkText = text.substring(i + 1, closeText)
                        val linkUrl = text.substring(closeText + 2, closeUrl)
                        out += inline(linkText, baseStyle.copy(link = linkUrl))
                        i = closeUrl + 1
                        continue
                    }
                }
            }

            // 删除线 ~~text~~（内部支持嵌套解析）
            if (c == '~' && i + 1 < text.length && text[i + 1] == '~') {
                val end = text.indexOf("~~", i + 2)
                if (end > i) {
                    flush()
                    val inner = text.substring(i + 2, end)
                    out += inline(inner, baseStyle.copy(strike = true))
                    i = end + 2
                    continue
                }
            }

            // 粗斜体 ***/***、**/**
            if (c == '*' || c == '_') {
                val run = if (c == '*') "***" else "___"
                val run2 = if (c == '*') "**" else "__"
                if (text.startsWith(run, i)) {
                    val end = text.indexOf(run, i + 3)
                    if (end > i) {
                        flush()
                        val inner = text.substring(i + 3, end)
                        out += inline(inner, baseStyle.copy(bold = true, italic = true))
                        i = end + 3
                        continue
                    }
                }
                if (text.startsWith(run2, i)) {
                    val end = text.indexOf(run2, i + 2)
                    if (end > i) {
                        flush()
                        val inner = text.substring(i + 2, end)
                        out += inline(inner, baseStyle.copy(bold = true))
                        i = end + 2
                        continue
                    }
                }
                // 单字符斜体：CommonMark 规则，下划线或星号在单词内部不触发斜体
                val single = c.toString()
                val endSingle = text.indexOf(single, i + 1)
                val isIntraWord = (c == '_' || c == '*') && (
                    (i > 0 && text[i - 1].isLetterOrDigit()) &&
                    (endSingle < text.length - 1 && text[endSingle + 1].isLetterOrDigit())
                )
                // 避免把 `a * b * c` 里的空格当斜体，且标点/单词内部不误判
                if (!isIntraWord && endSingle > i + 1 && !text[i + 1].isWhitespace() && !text[endSingle - 1].isWhitespace()) {
                    flush()
                    val inner = text.substring(i + 1, endSingle)
                    out += inline(inner, baseStyle.copy(italic = true))
                    i = endSingle + 1
                    continue
                }
            }

            sb.append(c)
            i++
        }
        flush()
        return out
    }
}
