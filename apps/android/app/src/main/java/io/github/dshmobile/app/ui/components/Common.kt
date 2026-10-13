package io.github.dshmobile.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.dshmobile.app.ui.DshTheme

/**
 * 连接状态指示点。
 *
 * 「已连接」用呼吸动画而不是静态绿点 —— 静态点无法区分"连着"和"卡住了"。
 * 断线则保持灰且不闪，避免视觉噪音。
 */
@Composable
fun ConnectionDot(
    connected: Boolean,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 8.dp,
) {
    val color by animateColorAsState(
        targetValue = if (connected) DshTheme.online else DshTheme.offline,
        animationSpec = tween(400),
        label = "connDot",
    )
    val alpha = if (connected) {
        val t = rememberInfiniteTransition(label = "pulse")
        val v by t.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(tween(1100), RepeatMode.Reverse),
            label = "pulseAlpha",
        )
        v
    } else 1f

    Box(
        modifier
            .size(size)
            .alpha(alpha)
            .background(color, CircleShape),
    )
}

/** 状态胶囊：放在标题栏右侧，让"当前状态"一眼可见。 */
@Composable
fun StatusPill(
    text: String,
    connected: Boolean,
    modifier: Modifier = Modifier,
) {
    val bg by animateColorAsState(
        targetValue = if (connected) DshTheme.online.copy(alpha = 0.12f)
        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.10f),
        animationSpec = tween(400),
        label = "pillBg",
    )
    val fg by animateColorAsState(
        targetValue = if (connected) DshTheme.online else MaterialTheme.colorScheme.onSurfaceVariant,
        animationSpec = tween(400),
        label = "pillFg",
    )
    Row(
        modifier
            .background(bg, RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ConnectionDot(connected = connected, size = 6.dp)
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = fg,
        )
    }
}

/**
 * 空状态。
 *
 * 之前列表空了就是一片白，用户不知道是"没有会话"还是"加载失败"。
 * 这里强制要求传 `hint`（下一步该做什么），并且失败态有专门的图标与配红色。
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    hint: String,
    modifier: Modifier = Modifier,
    isError: Boolean = false,
    action: (@Composable () -> Unit)? = null,
) {
    val tint = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 32.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(56.dp)
                .background(tint.copy(alpha = 0.10f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(26.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            hint,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            action()
        }
    }
}

/** 错误空状态（`isError = true` 的快捷写法）。 */
@Composable
fun ErrorState(title: String, hint: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    EmptyState(Icons.Filled.ErrorOutline, title, hint, modifier, isError = true, action = action)
}

/**
 * 带边框的卡片底。
 *
 * Web 端的核心视觉手法：**不是用阴影，而是用 1px 边框 + 极浅的底色**区分层次。
 * 手机上阴影几乎看不见（屏幕小 + 高密度），所以边框才是有效的手段。
 */
@Composable
fun DshCard(
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val borderColor by animateColorAsState(
        targetValue = when {
            selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)
            else -> MaterialTheme.colorScheme.outlineVariant
        },
        animationSpec = tween(200),
        label = "cardBorder",
    )
    Box(
        modifier
            .fillMaxWidth()
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.05f)
                else MaterialTheme.colorScheme.surface,
                MaterialTheme.shapes.medium,
            )
            .border(1.dp, borderColor, MaterialTheme.shapes.medium)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
    ) { content() }
}

/** 小标签：用于会话来源、工具名这类元信息。 */
@Composable
fun MetaTag(
    text: String,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    background: Color = MaterialTheme.colorScheme.surfaceContainerHigh,
) {
    Box(
        modifier
            .background(background, RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 3.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = tint,
            maxLines = 1,
        )
    }
}

/** 分区标题（"子代理会话"这类分组头）。 */
@Composable
fun SectionHeader(text: String, count: Int, modifier: Modifier = Modifier) {
    Row(
        modifier.padding(horizontal = DshTheme.m.gutter, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (count > 0) {
            Text(
                "$count",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
        }
    }
}

/** 水平分隔线（Web 端是 `#e5e5e5` 那种极浅灰，不是默认的高对比线）。 */
@Composable
fun HairLine(modifier: Modifier = Modifier, inset: androidx.compose.ui.unit.Dp = 0.dp) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outlineVariant),
    )
}

@Composable
fun VSpace(height: androidx.compose.ui.unit.Dp) = Spacer(Modifier.height(height))

@Composable
fun HSpace(width: androidx.compose.ui.unit.Dp) = Spacer(Modifier.width(width))
