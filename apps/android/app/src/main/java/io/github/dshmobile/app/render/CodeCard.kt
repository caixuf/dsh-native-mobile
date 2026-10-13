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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.icons.DshIcons
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 生产级代码卡片组件（对齐 DSH Web `CodeCard.module.css` 规范）。
 *
 * ## 视觉设计细节：
 * - 纯深色底（暗黑终端质感 `#16161E`），圆角 12.dp，1px 细微暗态边框；
 * - 顶部头部栏：
 *   - 左侧：编程语言微徽标（如 `KOTLIN`, `SHELL`, `JSON`），等宽大写字；
 *   - 右侧：一键复制代码按钮，点击瞬间切为绿色勾选态并显示「已复制」，2 秒后自动恢复；
 * - 头部与代码区以细微 1px 分割线分离；
 * - 代码正文：内置轻量语法高亮，横向平滑滚动，保留缩进与换行，不硬性折行。
 */
@Composable
fun CodeCard(
    code: String,
    language: String? = null,
    modifier: Modifier = Modifier,
    maxHeightLines: Int = 50,
) {
    val clipboardManager = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
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

    val highlightedText = remember(code, language) {
        CodeHighlighter.highlight(code, cleanLang)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF16161E))
            .border(1.dp, Color(0xFF2E303E), RoundedCornerShape(12.dp)),
    ) {
        val codeLines = remember(code) { code.split('\n') }
        val showLineNumbers = codeLines.size > 1

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
                val count = minOf(codeLines.size, maxHeightLines)
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
                    for (i in 1..count) {
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
                    maxLines = maxHeightLines,
                    overflow = TextOverflow.Visible,
                )
            }
        }
    }
}
