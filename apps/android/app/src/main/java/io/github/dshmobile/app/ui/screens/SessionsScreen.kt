package io.github.dshmobile.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.dshmobile.app.net.LinkState
import io.github.dshmobile.app.ui.icons.DshIcons
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.SessionRow
import io.github.dshmobile.app.ui.SessionsViewModel
import io.github.dshmobile.app.ui.components.EmptyState
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.components.MetaTag
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.components.StatusPill
import io.github.dshmobile.app.ui.components.DshIcon
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
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var searchOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
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
            if (state.rows.isNotEmpty()) {
                ExtendedFloatingActionButton(
                    onClick = { vm.create { row -> onOpen(row) } },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    shape = MaterialTheme.shapes.large,
                ) {
                    DshIcon(DshIcons.Add, contentDescription = null)
                    Spacer(Modifier.width(DshTheme.m.sm))
                    Text("新会话", style = MaterialTheme.typography.labelLarge)
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {

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
                    // 子代理会话：只列出、不可点开。
                    // 裸 sessionId 打不开，主机会报
                    // "subagent Sessions require their durable parent address"。
                    if (state.showSubagents && state.subagentRows.isNotEmpty()) {
                        item(key = "subagent-header") {
                            SubagentHeader(state.subagentRows.size)
                        }
                        items(state.subagentRows, key = { "sa-${it.sessionId}" }) { row ->
                            SubagentCard(row)
                        }
                        item(key = "subagent-divider") {
                            Spacer(Modifier.height(DshTheme.m.xs))
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .height(1.dp)
                                    .background(MaterialTheme.colorScheme.outlineVariant),
                            )
                            Spacer(Modifier.height(DshTheme.m.sm))
                        }
                    }

                    // 🔴 按工作区分组 —— 对齐 MiniMax 的 `rc_workspace_section_item`。
                    //
                    // 为什么要分组：我们的产品是「电脑干活，手机遥控」。用户点开会话时，
                    // 真正想知道的是「这件事是在哪个目录里做的」。把所有会话平铺成
                    // 一列，就丢掉了这个最关键的组织维度。
                    // 实测 `session.list` 每条都带 `cwd`，且**同一台电脑上通常有好几个
                    // 不同项目目录**，不分组就分不清。
                    val groups = state.rows.groupBy { it.workspace }
                    // 目录多的排前面？否 —— 保持列表原有顺序（按更新时间），
                    // 只是把**相邻的同目录会话**聚到一起，最新的那个目录在最前。
                    val ordered = groups.entries.sortedByDescending { e ->
                        e.value.maxOf { it.updatedAt }
                    }

                    ordered.forEach { (ws, rows) ->
                        item(key = "ws-header-${ws ?: "none"}") {
                            WorkspaceHeader(ws, rows.size)
                        }
                        items(rows, key = { it.sessionId }) { row ->
                            SessionCard(row) { onOpen(row) }
                        }
                    }
                }
            }
        }
    }
}

// ── 子组件 ──────────────────────────────────────────────────────────────────

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
 * 工作区分组标题。
 *
 * 借鉴 MiniMax 的 `rc_workspace_section_item`：一个分组头 + 数量，
 * 目录名用等宽字体（是路径，不是标题）。
 */
@Composable
private fun WorkspaceHeader(workspace: String?, count: Int) {
    Row(
        Modifier.padding(top = DshTheme.m.md, bottom = DshTheme.m.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DshIcon(
            DshIcons.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            size = 14.dp,
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = workspace?.let { shortPath(it) } ?: "未关联目录",
            style = MaterialTheme.typography.labelMedium,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(DshTheme.m.sm))
        Text(
            text = "$count",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
        )
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
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.medium)
            .clickable(onClick = onClick)
            .padding(horizontal = DshTheme.m.lg, vertical = DshTheme.m.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = row.title.ifBlank { "（无标题会话）" },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(DshTheme.m.sm))
            Text(
                text = relativeTime(row.updatedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }

        // 第二行：预览文本（判断"是不是要找的会话"最有效的信息）
        // 之前只有标题，导致列表里全是无法区分的纯标题行 —— 这是"不像成品"的主因之一。
        val preview = row.preview.trim()
        if (preview.isNotBlank()) {
            Spacer(Modifier.height(DshTheme.m.xs))
            Text(
                text = preview,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        if (row.running) {
            Spacer(Modifier.height(DshTheme.m.sm))
            Row(verticalAlignment = Alignment.CenterVertically) {
                MetaTag("运行中", tint = MaterialTheme.colorScheme.primary,
                    background = MaterialTheme.colorScheme.primaryContainer)
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
