package io.github.dshmobile.app.ui.components

import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.dshmobile.app.ui.DshTheme

/**
 * 图标渲染器。
 *
 * `DshIcons` 里的图标是**单色**的（填充/描边都用黑色），颜色必须由这里按主题注入 ——
 * 否则在暗色模式下图标会是黑底黑线，完全看不见。
 *
 * 这条规矩对应上游 MiniMax 的做法：它的 vector 也不设 `android:tint`，
 * 而是直接引用 `@color/icon_default_inverted` 这类语义色，暗色自动取反。
 * 我们在 Compose 侧用 `LocalContentColor` 等价实现。
 *
 * @param tint 图标颜色；不传则用当前内容色。
 */
@Composable
fun DshIcon(
    imageVector: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = LocalContentColorOrDefault(),
    size: Dp = 20.dp,
) {
    Icon(
        imageVector = imageVector,
        contentDescription = contentDescription,
        tint = tint,
        modifier = modifier.size(size),
    )
}

/** 取当前内容色，缺省回落到主文字色。 */
@Composable
private fun LocalContentColorOrDefault(): Color =
    androidx.compose.material3.LocalContentColor.current
