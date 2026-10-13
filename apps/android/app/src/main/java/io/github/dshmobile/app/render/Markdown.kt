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

    /** 列表项序列 */
    data class ListBlock(val ordered: Boolean, val items: List<List<MdNode>>) : MdNode

    /** 引用块 */
    data class Quote(val children: List<MdNode>) : MdNode

    /** 标题 */
    data class Heading(val level: Int, val children: List<MdNode>) : MdNode
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
        val listItems = mutableListOf<List<MdNode>>()
        var quoteBuf = mutableListOf<MdNode>()

        fun flushPara() {
            if (para.isNotEmpty()) {
                out += MdNode.Paragraph(para.toList())
                para.clear()
            }
        }

        fun flushList() {
            if (listItems.isNotEmpty()) {
                out += MdNode.ListBlock(listOrdered, listItems.toList())
                listItems.clear()
            }
        }

        fun flushQuote() {
            if (quoteBuf.isNotEmpty()) {
                out += MdNode.Quote(quoteBuf.toList())
                quoteBuf.clear()
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

            // ── 引用 ──
            val quote = Regex("^\\s*>\\s?(.*)$").find(line)
            if (quote != null) {
                flushPara(); flushList()
                quoteBuf += inline(quote.groupValues[1])
                i++
                continue
            }

            // ── 列表 ──
            val unordered = Regex("^\\s*[-*+]\\s+(.*)$").find(line)
            val ordered = Regex("^\\s*\\d+[.)]\\s+(.*)$").find(line)
            if (unordered != null || ordered != null) {
                flushPara(); flushQuote()
                val isOrdered = ordered != null
                if (listItems.isNotEmpty() && listOrdered != isOrdered) flushList()
                listOrdered = isOrdered
                listItems += inline((unordered ?: ordered)!!.groupValues[1])
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

    /** 解析一行内联语法。 */
    private fun inline(text: String): List<MdNode> {
        val out = mutableListOf<MdNode>()
        val sb = StringBuilder()

        fun flush() {
            if (sb.isNotEmpty()) {
                out += MdNode.Text(sb.toString())
                sb.clear()
            }
        }

        var i = 0
        while (i < text.length) {
            val c = text[i]

            // 行内代码优先：` 里不做任何解析
            if (c == '`') {
                val end = text.indexOf('`', i + 1)
                if (end > i) {
                    flush()
                    out += MdNode.Text(
                        text.substring(i + 1, end),
                        MdStyle(code = true),
                    )
                    i = end + 1
                    continue
                }
                // 未闭合 → 当普通字符（流式常见）
                sb.append(c); i++; continue
            }

            // 链接 [text](url)
            if (c == '[') {
                val closeText = text.indexOf(']', i)
                if (closeText > i && closeText + 1 < text.length && text[closeText + 1] == '(') {
                    val closeUrl = text.indexOf(')', closeText)
                    if (closeUrl > closeText) {
                        flush()
                        out += MdNode.Text(
                            text.substring(i + 1, closeText),
                            MdStyle(link = text.substring(closeText + 2, closeUrl)),
                        )
                        i = closeUrl + 1
                        continue
                    }
                }
            }

            // 删除线 ~~text~~
            if (c == '~' && i + 1 < text.length && text[i + 1] == '~') {
                val end = text.indexOf("~~", i + 2)
                if (end > i) {
                    flush()
                    out += MdNode.Text(text.substring(i + 2, end), MdStyle(strike = true))
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
                        out += MdNode.Text(
                            text.substring(i + 3, end),
                            MdStyle(bold = true, italic = true),
                        )
                        i = end + 3
                        continue
                    }
                }
                if (text.startsWith(run2, i)) {
                    val end = text.indexOf(run2, i + 2)
                    if (end > i) {
                        flush()
                        out += MdNode.Text(
                            text.substring(i + 2, end),
                            MdStyle(bold = true),
                        )
                        i = end + 2
                        continue
                    }
                }
                // 单星号斜体
                val single = c.toString()
                val endSingle = text.indexOf(single, i + 1)
                // 避免把 `a * b * c` 里的空格当斜体
                if (endSingle > i + 1 && !text[i + 1].isWhitespace() && !text[endSingle - 1].isWhitespace()) {
                    flush()
                    out += MdNode.Text(
                        text.substring(i + 1, endSingle),
                        MdStyle(italic = true),
                    )
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
