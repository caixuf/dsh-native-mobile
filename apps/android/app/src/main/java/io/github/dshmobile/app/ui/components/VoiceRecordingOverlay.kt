package io.github.dshmobile.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dshmobile.app.ui.icons.DshIcons

/**
 * MiniMax 风格的按住说话动态波纹与转写浮层。
 *
 * 用户按住麦克风按钮时升起：
 *  - 实时根据麦克风分贝（rmsLevel）律动 7 根声波柱；
 *  - 实时呈现正在识别出的语音字幕；
 *  - 上滑触发取消时变红警示；
 *  - 松手即刻将文字转写填入输入区并发给电脑。
 */
@Composable
fun VoiceRecordingOverlay(
    isListening: Boolean,
    isCancelling: Boolean,
    liveTranscript: String,
    rmsLevel: Float,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = isListening,
        enter = fadeIn(tween(180)) + slideInVertically(tween(180)) { it / 2 },
        exit = fadeOut(tween(150)) + slideOutVertically(tween(150)) { it / 2 },
        modifier = modifier,
    ) {
        Surface(
            color = if (isCancelling) MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.95f)
            else MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.95f),
            shape = RoundedCornerShape(20.dp),
            shadowElevation = 8.dp,
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                if (isCancelling) MaterialTheme.colorScheme.error.copy(alpha = 0.4f)
                else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 6.dp),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp, vertical = 14.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // ── 顶部声波律动 ──
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    val baseBars = listOf(0.4f, 0.7f, 1.0f, 0.6f, 0.9f, 0.5f, 0.8f)
                    baseBars.forEachIndexed { index, weight ->
                        val barHeight by animateDpAsState(
                            targetValue = (10.dp + (26.dp * (rmsLevel * weight).coerceIn(0.1f, 1.2f))),
                            label = "waveBar-$index",
                        )
                        Box(
                            Modifier
                                .width(4.dp)
                                .height(barHeight)
                                .clip(CircleShape)
                                .background(
                                    if (isCancelling) MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.primary,
                                ),
                        )
                    }
                }

                Spacer(Modifier.height(10.dp))

                // ── 实时语音转写文字 ──
                Text(
                    text = liveTranscript.ifBlank { "正在聆听你的指令…" },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (liveTranscript.isNotBlank()) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (isCancelling) MaterialTheme.colorScheme.onErrorContainer
                    else if (liveTranscript.isNotBlank()) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    textAlign = TextAlign.Center,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(8.dp))

                // ── 状态指引提示 ──
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Box(
                        Modifier
                            .size(6.dp)
                            .background(
                                if (isCancelling) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.primary,
                                CircleShape,
                            ),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = if (isCancelling) "松开手指，取消发送" else "松开发送 · 向上滑动取消",
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                        fontWeight = FontWeight.Medium,
                        color = if (isCancelling) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    )
                }
            }
        }
    }
}
