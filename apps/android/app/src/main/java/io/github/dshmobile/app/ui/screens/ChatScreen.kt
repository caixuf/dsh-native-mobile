package io.github.dshmobile.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.draw.drawBehind
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.dshmobile.app.ui.ChatLine
import io.github.dshmobile.app.ui.ChatViewModel
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.PendingPrompt
import io.github.dshmobile.app.ui.components.EmptyState
import io.github.dshmobile.app.ui.components.MetaTag

/**
 * 对话页。
 *
 * 设计取自逆向 MiniMax 移动端（shadcn/ui）：
 *  - **内容最大宽度**（对应它的 `--chat-list-width: 792px`）：长文本不铺满整屏，
 *    否则中文长段落极难扫读
 *  - **消息左右分栏**：用户右对齐带底色，agent 左对齐纯文本 ——
 *    之前是全部左对齐的同一种样式，一屏看下来分不清谁说的
 *  - **输入区固定高度**（它的 `--chat-input-height: 110/146px`，中文要更高）
 *  - 工具调用**弱化成小标签**，不抢正文的视觉重心
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    title: String,
    onBack: () -> Unit,
    vm: ChatViewModel,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var draft by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(state.lines.size) {
        if (state.lines.isNotEmpty()) listState.animateScrollToItem(state.lines.lastIndex)
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = title.ifBlank { "会话" },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                        if (state.running) {
                            Spacer(Modifier.height(2.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier
                                        .size(6.dp)
                                        .background(MaterialTheme.colorScheme.primary, CircleShape),
                                )
                                Spacer(Modifier.width(5.dp))
                                Text(
                                    "正在运行",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    AnimatedVisibility(visible = state.running) {
                        Row(
                            Modifier.padding(end = DshTheme.m.sm),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            IconButton(
                                onClick = { vm.cancel() },
                                colors = IconButtonDefaults.iconButtonColors(
                                    containerColor = MaterialTheme.colorScheme.errorContainer,
                                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                                ),
                                modifier = Modifier.size(34.dp),
                            ) {
                                Icon(
                                    Icons.Filled.Stop,
                                    contentDescription = "停止当轮",
                                    modifier = Modifier.size(17.dp),
                                )
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
        bottomBar = {
            Composer(
                value = draft,
                onValueChange = { draft = it },
                sending = state.sending,
                enabled = !state.running,
                onSend = {
                    vm.send(draft)
                    draft = ""
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .imePadding(),
        ) {

            state.pending?.let { pending ->
                ApprovalCard(
                    title = pending.title,
                    body = pending.body,
                    options = pending.options,
                    onApprove = { vm.approve(true) },
                    onDeny = { vm.approve(false) },
                    onOption = { vm.answerOption(it) },
                )
            }

            state.error?.let {
                Text(
                    text = it,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier
                        .padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.xs)
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.errorContainer,
                            MaterialTheme.shapes.small)
                        .padding(horizontal = DshTheme.m.md, vertical = DshTheme.m.sm),
                )
            }

            when {
                state.loading -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(26.dp),
                        strokeWidth = 2.5.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }

                state.lines.isEmpty() -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(
                        icon = Icons.Outlined.ChatBubbleOutline,
                        title = "这个会话还没有内容",
                        hint = "在下面发一条消息，就能远程驱动电脑上的 DSH 了。",
                    )
                }

                else -> LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(
                        horizontal = DshTheme.m.gutter,
                        vertical = DshTheme.m.md,
                    ),
                    verticalArrangement = Arrangement.spacedBy(DshTheme.m.md),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(state.lines.size, key = { state.lines[it].key }) { i ->
                        LineBubble(state.lines[i])
                    }
                    item { Spacer(Modifier.height(DshTheme.m.md)) }
                }
            }
        }
    }
}

// ── 审批 / 提问卡片 ─────────────────────────────────────────────────────────

/**
 * 待应答卡片（审批或提问）。
 *
 * ⚠️ 这是**整个 App 最要紧的一块 UI** —— 手机上点一下"允许"，等于授权电脑执行操作。
 * 所以刻意做成**占据显眼位置、语义色明确、按钮有明确边界**的样子：
 *  - 琥珀色左边框 + 容器底，一眼扫到（不能淹没在消息流里）
 *  - 主/次按钮用**填充 vs 描边**区分，防止误触（"允许"是危险操作）
 *  - 不做"记住选择"：宿主 ApprovalOutcome 词表只有
 *    allowed-once / rejected / cancelled / unavailable，**没有"记住"这一档**，
 *    发词表外的值会被静默归一化成 unavailable
 */
@Composable
private fun ApprovalCard(
    title: String,
    body: String,
    options: List<String>,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onOption: (String) -> Unit,
) {
    val isQuestion = options.isNotEmpty()
    val scheme = MaterialTheme.colorScheme
    val accent = if (isQuestion) scheme.primary else scheme.tertiary
    val container = if (isQuestion) scheme.primaryContainer else scheme.tertiaryContainer
    val onContainer = if (isQuestion) scheme.onPrimaryContainer else scheme.onTertiaryContainer

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.sm)
            .background(container, MaterialTheme.shapes.medium)
            // 左侧 3px 竖条：即使文字很多也能一眼认出"这里需要你操作"
            .drawBehind {
                drawRect(
                    color = accent,
                    size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height),
                )
            }
            .padding(start = DshTheme.m.md, end = DshTheme.m.md, top = DshTheme.m.md, bottom = DshTheme.m.md),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = if (isQuestion) "需要你选择" else "需要你批准",
                style = MaterialTheme.typography.labelMedium,
                color = accent,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = onContainer,
            )
            if (body.isNotBlank() && body != title) {
                Spacer(Modifier.height(DshTheme.m.xs))
                Text(
                    text = body,
                    style = MaterialTheme.typography.bodySmall,
                    color = onContainer.copy(alpha = 0.85f),
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(DshTheme.m.md))

            if (isQuestion) {
                // 提问：选项做成可点的标签，一行放不下自动换行
                FlowRowChips(
                    options = options,
                    onPick = onOption,
                )
            } else {
                // 审批：「拒绝」是描边、「允许」是填充 —— 降低误触危险操作的概率
                Row(horizontalArrangement = Arrangement.spacedBy(DshTheme.m.sm)) {
                    TextButton(
                        onClick = onDeny,
                        shape = MaterialTheme.shapes.small,
                        border = androidx.compose.foundation.BorderStroke(1.dp, accent),
                        colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                            contentColor = accent,
                        ),
                    ) { Text("拒绝", style = MaterialTheme.typography.labelLarge) }

                    TextButton(
                        onClick = onApprove,
                        shape = MaterialTheme.shapes.small,
                        colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                            containerColor = accent,
                            contentColor = Color.White,
                        ),
                    ) { Text("允许一次", style = MaterialTheme.typography.labelLarge) }
                }
            }
        }
    }
}

/** 选项标签流：Compose 的 FlowRow 还在实验期，这里手写一个简单换行容器。 */
@Composable
private fun FlowRowChips(
    options: List<String>,
    onPick: (String) -> Unit,
    perRow: Int = 2,
) {
    Column(verticalArrangement = Arrangement.spacedBy(DshTheme.m.sm)) {
        options.chunked(perRow).forEach { rowItems ->
            Row(horizontalArrangement = Arrangement.spacedBy(DshTheme.m.sm)) {
                rowItems.forEach { option ->
                    Surface(
                        onClick = { onPick(option) },
                        shape = MaterialTheme.shapes.small,
                        color = MaterialTheme.colorScheme.surface,
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.5f),
                        ),
                    ) {
                        Text(
                            text = option,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(
                                horizontal = DshTheme.m.md,
                                vertical = DshTheme.m.sm,
                            ),
                        )
                    }
                }
            }
        }
    }
}

// ── 消息行 ──────────────────────────────────────────────────────────────────

/**
 * 一条消息。
 *
 * 用户消息右对齐 + 品牌蓝底；agent 消息左对齐纯文本。
 * 两侧都限最大宽度（对齐 MiniMax 的 792px 意图），否则宽屏上长行极难读。
 */
@Composable
private fun LineBubble(line: ChatLine) {
    val fromUser = line.role == "user"
    val isTool = line.role == "tool" || line.role == "system"

    // 工具/系统行：整行限宽、弱化，不参与左右分栏
    if (isTool) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
        ) {
            MetaTag(line.text.take(60))
        }
        return
    }

    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromUser) Arrangement.End else Arrangement.Start,
    ) {
        // 内容最大宽度：长段落不铺满整屏（对齐 MiniMax --chat-list-width 的意图）。
        // 短消息仍按内容自适应，不会拉成一条横贯屏幕的笨重色块。
        Box(
            Modifier
                .widthIn(max = DshTheme.m.contentMaxWidth)
                .fillMaxWidth(if (fromUser) 0.85f else 1f),
        ) {
            Text(
                text = line.text,
                style = MaterialTheme.typography.bodyMedium,
                color = if (fromUser) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .background(
                        color = if (fromUser) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.surface,
                        shape = if (fromUser) RoundedCornerShape(
                            topStart = 16.dp, topEnd = 16.dp,
                            bottomStart = 16.dp, bottomEnd = 5.dp,
                        ) else RoundedCornerShape(
                            topStart = 16.dp, topEnd = 16.dp,
                            bottomStart = 5.dp, bottomEnd = 16.dp,
                        ),
                    )
                    .then(
                        if (fromUser) Modifier
                        // 用户气泡不需要边框（有色底）；agent 气泡用边框分层，
                        // 对应 MiniMax 的「1px 边框而非阴影」
                        else Modifier.border(
                            1.dp,
                            MaterialTheme.colorScheme.outlineVariant,
                            RoundedCornerShape(
                                topStart = 14.dp, topEnd = 14.dp,
                                bottomStart = 4.dp, bottomEnd = 14.dp,
                            ),
                        )
                    )
                    .padding(horizontal = DshTheme.m.md, vertical = 10.dp),
            )
        }
    }
}

// ── 输入区 ──────────────────────────────────────────────────────────────────

/**
 * 输入区。
 *
 * 高度参考 MiniMax 的 `--chat-input-height`（英 110 / 中 146px）：中文换行更多，
 * 框要更高才不会一行就被顶上去。
 */
@Composable
private fun Composer(
    value: String,
    onValueChange: (String) -> Unit,
    sending: Boolean,
    enabled: Boolean,
    onSend: () -> Unit,
) {
    val canSend = value.isNotBlank() && !sending && enabled

    Surface(
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
    ) {
        Column {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.outlineVariant),
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = DshTheme.m.md, vertical = DshTheme.m.sm),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(DshTheme.m.sm),
            ) {
                TextField(
                    value = value,
                    onValueChange = onValueChange,
                    placeholder = {
                        Text(
                            if (enabled) "发消息…" else "正在运行中…",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    enabled = enabled,
                    maxLines = 6,
                    shape = RoundedCornerShape(22.dp),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    ),
                    modifier = Modifier.weight(1f),
                )

                // 发送/停止 用同一位置切换，避免布局跳动
                if (sending || !enabled) {
                    Box(
                        Modifier
                            .size(48.dp)
                            .background(
                                MaterialTheme.colorScheme.surfaceContainerHighest,
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    IconButton(
                        onClick = onSend,
                        enabled = canSend,
                        modifier = Modifier
                            .size(48.dp)
                            .background(
                                if (canSend) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surfaceContainerHighest,
                                CircleShape,
                            ),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = "发送",
                            tint = if (canSend) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
}
