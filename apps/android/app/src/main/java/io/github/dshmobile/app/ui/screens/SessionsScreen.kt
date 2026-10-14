package io.github.dshmobile.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import io.github.dshmobile.app.ui.AmbientWallpaper
import io.github.dshmobile.app.ui.GlassCard
import io.github.dshmobile.app.ui.PulseDot
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.dshmobile.app.net.LinkState
import io.github.dshmobile.app.ui.icons.DshIcons
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.SessionRow
import io.github.dshmobile.app.ui.SessionsViewModel
import io.github.dshmobile.app.ui.WorkspaceGroup
import io.github.dshmobile.app.ui.WorkspaceFormatter
import io.github.dshmobile.app.ui.components.EmptyState
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.components.MetaTag
import io.github.dshmobile.app.ui.components.StatusPill
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 会话列表。
 *
 * 设计取自逆向 MiniMax 移动端（shadcn/ui 体系）的做法：
 *  - 卡片靠 **1px 边框 + 纯白底** 分层，**不用阴影**（手机上阴影几乎看不见）
 *  - 主体字号 14（对齐 MiniMax 的 14px 主力字号）
 *  - 圆角 12（映射到 Compose `shapes.medium`）
 *  - 顶部状态用胶囊而非裸文字，把「连没连上」变成一眼可读的状态
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    linkState: LinkState,
    onOpen: (SessionRow) -> Unit,
    vm: SessionsViewModel,
    onOpenDrawer: (() -> Unit)? = null,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var searchOpen by remember { mutableStateOf(false) }
    var showCreateDialog by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (onOpenDrawer != null) {
                        IconButton(onClick = onOpenDrawer) {
                            DshIcon(
                                DshIcons.Menu,
                                contentDescription = "打开抽屉",
                                tint = MaterialTheme.colorScheme.onBackground,
                                size = 22.dp,
                            )
                        }
                    }
                },
                title = {
                    Column {
                        Text(
                            "会话",
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                        // 状态紧跟标题，比原来那一行飘着的文字更紧凑
                        StatusPill(linkLabel(linkState), linkState.isHealthy())
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    titleContentColor = MaterialTheme.colorScheme.onBackground,
                    actionIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                ),
                actions = {
                    IconButton(onClick = {
                        searchOpen = !searchOpen
                        if (!searchOpen) vm.search("")
                    }) {
                        DshIcon(
                            if (searchOpen) DshIcons.Close else DshIcons.Search,
                            contentDescription = if (searchOpen) "关闭搜索" else "搜索",
                        )
                    }
                    IconButton(onClick = { vm.toggleSubagents() }) {
                        DshIcon(
                            if (state.showSubagents) DshIcons.EyeOff
                            else DshIcons.Eye,
                            contentDescription = "显示/隐藏子代理会话",
                        )
                    }
                    IconButton(onClick = { vm.load() }) {
                        DshIcon(DshIcons.Refresh, contentDescription = "刷新")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = {
                    val workspaces = state.rows.mapNotNull { it.workspace }.filter { it.isNotBlank() }.distinct()
                    if (workspaces.isNotEmpty()) {
                        showCreateDialog = true
                    } else {
                        vm.create(null) { row -> onOpen(row) }
                    }
                },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                shape = MaterialTheme.shapes.large,
            ) {
                DshIcon(DshIcons.Add, contentDescription = null)
                Spacer(Modifier.width(DshTheme.m.sm))
                Text("新会话", style = MaterialTheme.typography.labelLarge)
            }
        },
    ) { padding ->
        AmbientWallpaper(Modifier.padding(padding)) {
            Column(Modifier.fillMaxSize()) {

            // 搜索框：动画展开，避免每次都占用固定视觉空间
            AnimatedVisibility(
                visible = searchOpen,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically(),
            ) {
                OutlinedTextField(
                    value = state.query,
                    onValueChange = { vm.search(it) },
                    placeholder = {
                        Text(
                            "搜索会话标题",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    singleLine = true,
                    shape = MaterialTheme.shapes.medium,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.primary,
                        unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.sm),
                )
            }

            // 断线提示做成醒目横幅，而不是一行灰色小字
            AnimatedVisibility(visible = !linkState.isHealthy()) {
                LinkWarning(linkState)
            }

            state.error?.let { error ->
                SurfaceBanner(text = error, tone = BannerTone.Error)
            }

            when {
                state.loading && state.rows.isEmpty() -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(28.dp),
                            strokeWidth = 2.5.dp,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.height(DshTheme.m.md))
                        Text(
                            "正在读取会话…",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                state.rows.isEmpty() && state.query.isNotBlank() -> EmptyState(
                    icon = DshIcons.ChatBubble,
                    title = "没有匹配的会话",
                    hint = "换个关键词试试，或者清空搜索框看全部。",
                )

                state.rows.isEmpty() -> EmptyState(
                    icon = DshIcons.ChatBubble,
                    title = "这台电脑上还没有会话",
                    hint = "点右下角「新会话」，或在电脑上开一个再回来刷新。",
                )

                else -> LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = DshTheme.m.gutter,
                        end = DshTheme.m.gutter,
                        top = DshTheme.m.sm,
                        bottom = 96.dp, // 给 FAB 让位
                    ),
                    verticalArrangement = Arrangement.spacedBy(DshTheme.m.listGap),
                ) {
                    // 🖥️ 远程电脑设备仪表板卡片 —— 强化「手机遥控电脑」产品心智
                    item(key = "remote-dashboard-header") {
                        RemoteHostDashboardCard(
                            linkState = linkState,
                            workspaceCount = state.workspaceGroups.size,
                            sessionCount = state.rows.size,
                            runningCount = state.workspaceGroups.sumOf { it.runningCount },
                        )
                        Spacer(Modifier.height(DshTheme.m.xs))
                    }

                    // 🔴 会话/工作区树（P1）：可折叠父节点，组内按活跃时间与运行态排序
                    state.workspaceGroups.forEach { group ->
                        val isExpanded = state.expandedWorkspaces.contains(group.cwd)
                        item(key = "ws-header-${group.cwd ?: "none"}") {
                            WorkspaceHeader(
                                group = group,
                                isExpanded = isExpanded,
                                onToggle = { vm.toggleWorkspace(group.cwd) },
                            )
                        }

                        if (isExpanded) {
                            items(group.sessions, key = { it.sessionId }) { row ->
                                SessionCard(row) { onOpen(row) }
                            }

                            // 子代理会话归入所属工作区（Task 11）
                            if (state.showSubagents && group.subagents.isNotEmpty()) {
                                item(key = "ws-subagent-header-${group.cwd ?: "none"}") {
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .padding(start = 12.dp, top = 6.dp, bottom = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        DshIcon(
                                            DshIcons.Eye,
                                            contentDescription = null,
                                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                            size = 13.dp,
                                        )
                                        Spacer(Modifier.width(6.dp))
                                        Text(
                                            text = "工作区子代理会话 · ${group.subagents.size}",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                                items(group.subagents, key = { "sa-${it.sessionId}" }) { row ->
                                    SubagentCard(row)
                                }
                            }
                        }
                    }
                }
            }

            if (showCreateDialog) {
                val availableWorkspaces = remember(state.workspaceGroups) {
                    state.workspaceGroups.mapNotNull { it.cwd }.filter { it.isNotBlank() }.distinct()
                }
                var selectedWorkspace by remember { mutableStateOf<String?>(availableWorkspaces.firstOrNull()) }
                var customWorkspaceInput by remember { mutableStateOf("") }
                var isCustom by remember { mutableStateOf(false) }

                androidx.compose.material3.AlertDialog(
                    onDismissRequest = { showCreateDialog = false },
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            DshIcon(DshIcons.Desktop, contentDescription = null, size = 20.dp, tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(8.dp))
                            Text("新建工作区会话", style = MaterialTheme.typography.titleMedium)
                        }
                    },
                    text = {
                        Column {
                            Text(
                                "选择此会话在电脑上执行的目标工作区：",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(10.dp))

                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                WorkspacePickOption(
                                    title = "电脑默认工作区",
                                    path = "使用远端 DSH 宿主默认路径",
                                    selected = !isCustom && selectedWorkspace == null,
                                    onClick = {
                                        isCustom = false
                                        selectedWorkspace = null
                                    },
                                )

                                availableWorkspaces.forEach { ws ->
                                    val (name, _) = WorkspaceFormatter.format(ws)
                                    WorkspacePickOption(
                                        title = name,
                                        path = ws,
                                        selected = !isCustom && selectedWorkspace == ws,
                                        onClick = {
                                            isCustom = false
                                            selectedWorkspace = ws
                                        },
                                    )
                                }

                                WorkspacePickOption(
                                    title = "指定新路径…",
                                    path = if (isCustom && customWorkspaceInput.isNotBlank()) customWorkspaceInput else "输入宿主电脑绝对路径或 WSL 路径",
                                    selected = isCustom,
                                    onClick = { isCustom = true },
                                )

                                if (isCustom) {
                                    OutlinedTextField(
                                        value = customWorkspaceInput,
                                        onValueChange = { customWorkspaceInput = it },
                                        placeholder = {
                                            Text(
                                                """例如 C:\code\repo 或 \\wsl.localhost\Ubuntu\...""",
                                                style = MaterialTheme.typography.bodySmall,
                                            )
                                        },
                                        singleLine = true,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                            }
                        }
                    },
                    confirmButton = {
                        TextButton(
                            onClick = {
                                showCreateDialog = false
                                val targetCwd = if (isCustom) customWorkspaceInput.trim().ifBlank { null } else selectedWorkspace
                                vm.create(cwd = targetCwd) { onOpen(it) }
                            },
                        ) {
                            Text("创建并进入")
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showCreateDialog = false }) {
                            Text("取消")
                        }
                    },
                )
            }
        }
    }
}
}

// ── 子组件 ──────────────────────────────────────────────────────────────────

@Composable
private fun RemoteHostDashboardCard(
    linkState: LinkState,
    workspaceCount: Int,
    sessionCount: Int,
    runningCount: Int,
) {
    val hostName = (linkState as? LinkState.Ready)?.hostName?.takeIf { it.isNotBlank() } ?: "我的电脑"
    val isOnline = linkState.isHealthy()

    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        backgroundColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
        borderColor = if (isOnline) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)
                     else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(36.dp)
                            .background(
                                if (isOnline) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.8f)
                                else MaterialTheme.colorScheme.surfaceContainerHighest,
                                RoundedCornerShape(10.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        DshIcon(
                            DshIcons.Desktop,
                            contentDescription = null,
                            tint = if (isOnline) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            size = 19.dp,
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = hostName,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Spacer(Modifier.width(6.dp))
                            PulseDot(
                                color = if (isOnline) DshTheme.online else MaterialTheme.colorScheme.outline,
                                size = 6.dp,
                                pulseScale = if (isOnline) 2.0f else 1.0f,
                            )
                        }
                        Text(
                            text = if (isOnline) "远程守护进程在线 · 实时协同中枢" else "未连接到电脑守护进程",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isOnline) DshTheme.online else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        )
                    }
                }

                Surface(
                    shape = RoundedCornerShape(20.dp),
                    color = if (isOnline) DshTheme.online.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceContainerHighest,
                    border = androidx.compose.foundation.BorderStroke(1.dp, if (isOnline) DshTheme.online.copy(alpha = 0.3f) else MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Text(
                        text = if (isOnline) "活跃" else "离线",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = if (isOnline) DshTheme.online else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            // 3 Bento Metric Capsules
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                DashboardPill(
                    icon = DshIcons.Folder,
                    count = "$workspaceCount",
                    label = "工作区",
                    modifier = Modifier.weight(1f),
                )
                DashboardPill(
                    icon = DshIcons.ChatBubble,
                    count = "$sessionCount",
                    label = "会话",
                    modifier = Modifier.weight(1f),
                )
                DashboardPill(
                    icon = DshIcons.Cpu,
                    count = if (runningCount > 0) "$runningCount" else "0",
                    label = if (runningCount > 0) "任务运行中" else "待命中",
                    highlight = runningCount > 0,
                    modifier = Modifier.weight(1.15f),
                )
            }
        }
    }
}

@Composable
private fun DashboardPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    count: String,
    label: String,
    highlight: Boolean = false,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        color = if (highlight) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f)
                else MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.65f),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (highlight) MaterialTheme.colorScheme.primary.copy(alpha = 0.4f)
            else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f),
        ),
    ) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DshIcon(
                imageVector = icon,
                contentDescription = null,
                tint = if (highlight) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Column {
                Text(
                    text = count,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    color = if (highlight) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.5.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun WorkspacePickOption(
    title: String,
    path: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)
                else MaterialTheme.colorScheme.surfaceContainerHigh,
            )
            .border(
                1.dp,
                if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                RoundedCornerShape(8.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DshIcon(
            imageVector = DshIcons.Folder,
            contentDescription = null,
            tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            size = 16.dp,
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = path,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (selected) {
            DshIcon(
                imageVector = DshIcons.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                size = 16.dp,
            )
        }
    }
}

private fun LinkState.isHealthy(): Boolean = this is LinkState.Ready

private fun linkLabel(s: LinkState): String = when (s) {
    is LinkState.Ready -> "已连接"
    is LinkState.Connecting -> "连接中"
    is LinkState.Degraded -> "重连中"
    LinkState.Disconnected -> "未连接"
}

/** 断线横幅。颜色用 error 色，但**不加粗 screaming red**，保持克制。 */
@Composable
private fun LinkWarning(linkState: LinkState) {
    val (text, tone) = when (linkState) {
        is LinkState.Ready -> return
        is LinkState.Connecting -> "正在连接电脑…" to BannerTone.Info
        is LinkState.Degraded -> "连接中断，正在重连：${linkState.reason}" to BannerTone.Warn
        LinkState.Disconnected -> "未连接到电脑。请检查电脑上的 DSH 是否在运行。" to BannerTone.Error
    }
    SurfaceBanner(text, tone)
}

private enum class BannerTone { Info, Warn, Error }

/** 统一的横幅组件：错误、断线、提示都用它，保证视觉一致。 */
@Composable
private fun SurfaceBanner(
    text: String,
    tone: BannerTone,
    onDismiss: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val (bg, fg) = when (tone) {
        BannerTone.Error -> scheme.errorContainer to scheme.onErrorContainer
        BannerTone.Warn -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        BannerTone.Info -> scheme.primaryContainer to scheme.onPrimaryContainer
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.xs)
            .background(bg, MaterialTheme.shapes.small)
            .padding(horizontal = DshTheme.m.md, vertical = DshTheme.m.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = fg,
            modifier = Modifier.weight(1f),
        )
        if (onDismiss != null) {
            IconButton(onClick = onDismiss, modifier = Modifier.size(24.dp)) {
                DshIcon(
                    DshIcons.Close,
                    contentDescription = "关闭",
                    tint = fg,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
    }
}

/**
 * 工作区分组标题与折叠卡片（P1）。
 *
 * 参照客户端与 MiniMax 工作台折叠树：
 * - 明确的工作区名称（WSL 友好名 / Windows 盘符路径名）
 * - 运行中徽标（如果有运行中的会话）
 * - 会话与子代理计数
 * - 折叠/展开箭头与点击反馈
 */
@Composable
private fun WorkspaceHeader(
    group: WorkspaceGroup,
    isExpanded: Boolean,
    onToggle: () -> Unit,
) {
    Surface(
        onClick = onToggle,
        shape = RoundedCornerShape(12.dp),
        color = if (group.isRunning) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f)
        else MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = DshTheme.m.sm, bottom = 2.dp)
            .border(
                1.dp,
                if (group.isRunning) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)
                else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
                RoundedCornerShape(12.dp),
            ),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    // `weight(1f)`（fill 默认 true）：内层精确吃满「除右侧时间/箭头之外」
                    // 的全部宽度。**不能写 `fill = false`** —— 那会让内层宽度不受
                    // 外层 `SpaceBetween` 约束，于是右侧的时间紧贴在计数文字后面
                    // （模拟器实测：「2 会话 · 6 子代理14 分钟前」粘成一坨）。
                    modifier = Modifier.weight(1f),
                ) {
                    DshIcon(
                        DshIcons.Folder,
                        contentDescription = null,
                        tint = if (group.isRunning) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        size = 18.dp,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = group.displayName,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        // 🔴 名字负责**吸收挤压**（2026-10-14 模拟器实测第二轮修正）。
                        //
                        // Compose 的 Row 里，带 weight 的子项**最后**测量：徽章与计数
                        // 先按固有宽度占位，剩下的才归名字，名字过长时自己省略。
                        //
                        // 上一轮我把 weight 加在了**内层 Row 自身**上并配 `fill = false`，
                        // 那是错的 —— 内层不受外层约束，右侧时间就贴上来了。
                        // weight 要用在**名字**上，让信息层级正确：组名 > 计数 > 时间。
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.width(8.dp))
                    if (group.isRunning) {
                        MetaTag(
                            text = "运行中 ${group.runningCount}",
                            tint = MaterialTheme.colorScheme.primary,
                            background = MaterialTheme.colorScheme.primaryContainer,
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        text = buildString {
                            append("${group.sessions.size} 会话")
                            if (group.subagents.isNotEmpty()) {
                                append(" · ${group.subagents.size} 子代理")
                            }
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                        // 🔴 单行 + 省略号（2026-10-14 真机发现）。
                        //
                        // 这是 Row 里最后一个子项。当前面多出「运行中 N」徽章时，
                        // 剩余宽度可能被挤到接近 0，Compose 会把每个汉字**单独折行**
                        // ——真机表现为「2 会话 · 5 子代理」竖排成 7 行，非常难看。
                        // 加 maxLines/overflow 后最差也只是省略号。
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    // 计数与右侧时间之间的保底间距。
                    //
                    // 内层 Row 现在带 `weight(1f)` 会吃满剩余宽度，若最右子项不参与
                    // 挤压，时间就会**紧贴**在「子代理」后面（模拟器实测：
                    // 「2 会话 · 6 子代理14 分钟前」粘成一坨）。这里给一段固定间距，
                    // 保证即使计数占满也有视觉分隔。
                    Spacer(Modifier.width(8.dp))
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (group.latestUpdatedAt > 0) {
                        Text(
                            text = relativeTime(group.latestUpdatedAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    DshIcon(
                        if (isExpanded) DshIcons.ChevronUp else DshIcons.ChevronDown,
                        contentDescription = if (isExpanded) "折叠" else "展开",
                        size = 16.dp,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (group.subtitle.isNotBlank() && group.subtitle != group.displayName) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = group.subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** 路径只显示最后两段。 */
private fun shortPath(path: String, keep: Int = 2): String {
    val normalized = path.replace('\\', '/').trimEnd('/')
    val parts = normalized.split('/').filter { it.isNotBlank() }
    if (parts.size <= keep) return normalized
    return "…/" + parts.takeLast(keep).joinToString("/")
}

@Composable
private fun SubagentHeader(count: Int) {
    Row(
        modifier = Modifier.padding(top = DshTheme.m.md, bottom = DshTheme.m.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(DshTheme.m.sm),
    ) {
        Text(
            "子代理会话",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        MetaTag("$count")
        Text(
            "· 需从父会话进入",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * 会话卡片。
 *
 * 关键改动：
 *  - **有边框、无阴影**（MiniMax 的做法；M3 默认 Card 带阴影，在浅底上显脏）
 *  - 标题与时间**同一行**，时间右对齐 —— 之前是纯文本列表，扫读时找不到重点
 *  - 标题 1 行截断，底部一行元信息（来源/状态），保证每张卡等高
 */
@Composable
private fun SessionCard(row: SessionRow, onClick: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (row.running) MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)
            else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 11.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (row.running) {
                    PulseDot(
                        color = MaterialTheme.colorScheme.primary,
                        size = 6.dp,
                        pulseScale = 2.0f,
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = row.title.ifBlank { "（无标题会话）" },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = relativeTime(row.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    maxLines = 1,
                )
            }

            val preview = row.preview.trim()
            if (preview.isNotBlank()) {
                Spacer(Modifier.height(5.dp))
                Text(
                    text = preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (row.running) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    MetaTag(
                        text = "● 任务运行中",
                        tint = MaterialTheme.colorScheme.primary,
                        background = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.7f),
                    )
                }
            }
        }
    }
}

@Composable
private fun SubagentCard(row: SessionRow) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.surfaceContainerHigh,
                MaterialTheme.shapes.medium,
            )
            .padding(horizontal = DshTheme.m.lg, vertical = DshTheme.m.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(28.dp)
                .background(MaterialTheme.colorScheme.outlineVariant, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            DshIcon(
                DshIcons.ChatBubble,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(15.dp),
            )
        }
        Spacer(Modifier.width(DshTheme.m.md))
        Column(Modifier.weight(1f)) {
            Text(
                row.title.ifBlank { "（无标题）" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                row.parentSessionId?.let { "父会话 ${it.take(8)}…" } ?: "无父会话标识",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}

/** 相对时间：比 `MM-dd HH:mm` 好扫读，且中文语境下更自然。 */
private fun relativeTime(millis: Long): String {
    if (millis <= 0L) return ""
    val diff = System.currentTimeMillis() - millis
    return when {
        diff < 60_000 -> "刚刚"
        diff < 3_600_000 -> "${diff / 60_000} 分钟前"
        diff < 86_400_000 -> "${diff / 3_600_000} 小时前"
        diff < 7 * 86_400_000L -> "${diff / 86_400_000} 天前"
        else -> SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(millis))
    }
}
