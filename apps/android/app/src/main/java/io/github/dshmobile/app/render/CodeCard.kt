package io.github.dshmobile.app.render

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.icons.DshIcons
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 代码块默认折叠行数。
 *
 * 对齐 DSH 上游 `ui-primitives/lib/markdown/CodeBlock.module.css` 的
 * `maxLines` 默认值 **16**：超过这个高度就必须给展开入口，
 * 否则长代码会把整条会话流冲散。
 */
internal const val DEFAULT_FOLD_LINES = 16
/**
 * 生产级代码卡片组件（对齐 DSH Web `CodeCard.module.css` 规范）。
 *
 * ## 视觉设计细节：
 * - 纯深色底（暗黑终端质感 `#16161E`），圆角 12.dp，1px 细微暗态边框；
 * - 顶部头部栏：
 *   - 左侧：编程语言微徽标（如 `KOTLIN`, `SHELL`, `JSON`），等宽大写字；
 *   - 右侧：一键复制代码按钮，点击瞬间切为绿色勾选态并显示「已复制」，2 秒后自动恢复；
 * - 头部与代码区以细微 1px 分割线分离；
 * - 代码正文：内置轻量语法高亮，横向平滑滚动，保留缩进与换行，不硬性折行；
 * - 超过 [DEFAULT_FOLD_LINES] 行时折叠，底部给出「展开全部 N 行 / 收起」入口。
 */
@Composable
fun CodeCard(
    code: String,
    language: String? = null,
    modifier: Modifier = Modifier,
    maxHeightLines: Int = DEFAULT_FOLD_LINES,
) {
    val clipboardManager = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    var expanded by remember(code, language) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val copyBgColor by animateColorAsState(
        targetValue = if (copied) Color(0xFF1B382B) else Color(0xFF222436),
        animationSpec = tween(durationMillis = 200),
        label = "copyBgColor",
    )
    val copyFgColor by animateColorAsState(
        targetValue = if (copied) Color(0xFF4ED082) else Color(0xFFA9B1D6),
        animationSpec = tween(durationMillis = 200),
        label = "copyFgColor",
    )

    val cleanLang = language?.trim()?.takeIf { it.isNotBlank() && it.length <= 20 }
    val displayLang = cleanLang?.uppercase() ?: "CODE"

    // 🔴 折叠策略（对齐 DSH 上游 `CodeBlock.module.css` 的 maxLines 默认 16）。
    //
    // 旧实现有两个真问题：
    //  1. 默认 50 行 —— 30 行的代码块在手机上要滑好几屏，把会话流冲散；
    //  2. 超限时用 `maxLines + TextOverflow.Visible` 直接**静默截断**：
    //     既没有"还有更多"的提示，也没有展开入口，用户根本不知道下面还有内容。
    //     更糟的是行号列只画 `minOf(size, maxLines)` 行，与代码区可能错位。
    //
    // 现在：超过阈值给「展开全部 N 行 / 收起」按钮，且行号与可见行严格同源。
    val codeLines = remember(code) { code.split('\n') }
    val totalLines = codeLines.size
    val collapsible = totalLines > maxHeightLines
    val visibleLines = if (collapsible && !expanded) maxHeightLines else totalLines
    val showLineNumbers = totalLines > 1

    // 折叠时只渲染前 visibleLines 行，避免为看不见的内容做高亮与布局。
    val visibleCode = remember(code, visibleLines) {
        if (visibleLines >= totalLines) code else codeLines.take(visibleLines).joinToString("\n")
    }
    val highlightedText = remember(visibleCode, language) {
        CodeHighlighter.highlight(visibleCode, cleanLang)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF16161E))
            .border(1.dp, Color(0xFF2E303E), RoundedCornerShape(12.dp)),
    ) {

        // ── 头部栏 ──
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF1A1B26))
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            // 语言标签与行数
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .background(Color(0xFF24283B), RoundedCornerShape(5.dp))
                        .padding(horizontal = 7.dp, vertical = 2.5.dp),
                ) {
                    Text(
                        text = displayLang,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 11.sp,
                        color = Color(0xFF7AA2F7),
                        letterSpacing = 0.5.sp,
                    )
                }
                if (showLineNumbers) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "${codeLines.size} 行",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = Color(0xFF565F89),
                    )
                }
            }

            // 复制代码按钮（带即时反馈）
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(copyBgColor)
                    .clickable {
                        clipboardManager.setText(AnnotatedString(code))
                        copied = true
                        scope.launch {
                            delay(2000)
                            copied = false
                        }
                    }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DshIcon(
                    imageVector = if (copied) DshIcons.Check else DshIcons.Copy,
                    contentDescription = if (copied) "已复制" else "复制代码",
                    tint = copyFgColor,
                    size = 12.dp,
                )
                Spacer(Modifier.width(5.dp))
                Text(
                    text = if (copied) "已复制" else "复制",
                    style = MaterialTheme.typography.labelSmall,
                    color = copyFgColor,
                    fontWeight = FontWeight.Medium,
                    fontSize = 11.sp,
                )
            }
        }

        // 头部与正文分隔线
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Color(0xFF232534)),
        )

        // ── 代码正文（行号常驻左侧 + 代码独立横向滚动）──
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
        ) {
            if (showLineNumbers) {
                // 行号列（固定在左侧，不随代码横向滚动）
                // 🔴 必须与可见代码行严格同源，否则行号会和代码错位。
                Column(
                    modifier = Modifier
                        .padding(start = 12.dp)
                        .drawBehind {
                            drawLine(
                                color = Color(0xFF232534),
                                start = androidx.compose.ui.geometry.Offset(size.width, 0f),
                                end = androidx.compose.ui.geometry.Offset(size.width, size.height),
                                strokeWidth = 1.dp.toPx(),
                            )
                        }
                        .padding(end = 10.dp),
                    horizontalAlignment = Alignment.End,
                ) {
                    for (i in 1..visibleLines) {
                        Text(
                            text = "$i",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.5.sp,
                            lineHeight = 20.sp,
                            color = Color(0xFF4B526D),
                        )
                    }
                }
            }

            // 代码区域：横向平滑滚动
            Box(
                modifier = Modifier
                    .weight(1f)
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = if (showLineNumbers) 10.dp else 14.dp),
            ) {
                Text(
                    text = highlightedText,
                    style = DshTheme.codeTextStyle.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        lineHeight = 20.sp,
                    ),
                    softWrap = false,
                )
            }
        }

        // ── 折叠条：仅在代码超长时出现 ──
        if (collapsible) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(Color(0xFF232534)),
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                DshIcon(
                    imageVector = if (expanded) DshIcons.ChevronUp else DshIcons.ChevronDown,
                    contentDescription = null,
                    tint = Color(0xFF7AA2F7),
                    size = 14.dp,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = if (expanded) "收起" else "展开全部 $totalLines 行",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color(0xFF7AA2F7),
                    fontWeight = FontWeight.Medium,
                    fontSize = 11.5.sp,
                )
            }
        }
    }
}
