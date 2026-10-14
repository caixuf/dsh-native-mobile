package io.github.dshmobile.app.render

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.icons.DshIcons

/**
 * 生产级 Markdown 富文本渲染器（Compose 版）。
 *
 * ## 架构与排版特性：
 * - **流式鲁棒**：未闭合语法（未完代码块、粗体等）优雅降级为纯文本，不抛异常也不闪烁；
 * - **CodeCard 卡片**：对齐 DSH Web `CodeCard.module.css`（深色终端底、语言徽标、带反馈一键复制、内置语法高亮）；
 * - **行内代码 Chip**：微底色圆角 Chip 样式，与正文自然拉开层次；
 * - **原生超链接**：直接驱动系统浏览器调起（`Intent.ACTION_VIEW` / `LocalUriHandler`）；
 * - **多列网格表格**：横向平滑连贯滚动，表头/数据行对齐一致；
 * - **极简引用块**：左侧品牌蓝装饰条 + 微色底提升质感。
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = DshTheme.markdownBody,
    onLinkClick: ((String) -> Unit)? = null,
) {
    val blocks = remember(text) { Markdown.parse(text) }

    Column(modifier) {
        blocks.forEachIndexed { index, block ->
            when (block) {
                is MdNode.Paragraph -> ParagraphText(block.children, color, onLinkClick)
                is MdNode.Heading -> HeadingText(block, color, isFirst = index == 0)
                is MdNode.CodeBlock -> CodeBlockView(block)
                is MdNode.ListBlock -> ListBlockView(block, color, onLinkClick)
                is MdNode.Quote -> QuoteView(block, color, onLinkClick)
                is MdNode.Callout -> CalloutView(block, color, onLinkClick)
                is MdNode.Divider -> DividerView()
                is MdNode.Table -> TableView(block, color)
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

// ── 图片 ────────────────────────────────────────────────────────────────────

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

@Composable
private fun TableView(block: MdNode.Table, color: Color) {
    val isDark = isSystemInDarkTheme()
    val borderColor = if (isDark) Color(0xFF2E303E) else Color(0xFFE2E8F0)
    val headerBg = if (isDark) Color(0xFF1E202E) else Color(0xFFF8FAFC)
    val rowBg = if (isDark) Color(0xFF161622) else Color(0xFFFFFFFF)
    val altRowBg = if (isDark) Color(0xFF1A1C28) else Color(0xFFF9FAFB)
    val dividerColor = if (isDark) Color(0xFF262837) else Color(0xFFEDF2F7)

    val cols = block.header.size

    // 🔴 两个真实问题（2026-10-13 实机截图复现）：
    //
    //  1. **列宽用 `.length` 估算，不区分 CJK**：`"手机远程网页"` 是 6 个字符，
    //     但中文实际显示宽度约等于 12 个半角字符 → 列被算窄，内容换行或被裁。
    //     实测表格右列 `192.168.31.79:1…` 就是这样被切掉的。
    //  2. **没有「窄表自适应填满」策略**：≤3 列的表格在手机上完全放得下，
    //     却仍按内容宽度排布，右列被推到屏幕外，看着像"内容被切了"。
    //     对齐 DSH 上游 `MarkdownText.module.css`：
    //     <4 列用 `width:100%` 自适应，≥4 列才 `max-content` + 横向滚动。
    val needsScroll = cols >= 4
    val colWidths = remember(block) {
        (0 until cols).map { col ->
            val headerLen = visualWidth(block.header.getOrElse(col) { emptyList() })
            val maxRowLen = block.rows.maxOfOrNull { row ->
                visualWidth(row.getOrElse(col) { emptyList() })
            } ?: 0
            val maxLen = maxOf(headerLen, maxRowLen)
            // 上游规格：min-width 100px、max-width min(30vw, 320px)
            (100 + (maxLen * 8.5)).toInt().coerceIn(100, 320).dp
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.xs)
            .border(1.dp, borderColor, RoundedCornerShape(12.dp))
            .clip(RoundedCornerShape(12.dp)),
    ) {
        val scrollState = rememberScrollState()
        Column(
            // 窄表（≤3 列）不滚动：直接把可用宽度铺满，列宽用 weight 分配。
            // 宽表（≥4 列）才横向滚动，列宽按内容估算。
            Modifier
                .fillMaxWidth()
                .then(if (needsScroll) Modifier.horizontalScroll(scrollState) else Modifier),
        ) {
            // 表头行
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(headerBg)
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                block.header.forEachIndexed { i, cell ->
                    if (i > 0) {
                        Box(Modifier.width(1.dp).height(18.dp).background(borderColor.copy(alpha = 0.7f)))
                    }
                    val w = colWidths.getOrElse(i) { 100.dp }
                    CellText(
                        cell = cell,
                        color = if (isDark) Color(0xFFE2E8F0) else Color(0xFF1E293B),
                        align = block.aligns.getOrElse(i) { Align.Left },
                        header = true,
                        // 窄表（≤3 列）：weight 平分可用宽度，真正铺满屏幕；
                        // 宽表（≥4 列）：固定内容宽度 + 横向滚动。
                        cellModifier = if (needsScroll) Modifier.width(w) else Modifier.weight(1f),
                    )
                }
            }

            Box(Modifier.fillMaxWidth().height(1.dp).background(borderColor))

            // 数据行
            block.rows.forEachIndexed { rowIdx, rowCells ->
                if (rowIdx > 0) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(dividerColor))
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(if (rowIdx % 2 == 1) altRowBg else rowBg)
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    (0 until cols).forEach { col ->
                        if (col > 0) {
                            Box(Modifier.width(1.dp).height(16.dp).background(dividerColor))
                        }
                        val cell = rowCells.getOrElse(col) { emptyList() }
                        val w = colWidths.getOrElse(col) { 100.dp }
                        CellText(
                            cell = cell,
                            color = color,
                            align = block.aligns.getOrElse(col) { Align.Left },
                            header = false,
                            cellModifier = if (needsScroll) Modifier.width(w) else Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.xs))
}

@Composable
private fun CellText(
    cell: List<MdNode>,
    color: Color,
    align: Align,
    header: Boolean,
    cellModifier: Modifier,
) {
    Box(
        cellModifier.padding(horizontal = 12.dp),
        contentAlignment = when (align) {
            Align.Left -> Alignment.CenterStart
            Align.Center -> Alignment.Center
            Align.Right -> Alignment.CenterEnd
        },
    ) {
        InlineText(
            nodes = cell,
            baseColor = color,
            baseSize = 13.sp,
            baseWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
            textAlign = when (align) {
                Align.Left -> TextAlign.Start
                Align.Center -> TextAlign.Center
                Align.Right -> TextAlign.End
            },
        )
    }
}

/**
 * 视觉宽度：CJK / emoji 按 2 个单位计。
 *
 * 🔴 旧实现用 `String.length` 估列宽，中文被算成 1 宽 ——
 * 于是「手机远程网页」这种列被估窄，内容换行或被裁切。
 * 与 Web 端 `visualLen` 保持同一套判据。
 */
private fun visualWidth(nodes: List<MdNode>): Int {
    val text = plainOf(nodes)
    var w = 0
    for (ch in text) {
        w += when {
            ch == '\t' -> 4
            // 零宽组合符（重音符等）不占栅格
            ch.code in 0x0300..0x036F -> 0
            isWideChar(ch) -> 2
            else -> 1
        }
    }
    return w
}

private fun isWideChar(ch: Char): Boolean {
    val c = ch.code
    return (c in 0x1100..0x115F) ||   // 韩文字母
        (c in 0x2E80..0xA4CF) ||       // CJK 部首 / 汉字 / 注音
        (c in 0xAC00..0xD7A3) ||       // 韩文音节
        (c in 0xF900..0xFAFF) ||       // CJK 兼容汉字
        (c in 0xFE30..0xFE6F) ||       // CJK 兼容形式
        (c in 0xFF00..0xFF60) ||       // 全角形式
        (c in 0xFFE0..0xFFE6) ||       // 全角符号
        (c in 0x2600..0x27BF) ||       // 杂项符号 / Dingbats（✅ 等）
        (c in 0x2B00..0x2BFF)          // 杂项符号与箭头
}

private fun plainOf(nodes: List<MdNode>): String = buildString {
    fun walk(list: List<MdNode>) {
        list.forEach { n ->
            when (n) {
                is MdNode.Text -> append(n.value)
                is MdNode.Paragraph -> walk(n.children)
                is MdNode.Heading -> walk(n.children)
                is MdNode.Quote -> walk(n.children)
                is MdNode.Callout -> walk(n.children)
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
    if (children.isEmpty() || plainOf(children).isBlank()) return
    InlineText(children, color, onLinkClick)
    Spacer(Modifier.height(DshTheme.m.sm))
}

// ── 标题 ────────────────────────────────────────────────────────────────────

@Composable
private fun HeadingText(block: MdNode.Heading, color: Color, isFirst: Boolean = false) {
    val isDark = isSystemInDarkTheme()
    val (size, weight, topSpace) = when (block.level) {
        1 -> Triple(20.sp, FontWeight.Bold, if (isFirst) 0.dp else 16.dp)
        2 -> Triple(17.sp, FontWeight.SemiBold, if (isFirst) 0.dp else 12.dp)
        else -> Triple(15.sp, FontWeight.SemiBold, if (isFirst) 0.dp else 8.dp)
    }
    if (topSpace > 0.dp) {
        Spacer(Modifier.height(topSpace))
    }
    InlineText(
        nodes = block.children,
        baseColor = if (isDark) Color(0xFFF1F5F9) else Color(0xFF0F172A),
        baseSize = size,
        baseWeight = weight,
        onLinkClick = null,
    )
    if (block.level == 1) {
        Spacer(Modifier.height(4.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(if (isDark) Color(0xFF27272A) else Color(0xFFE2E8F0)),
        )
    }
    Spacer(Modifier.height(6.dp))
}

// ── 代码块（使用生产级 CodeCard）────────────────────────────────────────────

@Composable
private fun CodeBlockView(block: MdNode.CodeBlock) {
    CodeCard(
        code = block.code,
        language = block.language,
        modifier = Modifier.padding(vertical = DshTheme.m.xs),
    )
    Spacer(Modifier.height(DshTheme.m.xs))
}

// ── 列表 ────────────────────────────────────────────────────────────────────

@Composable
private fun ListBlockView(
    block: MdNode.ListBlock,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    // 过滤空项，但要**保留原始下标**，否则编号会错位：
    // 过滤后重新 index 会让 `1.  2.  3.  7.  8.` 显示成 `1. 2. 3. 4. 5.`（实测踩到）。
    val validItems = remember(block.items) {
        block.items.withIndex()
            .filter { (_, item) -> item.plain().isNotBlank() }
    }
    if (validItems.isEmpty()) return

    Column(Modifier.padding(vertical = DshTheme.m.xxs)) {
        validItems.forEach { (originalIndex, item) ->
            val indent = block.indents.getOrElse(originalIndex) { 0 }
            val itemNumber = originalIndex + block.startNumber

            // 🔴 任务项走独立分支：它自带勾选框，不能再画 • / 1. 标记，
            // 否则会出现「• ☐ 写文档」的双重标记。
            if (item is MdListItem.Task) {
                TaskRow(
                    checked = item.checked,
                    children = item.children,
                    indent = indent,
                    color = color,
                    onLinkClick = onLinkClick,
                )
                return@forEach
            }

            val children = (item as MdListItem.Item).children
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp)
                    .padding(start = (indent * 16).dp),
            ) {
                Text(
                    text = if (block.ordered) "$itemNumber." else "•",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (block.ordered) color.copy(alpha = 0.55f) else DshTheme.brand,
                    modifier = Modifier.width(if (block.ordered) (if (itemNumber >= 10) 26.dp else 20.dp) else 16.dp),
                )
                Box(Modifier.weight(1f)) {
                    InlineText(children, color, onLinkClick)
                }
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.sm))
}

/** 列表内的任务项行（勾选框 + 文本）。 */
@Composable
private fun TaskRow(
    checked: Boolean,
    children: List<MdNode>,
    indent: Int,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .padding(start = (indent * 16).dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .padding(top = 3.dp)
                .size(16.dp)
                .background(
                    if (checked) DshTheme.online.copy(alpha = 0.18f) else Color.Transparent,
                    RoundedCornerShape(4.dp),
                )
                .border(
                    1.5.dp,
                    if (checked) DshTheme.online else color.copy(alpha = 0.4f),
                    RoundedCornerShape(4.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (checked) {
                DshIcon(
                    DshIcons.Check,
                    contentDescription = null,
                    tint = DshTheme.online,
                    size = 11.dp,
                )
            }
        }
        Spacer(Modifier.width(DshTheme.m.sm))
        Box(Modifier.weight(1f)) {
            InlineText(
                children,
                if (checked) color.copy(alpha = 0.55f) else color,
                onLinkClick,
            )
        }
    }
}

// ── 引用 ────────────────────────────────────────────────────────────────────

@Composable
private fun QuoteView(
    block: MdNode.Quote,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    val isDark = isSystemInDarkTheme()
    val quoteBg = if (isDark) Color(0x187AA2F7) else Color(0x0A0060DF)
    val quoteBorder = if (isDark) Color(0xFF7AA2F7) else DshTheme.brand

    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.xs)
            .clip(RoundedCornerShape(topEnd = 8.dp, bottomEnd = 8.dp))
            .background(quoteBg)
            .drawBehind {
                drawRect(
                    color = quoteBorder,
                    size = androidx.compose.ui.geometry.Size(3.5.dp.toPx(), size.height),
                )
            }
            .padding(start = DshTheme.m.md, top = 8.dp, bottom = 8.dp, end = 12.dp),
    ) {
        Column {
            block.children.forEach { child ->
                InlineText(listOf(child), color.copy(alpha = 0.88f), onLinkClick)
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.sm))
}

// ── Callout 警告块（GitHub / 现代富文本规范）───────────────────────────────

@Composable
private fun CalloutView(
    block: MdNode.Callout,
    color: Color,
    onLinkClick: ((String) -> Unit)?,
) {
    val isDark = isSystemInDarkTheme()
    val (themeColor, icon, defaultTitle) = when (block.type) {
        CalloutType.Note -> Triple(Color(0xFF2563EB), DshIcons.Info, "说明")
        CalloutType.Tip -> Triple(Color(0xFF059669), DshIcons.Lightbulb, "提示")
        CalloutType.Important -> Triple(Color(0xFF7C3AED), DshIcons.Bookmark, "重要")
        CalloutType.Warning -> Triple(Color(0xFFD97706), DshIcons.AlertTriangle, "注意")
        CalloutType.Caution -> Triple(Color(0xFFDC2626), DshIcons.ShieldAlert, "危险")
    }

    val cardBg = if (isDark) themeColor.copy(alpha = 0.12f) else themeColor.copy(alpha = 0.06f)
    val cardBorder = themeColor.copy(alpha = if (isDark) 0.35f else 0.22f)
    val title = block.customTitle?.takeIf { it.isNotBlank() } ?: defaultTitle

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = DshTheme.m.xs)
            .clip(RoundedCornerShape(10.dp))
            .background(cardBg)
            .border(1.dp, cardBorder, RoundedCornerShape(10.dp))
            .drawBehind {
                drawRect(
                    color = themeColor,
                    size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height),
                )
            }
            .padding(start = 14.dp, top = 10.dp, end = 12.dp, bottom = 10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(bottom = 6.dp),
        ) {
            DshIcon(
                icon,
                contentDescription = null,
                tint = themeColor,
                size = 15.dp,
            )
            Spacer(Modifier.width(7.dp))
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Bold,
                color = themeColor,
                letterSpacing = 0.3.sp,
            )
        }
        Column {
            block.children.forEach { child ->
                when (child) {
                    is MdNode.Paragraph -> InlineText(child.children, color.copy(alpha = 0.9f), onLinkClick)
                    else -> InlineText(listOf(child), color.copy(alpha = 0.9f), onLinkClick)
                }
            }
        }
    }
    Spacer(Modifier.height(DshTheme.m.xs))
}

// ── 行内 ────────────────────────────────────────────────────────────────────

/**
 * 行内渲染（带行内代码 Chip 样式与原生超链接支持）。
 */
@Composable
private fun InlineText(
    nodes: List<MdNode>,
    baseColor: Color,
    onLinkClick: ((String) -> Unit)? = null,
    baseSize: androidx.compose.ui.unit.TextUnit = DshTheme.markdownSize,
    baseWeight: FontWeight = FontWeight.Normal,
    textAlign: TextAlign = TextAlign.Start,
) {
    val uriHandler = LocalUriHandler.current
    val isDark = isSystemInDarkTheme()
    val inlineCodeBg = if (isDark) Color(0xFF282A36) else Color(0xFFE9EAF0)
    val inlineCodeFg = if (isDark) Color(0xFFE2E8F0) else Color(0xFF1E293B)
    val linkColor = DshTheme.markdownLink

    val annotated = remember(nodes, baseColor, baseSize, linkColor, isDark) {
        buildAnnotatedString {
            nodes.forEach { node ->
                when (node) {
                    is MdNode.Text -> {
                        val s = node.style
                        val hasLink = s.link != null

                        val spanStyle = SpanStyle(
                            color = when {
                                hasLink -> linkColor
                                s.code -> inlineCodeFg
                                else -> baseColor
                            },
                            background = if (s.code) inlineCodeBg else Color.Transparent,
                            fontFamily = if (s.code) FontFamily.Monospace else null,
                            fontSize = if (s.code) (baseSize.value * 0.92f).sp else baseSize,
                            fontWeight = when {
                                s.bold -> FontWeight.Bold
                                s.code -> FontWeight.Medium
                                else -> baseWeight
                            },
                            fontStyle = if (s.italic) FontStyle.Italic else FontStyle.Normal,
                            textDecoration = when {
                                hasLink && s.strike -> TextDecoration.combine(
                                    listOf(TextDecoration.Underline, TextDecoration.LineThrough),
                                )
                                hasLink -> TextDecoration.Underline
                                s.strike -> TextDecoration.LineThrough
                                else -> TextDecoration.None
                            },
                            letterSpacing = if (s.code) 0.2.sp else androidx.compose.ui.unit.TextUnit.Unspecified,
                        )

                        if (hasLink) {
                            val url = s.link!!
                            pushLink(
                                LinkAnnotation.Url(
                                    url = url,
                                    styles = TextLinkStyles(
                                        style = SpanStyle(
                                            color = linkColor,
                                            fontWeight = if (s.bold) FontWeight.Bold else FontWeight.Medium,
                                            textDecoration = if (s.strike) {
                                                TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
                                            } else {
                                                TextDecoration.Underline
                                            },
                                        ),
                                    ),
                                    linkInteractionListener = {
                                        if (onLinkClick != null) {
                                            onLinkClick(url)
                                        } else {
                                            runCatching { uriHandler.openUri(url) }
                                        }
                                    },
                                ),
                            )
                        }

                        pushStyle(spanStyle)
                        append(node.value)
                        pop()

                        if (hasLink) {
                            pop()
                        }
                    }

                    // 🔴 图片必须在这里降级成**可读的文字占位**，不能 `else -> Unit`。
                    //
                    // 之前的 `else -> Unit` 让 `![alt](url)` 整条**静默消失** ——
                    // 不报错、不崩溃，用户只看到那句话凭空少了一段。
                    // 这和任务项那个 bug 是同一类「静默丢弃」，已一并修掉。
                    //
                    // ⚠️ 颜色必须是**调用方传进来的局部变量**，不能写 `DshTheme.xxx`：
                    // 这段代码在 `remember {}` 里，不在 @Composable 上下文，
                    // 读 `DshTheme` 会编译报错（Composable invocations can only happen...）。
                    is MdNode.Image -> {
                        pushStyle(
                            SpanStyle(
                                color = linkColor,
                                fontWeight = FontWeight.Medium,
                                textDecoration = TextDecoration.Underline,
                            ),
                        )
                        append("[图] ")
                        append(node.alt.ifBlank { node.url })
                        pop()
                    }

                    // 其余块级节点不该流到行内渲染器（防御性分支）。
                    else -> Unit
                }
            }
        }
    }

    Text(
        text = annotated,
        fontSize = baseSize,
        lineHeight = DshTheme.markdownLineHeight,
        textAlign = textAlign,
        modifier = Modifier.fillMaxWidth(),
    )
}
