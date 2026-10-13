package io.github.dshmobile.app.render

import androidx.compose.foundation.layout.size

import androidx.compose.ui.Alignment

import io.github.dshmobile.app.ui.components.DshIcon

import io.github.dshmobile.app.ui.icons.DshIcons

import androidx.compose.runtime.mutableStateOf

import androidx.compose.runtime.setValue

import androidx.compose.runtime.getValue

import androidx.compose.ui.graphics.Brush

import androidx.compose.foundation.border

import androidx.compose.foundation.layout.RowScope

import androidx.compose.foundation.layout.widthIn

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
                is MdNode.Divider -> DividerView()
                is MdNode.Table -> TableView(block, color)
                is MdNode.TaskItem -> TaskItemView(block, color, onLinkClick)
                is MdNode.Image -> ImagePlaceholder(block)
                is MdNode.Text -> InlineText(
                    nodes = listOf(block),
                    baseColor = color,
                    onLinkClick = onLinkClick,
                )
            }
        }
    }
}

// ── 分隔线 ──────────────────────────────────────────────────────────────────

/**
 * 分隔线。
 *
 * 不用实线，而用「两端渐隐 + 中间浅色」—— 纯实线在长文里太硬，
 * 会把消息流切成两段。
 */
@Composable
private fun DividerView() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.md)
            .height(1.dp)
            .background(
                Brush.horizontalGradient(
                    listOf(
                        Color.Transparent,
                        MaterialTheme.colorScheme.outlineVariant,
                        Color.Transparent,
                    ),
                ),
            ),
    )
}

// ── 任务列表 ────────────────────────────────────────────────────────────────

/** `- [x]` / `- [ ]`：勾选框 + 内容。 */
@Composable
private fun TaskItemView(
    block: MdNode.TaskItem,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    Row(
        Modifier.padding(vertical = 2.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .padding(top = 3.dp)
                .size(15.dp)
                .background(
                    if (block.checked) DshTheme.online.copy(alpha = 0.18f) else Color.Transparent,
                    RoundedCornerShape(4.dp),
                )
                .border(
                    1.5.dp,
                    if (block.checked) DshTheme.online else color.copy(alpha = 0.4f),
                    RoundedCornerShape(4.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (block.checked) {
                DshIcon(
                    DshIcons.Check,
                    contentDescription = null,
                    tint = DshTheme.online,
                    size = 11.dp,
                )
            }
        }
        Spacer(Modifier.width(DshTheme.m.sm))
        InlineText(
            block.children,
            if (block.checked) color.copy(alpha = 0.55f) else color,
            onLinkClick,
        )
    }
}

// ── 图片 ────────────────────────────────────────────────────────────────────

/**
 * 图片占位。
 *
 * 🔴 **故意不加载远程图**：聊天流里出现任意 URL 就自动发网络请求，
 * 既不可控（隐私 + 流量 + 失败重试风暴），也让流式渲染变慢。
 * 所以只显示 alt + 链接，由用户决定是否点开。
 */
@Composable
private fun ImagePlaceholder(block: MdNode.Image) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.xs)
            .background(DshTheme.codeBg, RoundedCornerShape(8.dp))
            .padding(horizontal = DshTheme.m.md, vertical = DshTheme.m.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DshIcon(
            DshIcons.Image,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            size = 15.dp,
        )
        Spacer(Modifier.width(DshTheme.m.sm))
        Column(Modifier.weight(1f)) {
            Text(
                text = block.alt.ifBlank { "图片" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = block.url,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── 表格 ────────────────────────────────────────────────────────────────────

/**
 * 表格。
 *
 * 🔴 手机上表格**必须能横向滚动**：DSH 的输出里表格常有 6~8 列
 * （方法名 / 参数 / 必填 / 源码位置…），硬塞进 360dp 会挤成一团。
 *
 * 取舍：
 *  - 整体横向滚动，每列 `min=88.dp`，避免中文表头被压成竖排；
 *  - 表头浅底 + 一条分隔线，**不用外框**（外框在窄屏上会碎成多段）；
 *  - 单元格顶对齐，长内容不会因居中而错位。
 */
@Composable
private fun TableView(block: MdNode.Table, color: Color) {
    Column(Modifier.padding(vertical = DshTheme.m.xs)) {
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(vertical = DshTheme.m.sm),
        ) {
            block.header.forEachIndexed { i, cell ->
                CellText(cell, color, block.aligns.getOrElse(i) { Align.Left }, header = true)
            }
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(MaterialTheme.colorScheme.outlineVariant),
        )
        // 数据行共用一个滚动状态，才能横着一起滚
        var dataScroll by remember { mutableStateOf(androidx.compose.foundation.ScrollState(0)) }
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(dataScroll)
                .background(MaterialTheme.colorScheme.surface),
        ) {
            block.aligns.indices.forEach { col ->
                Column(
                    Modifier
                        .widthIn(min = 88.dp)
                        .weight(1f)
                        .padding(horizontal = DshTheme.m.md, vertical = DshTheme.m.sm),
                ) {
                    block.rows.forEach { row ->
                        Text(
                            text = plainOf(row.getOrElse(col) { emptyList() }),
                            style = MaterialTheme.typography.bodySmall,
                            color = color,
                            softWrap = true,
                            modifier = Modifier.padding(vertical = 3.dp),
                        )
                    }
                }
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.xs))
}

@Composable
private fun RowScope.CellText(
    cell: List<MdNode>,
    color: Color,
    align: Align,
    header: Boolean,
) {
    Box(
        Modifier
            .widthIn(min = 88.dp)
            .weight(1f)
            .padding(horizontal = DshTheme.m.md),
        contentAlignment = when (align) {
            Align.Left -> Alignment.CenterStart
            Align.Center -> Alignment.Center
            Align.Right -> Alignment.CenterEnd
        },
    ) {
        Text(
            text = plainOf(cell),
            style = MaterialTheme.typography.bodySmall.copy(
                fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
            ),
            color = color,
            softWrap = true,
        )
    }
}

/** 表格单元格只取纯文本（表格里样式收益低、风险高）。 */
private fun plainOf(nodes: List<MdNode>): String = buildString {
    fun walk(list: List<MdNode>) {
        list.forEach { n ->
            when (n) {
                is MdNode.Text -> append(n.value)
                is MdNode.Paragraph -> walk(n.children)
                is MdNode.Heading -> walk(n.children)
                is MdNode.Quote -> walk(n.children)
                is MdNode.CodeBlock -> append(n.code)
                is MdNode.Image -> append(n.alt)
                else -> Unit
            }
        }
    }
    walk(nodes)
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
                    // ⚠️ 行内上下文只关心叶子节点（Text）。块级节点由外层单独渲染。
                    // **必须写 `else -> Unit`** 而不是逐个列分支：
                    // 否则每加一个 MdNode 实现（如 Table/Divider/TaskItem）
                    // 这个 when 就编译不过 —— 那正是加富文本时踩到的一次。
                    else -> Unit
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
