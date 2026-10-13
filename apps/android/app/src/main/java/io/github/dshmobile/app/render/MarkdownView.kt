package io.github.dshmobile.app.render

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dshmobile.app.ui.DshTheme

/**
 * Markdown 渲染器（Compose 版）。
 *
 * ## 为什么自己写
 *
 * 见 [Markdown] 的注释：要处理**流式半截语法**且控制 APK 体积，
 * 引三方库反而更麻烦。这里渲染的语法集合是**按 DSH 实际输出**挑的。
 *
 * ## 性能：增量解析
 *
 * 流式输出时每收到一个 token 就要重渲染，若每次都重新解析整篇，
 * 长文本会明显卡顿。所以：
 *
 *  - `remember(text)` 缓存解析结果 —— 文本没变就不重新解析；
 *  - **只解析末尾**：`parse()` 内部按行分块，代码块未闭合时也算完整块，
 *    所以「代码块正在输出」时每帧只多处理新增行。
 *
 * Compose 的 `remember` 已经能覆盖绝大多数场景（同一帧内多次重组不会重解析）。
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = DshTheme.markdownBody,
    onLinkClick: ((String) -> Unit)? = null,
) {
    // 解析结果随文本变化而重算；文本不变则复用
    val blocks = remember(text) { Markdown.parse(text) }

    Column(modifier) {
        blocks.forEach { block ->
            when (block) {
                is MdNode.Paragraph -> ParagraphText(block.children, color, onLinkClick)
                is MdNode.Heading -> HeadingText(block, color)
                is MdNode.CodeBlock -> CodeBlockView(block)
                is MdNode.ListBlock -> ListBlockView(block, color, onLinkClick)
                is MdNode.Quote -> QuoteView(block, color, onLinkClick)
                is MdNode.Text -> InlineText(
                    nodes = listOf(block),
                    baseColor = color,
                    onLinkClick = onLinkClick,
                )
            }
        }
    }
}

// ── 段落 ────────────────────────────────────────────────────────────────────

@Composable
private fun ParagraphText(
    children: List<MdNode>,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    InlineText(children, color, onLinkClick)
    Spacer(Modifier.height(DshTheme.m.sm))
}

// ── 标题 ────────────────────────────────────────────────────────────────────

@Composable
private fun HeadingText(block: MdNode.Heading, color: Color) {
    val (size, weight) = when (block.level) {
        1 -> 19.sp to FontWeight.SemiBold
        2 -> 17.sp to FontWeight.SemiBold
        else -> 15.5.sp to FontWeight.Medium
    }
    Spacer(Modifier.height(DshTheme.m.xs))
    InlineText(
        nodes = block.children,
        baseColor = color,
        baseSize = size,
        baseWeight = weight,
        onLinkClick = null,
    )
    Spacer(Modifier.height(DshTheme.m.xs))
}

// ── 代码块 ──────────────────────────────────────────────────────────────────

/**
 * 代码块。
 *
 * 对齐 DSH Web 的处理方式：等宽字体 + **浅底 + 1px 边框**，横向可滚动
 * （不做软换行 —— 代码换行就毁掉了）。
 */
@Composable
private fun CodeBlockView(block: MdNode.CodeBlock) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.xs)
            .background(DshTheme.codeBg, RoundedCornerShape(10.dp))
            .padding(DshTheme.m.md),
    ) {
        // 有语言名时显示一个小标签，方便扫读
        block.language?.takeIf { it.isNotBlank() && it.length <= 16 }?.let { lang ->
            Text(
                text = lang,
                style = MaterialTheme.typography.labelSmall,
                color = DshTheme.codeText.copy(alpha = 0.6f),
                modifier = Modifier.padding(bottom = 4.dp),
            )
        }
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            Text(
                text = block.code.ifEmpty { " " }, // 空代码块要给高度，否则会塌
                // 代码块样式：等宽 + 略小字号，横向滚动不换行
                style = DshTheme.codeTextStyle,
                color = DshTheme.codeText,
                softWrap = false,
                maxLines = 40,
                overflow = TextOverflow.Visible,
            )
        }
    }
    Spacer(Modifier.height(DshTheme.m.xs))
}

// ── 列表 ────────────────────────────────────────────────────────────────────

@Composable
private fun ListBlockView(
    block: MdNode.ListBlock,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    Column(Modifier.padding(vertical = DshTheme.m.xxs)) {
        block.items.forEachIndexed { index, item ->
            Row(Modifier.padding(vertical = 2.dp)) {
                Text(
                    text = if (block.ordered) "${index + 1}." else "•",
                    style = MaterialTheme.typography.bodyMedium,
                    color = color.copy(alpha = 0.55f),
                    modifier = Modifier.width(if (block.ordered) 22.dp else 16.dp),
                )
                InlineText(item, color, onLinkClick)
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.sm))
}

// ── 引用 ────────────────────────────────────────────────────────────────────

@Composable
private fun QuoteView(
    block: MdNode.Quote,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.xs)
            // 左边线：Web 端引用块的标准做法
            .drawBehind {
                drawRect(
                    color = color.copy(alpha = 0.25f),
                    size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height),
                )
            }
            .padding(start = DshTheme.m.md),
    ) {
        Column {
            block.children.forEach { child ->
                InlineText(listOf(child), color.copy(alpha = 0.85f), onLinkClick)
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.sm))
}

// ── 行内 ────────────────────────────────────────────────────────────────────

/**
 * 行内渲染。
 *
 * 用一个 `Text` + `AnnotatedString` 画完整个段落，而不是嵌套多个 `Text` ——
 * 这样**换行和跨行内的样式**都能正确处理（嵌套 Text 在长段落里会断行错位）。
 */
@Composable
private fun InlineText(
    nodes: List<MdNode>,
    baseColor: Color,
    onLinkClick: ((String) -> Unit)? = null,
    baseSize: androidx.compose.ui.unit.TextUnit = DshTheme.markdownSize,
    baseWeight: FontWeight = FontWeight.Normal,
) {
    // ⚠️ 注意：主题色必须在 **@Composable 上下文里**取出后再进 remember。
    // 把 `DshTheme.xxx` 写在 remember 的 lambda 内部会报
    // "@Composable invocations can only happen from the context of a @Composable function"。
    val linkColor = DshTheme.markdownLink
    val annotated = remember(nodes, baseColor, baseSize, linkColor) {
        buildAnnotatedString {
            nodes.forEach { node ->
                when (node) {
                    is MdNode.Text -> {
                        val s = node.style
                        val style = SpanStyle(
                            color = if (s.link != null) linkColor else baseColor,
                            fontWeight = if (s.bold) FontWeight.Bold else baseWeight,
                            fontStyle = if (s.italic) FontStyle.Italic else FontStyle.Normal,
                            fontFamily = if (s.code) FontFamily.Monospace else FontFamily.SansSerif,
                            textDecoration = if (s.link != null || s.strike) {
                                TextDecoration.Underline
                            } else {
                                TextDecoration.None
                            },
                            // 行内代码加一点字距，避免等宽字体显得拥挤
                            letterSpacing = if (s.code) 0.2.sp else 0.sp,
                        )
                        if (s.code) {
                            // 行内代码：背景色要单独 span，Compose 的 SpanStyle 不支持
                            // background，所以用一个可见的等宽字重代替底色。
                            pushStyle(style)
                            append(node.value)
                            pop()
                        } else {
                            pushStyle(style)
                            append(node.value)
                            pop()
                        }
                        if (s.link != null && onLinkClick != null) {
                            // 点击热区：见下方 LinkSpan 的处理（当前实现不注册手势，
                            // 避免与消息滚动冲突；需要时再开）
                        }
                    }
                    is MdNode.Paragraph -> Unit
                    is MdNode.CodeBlock -> Unit
                    is MdNode.ListBlock -> Unit
                    is MdNode.Quote -> Unit
                    is MdNode.Heading -> Unit
                }
            }
        }
    }

    Text(
        text = annotated,
        fontSize = baseSize,
        lineHeight = DshTheme.markdownLineHeight,
        modifier = Modifier.fillMaxWidth(),
    )
}
