package io.github.dshmobile.app.ui.screens

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.dshmobile.app.net.LinkState
import io.github.dshmobile.app.ui.HostsUiState
import io.github.dshmobile.app.ui.SessionRow

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
                title = { Text("我的电脑") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
                actions = {
                    IconButton(onClick = onReconnect) {
                        Icon(Icons.Default.Refresh, contentDescription = "重新连接")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = onAdd) {
                Icon(Icons.Default.Add, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("配对电脑")
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

@Composable
private fun LinkRow(link: LinkState) {
    val (text, color) = when (link) {
        is LinkState.Ready -> "已连接 · ${link.hostName.ifBlank { "本机" }}" to MaterialTheme.colorScheme.secondary
        is LinkState.Connecting -> "连接中…" to MaterialTheme.colorScheme.onSurfaceVariant
        is LinkState.Degraded -> "重连中：${link.reason}" to MaterialTheme.colorScheme.error
        LinkState.Disconnected -> "未连接" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun HostCard(
    label: String,
    url: String,
    active: Boolean,
    link: LinkState,
    onClick: () -> Unit,
    onForget: () -> Unit,
) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (active) MaterialTheme.colorScheme.primaryContainer
            else MaterialTheme.colorScheme.surface,
        ),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = label,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = url,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onForget) {
                Icon(Icons.Default.Delete, contentDescription = "移除")
            }
        }
    }
}