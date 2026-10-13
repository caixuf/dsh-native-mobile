package io.github.dshmobile.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.SessionRow
import io.github.dshmobile.app.ui.icons.DshIcons

/**
 * MiniMax 风格的极简侧边栏抽屉（AppDrawer）。
 *
 * 参照 MiniMax 原生抽屉与 Shadcn 极简工作台布局：
 * 1. 顶部 Header：DSH 品牌标识 + 状态小标 + 右侧关闭键；
 * 2. 核心导航组（对齐 MiniMax 连接电脑 / 资产 / 更多）：
 *    - 💻 我的电脑（在线呼吸灯、主机名、一键管理）；
 *    - 📁 工作区资产（当前会话关联代码库与产物）；
 *    - ⋯ 电脑与配对设置；
 * 3. 历史会话流：清晰的会话标题、工作区路径、选中高亮底色；
 * 4. 底部常驻黑曜石胶囊按钮（#171717）：一键新建会话。
 */
@Composable
fun AppDrawer(
    activeHostName: String?,
    isHostOnline: Boolean,
    sessions: List<SessionRow>,
    currentSessionId: String?,
    onSelectSession: (SessionRow) -> Unit,
    onNewSession: () -> Unit,
    onManageHosts: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ModalDrawerSheet(
        drawerContainerColor = MaterialTheme.colorScheme.surface,
        drawerContentColor = MaterialTheme.colorScheme.onSurface,
        modifier = modifier.width(312.dp),
    ) {
        Column(
            Modifier
                .fillMaxHeight()
                .padding(horizontal = 18.dp, vertical = 20.dp),
        ) {
            // ── 1. 顶部品牌与关闭键 ──
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(38.dp)
                            .background(
                                MaterialTheme.colorScheme.primaryContainer,
                                RoundedCornerShape(12.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        DshIcon(
                            DshIcons.Desktop,
                            contentDescription = null,
                            size = 20.dp,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(
                            text = "DSH 原生遥控",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            text = "手机遥控 · 电脑执行",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        )
                    }
                }

                IconButton(
                    onClick = onClose,
                    modifier = Modifier.size(34.dp),
                ) {
                    DshIcon(
                        DshIcons.Close,
                        contentDescription = "关闭抽屉",
                        size = 18.dp,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))

            // ── 2. MiniMax 风格三大主导航入口 ──
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // (1) 我的电脑
                DrawerNavItem(
                    icon = DshIcons.Desktop,
                    title = activeHostName?.ifBlank { "我的电脑" } ?: "未连接电脑",
                    subtitle = if (isHostOnline) "远程守护进程在线" else "点击连接或切换电脑",
                    statusDot = if (isHostOnline) DshTheme.online else MaterialTheme.colorScheme.error,
                    trailingText = "切换",
                    onClick = onManageHosts,
                )

                // (2) 工作区资产
                val activeWorkspace = sessions.firstOrNull { it.sessionId == currentSessionId }?.workspace
                    ?: sessions.firstOrNull()?.workspace
                DrawerNavItem(
                    icon = DshIcons.Folder,
                    title = "工作区资产",
                    subtitle = if (!activeWorkspace.isNullOrBlank()) {
                        activeWorkspace.substringAfterLast('/').substringAfterLast('\\')
                    } else "暂无活跃工作区",
                    onClick = {},
                )

                // (3) 更多设置
                DrawerNavItem(
                    icon = DshIcons.MoreHorizontal,
                    title = "设备与配对",
                    subtitle = "管理受信任电脑 / 6位数字码",
                    onClick = onManageHosts,
                )
            }

            Spacer(Modifier.height(14.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f))
            Spacer(Modifier.height(12.dp))

            // ── 3. 历史会话分组 ──
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "会话历史",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHighest,
                    shape = RoundedCornerShape(10.dp),
                ) {
                    Text(
                        text = "${sessions.size}",
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            if (sessions.isEmpty()) {
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        DshIcon(
                            DshIcons.ChatBubble,
                            contentDescription = null,
                            size = 28.dp,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = "暂无活跃会话",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                        )
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(sessions, key = { it.sessionId }) { row ->
                        val isSelected = row.sessionId == currentSessionId
                        DrawerSessionRow(
                            session = row,
                            isSelected = isSelected,
                            onClick = { onSelectSession(row) },
                        )
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f))
            Spacer(Modifier.height(14.dp))

            // ── 4. 底部黑曜石胶囊新建按键（对齐 MiniMax 底部突出按钮） ──
            Surface(
                color = Color(0xFF171717),
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .clickable { onNewSession() },
            ) {
                Row(
                    Modifier.fillMaxSize(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    DshIcon(
                        DshIcons.Add,
                        contentDescription = null,
                        size = 18.dp,
                        tint = Color.White,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "新建会话",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                    )
                }
            }

            Spacer(Modifier.height(10.dp))

            // 底部技术标识
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "DSH Native Mobile",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                )
                Text(
                    text = "100% 原生 Kotlin · 零 WebView",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.8f),
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

/**
 * 侧边栏主导航条目（MiniMax 风格的轻量图标行）。
 */
@Composable
private fun DrawerNavItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    subtitle: String,
    statusDot: Color? = null,
    trailingText: String? = null,
    onClick: () -> Unit,
) {
    Surface(
        color = Color.Transparent,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(32.dp)
                    .background(
                        MaterialTheme.colorScheme.surfaceContainerHigh,
                        RoundedCornerShape(8.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                DshIcon(
                    imageVector = icon,
                    contentDescription = null,
                    size = 18.dp,
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }

            Spacer(Modifier.width(12.dp))

            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (statusDot != null) {
                        Box(
                            Modifier
                                .size(7.dp)
                                .background(statusDot, CircleShape),
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        text = title,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (trailingText != null) {
                Text(
                    text = trailingText,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

/**
 * 侧边栏历史会话行。
 */
@Composable
private fun DrawerSessionRow(
    session: SessionRow,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        color = if (isSelected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.65f)
        else Color.Transparent,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isSelected) {
                Box(
                    Modifier
                        .size(4.dp, 16.dp)
                        .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)),
                )
                Spacer(Modifier.width(8.dp))
            } else {
                DshIcon(
                    imageVector = DshIcons.ChatBubble,
                    contentDescription = null,
                    size = 14.dp,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                )
                Spacer(Modifier.width(8.dp))
            }

            Column(Modifier.weight(1f)) {
                Text(
                    text = session.title.ifBlank { "未命名会话" },
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                    color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer
                    else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val ws = session.workspace
                if (!ws.isNullOrBlank()) {
                    Text(
                        text = ws.substringAfterLast('/').substringAfterLast('\\'),
                        style = MaterialTheme.typography.labelSmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.5.sp,
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
