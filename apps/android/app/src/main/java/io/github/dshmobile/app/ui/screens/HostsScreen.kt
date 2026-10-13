package io.github.dshmobile.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.dshmobile.app.net.LinkState
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.HostsUiState
import io.github.dshmobile.app.ui.SessionRow
import io.github.dshmobile.app.ui.components.ConnectionDot
import io.github.dshmobile.app.ui.components.EmptyState
import io.github.dshmobile.app.ui.components.StatusPill

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostsScreen(
    state: HostsUiState,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onReconnect: () -> Unit,
    onAdd: () -> Unit,
) {
    val snackbar = remember { SnackbarHostState() }
    var pendingForget by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(state.notice) {
        state.notice?.let { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(state.error) {
        state.error?.let { snackbar.showSnackbar(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            "我的电脑",
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
                actions = {
                    IconButton(onClick = onReconnect) {
                        Icon(
                            Icons.Default.Refresh,
                            contentDescription = "重新连接",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onAdd,
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                shape = MaterialTheme.shapes.large,
            ) {
                Icon(Icons.Default.Add, contentDescription = null)
                Spacer(Modifier.width(DshTheme.m.sm))
                Text("配对电脑", style = MaterialTheme.typography.labelLarge)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            LinkRow(state.link)

            if (state.hosts.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("还没有配对任何电脑", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "在电脑上打开 DSH 的「移动网关」面板，点「刷新配对码」，然后用下面的按钮扫码或手输。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(state.hosts, key = { it.id }) { host ->
                        HostCard(
                            label = host.label,
                            url = host.baseUrl,
                            active = host.id == state.activeId,
                            link = if (host.id == state.activeId) state.link else LinkState.Disconnected,
                            onClick = { onOpen(host.id) },
                            onForget = { pendingForget = host.id },
                        )
                    }
                    item { Spacer(Modifier.height(88.dp)) }
                }
            }
        }
    }

    pendingForget?.let { id ->
        AlertDialog(
            onDismissRequest = { pendingForget = null },
            title = { Text("移除这台电脑？") },
            text = { Text("只会删掉本机保存的令牌。电脑端仍记得这台设备，需要在那里也吊销一次。") },
            confirmButton = {
                TextButton(onClick = { onForget(id); pendingForget = null }) { Text("移除") }
            },
            dismissButton = { TextButton(onClick = { pendingForget = null }) { Text("取消") } },
        )
    }
}

/** 连接状态行：改成胶囊，紧跟标题，不再是飘着的一行小字。 */
@Composable
private fun LinkRow(link: LinkState) {
    val (text, ok) = when (link) {
        is LinkState.Ready -> "已连接" to true
        is LinkState.Connecting -> "连接中" to false
        is LinkState.Degraded -> "重连中" to false
        LinkState.Disconnected -> "未连接" to false
    }
    Row(
        Modifier.padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusPill(text, ok)
        if (link is LinkState.Ready && link.hostName.isNotBlank()) {
            Spacer(Modifier.width(DshTheme.m.sm))
            Text(
                link.hostName,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (link is LinkState.Degraded) {
            Spacer(Modifier.width(DshTheme.m.sm))
            Text(
                link.reason,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * 电脑卡片。
 *
 * 关键改动（对齐 MiniMax：1px 边框分层，不靠阴影）：
 *  - 当前选中的用**边框高亮 + 浅蓝底**，而不是整块填充成 primaryContainer
 *    （之前那块大蓝底又重又廉价，是"界面很丑"最直接的来源）
 *  - 连接状态用小圆点表达，不占一整行
 *  - 地址用等宽字体，技术信息更易扫读
 */
@Composable
private fun HostCard(
    label: String,
    url: String,
    active: Boolean,
    link: LinkState,
    onClick: () -> Unit,
    onForget: () -> Unit,
) {
    val borderColor = if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)
    else MaterialTheme.colorScheme.outlineVariant

    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.04f)
                else MaterialTheme.colorScheme.surface,
                MaterialTheme.shapes.medium,
            )
            .border(1.dp, borderColor, MaterialTheme.shapes.medium)
            .clickable(onClick = onClick)
            .padding(horizontal = DshTheme.m.lg, vertical = DshTheme.m.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ConnectionDot(connected = link is LinkState.Ready)
            Spacer(Modifier.width(DshTheme.m.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = label,
                    fontWeight = FontWeight.Medium,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = url,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onForget, modifier = Modifier.size(36.dp)) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = "移除这台电脑",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(17.dp),
                )
            }
        }
    }
}