package io.github.dshmobile.app.ui.screens

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.dshmobile.app.ui.ChatLine
import io.github.dshmobile.app.ui.ChatViewModel
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.PendingPrompt
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.components.EmptyState
import io.github.dshmobile.app.ui.icons.DshIcons
import io.github.dshmobile.app.render.MarkdownText

/**
 * 对话页 —— **对齐 DSH Web 客户端的真实设计**，不是另起一套。
 *
 * 设计参数逐字取自 `app.asar` 里 `@deepseek-ai/dsh-client-ui-chat` 与
 * `dsh-client-ui-conversation` 的 CSS module（2026-10 提取）：
 *
 * ```
 * .userRow   { flex-direction:column; align-items:flex-end; gap:6px }
 * .userStack { max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%) }
 * .bubble    { background:var(--dsw-specific-bubble);
 *              border-radius:var(--dsw-radius-xl);
 *              padding:10px 16px;
 *              font-size:var(--dsh-content-font-size,14px);
 *              line-height:calc(22px + var(--dsh-content-font-delta,0px));
 *              white-space:pre-wrap; word-break:break-word }
 *
 * .composerSeat { position:sticky; bottom:0;
 *                 background:linear-gradient(180deg,
 *                   color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px,
 *                   var(--dsw-alias-bg-base) 36px) }   ← 底部渐隐，不是硬切
 * .composerHero { padding-bottom:32px }                  ← 输入区上方留白
 *
 * 工具色 --meter-tint:#a78bfa（紫） · 消息色 var(--dsw-static-blue-450)（蓝）
 * ```
 *
 * 三个此前做错、这次纠正的点：
 *  1. **agent 消息在 Web 端是纯文本，没有气泡底** —— 我之前给它加了白底+边框气泡，
 *     又笨又重；只靠留白分层才对。
 *  2. **工具调用用紫色**（`--meter-tint: #a78bfa`）—— Web 端给工具单独的语义色，
 *     不该和正文同色。
 *  3. **底部 36px 渐隐遮罩** —— 消息滚到输入区时是渐隐的，我之前是硬边界，很生硬。
 *
 * 🔴 **产品模型（这是重写的根本原因）**
 *
 * 我们的产品**不是**「在手机上写代码」，而是「**手机 = 遥控器，电脑 = 干活的**」。
 * 证据来自逆向 MiniMax 移动端：它的文案直接写着
 * `computer_use_hero_title = 像你一样操作你的本地电脑`、`computer_use_tag = Computer Use`，
 * 资源里有 `rc_device_status_item`（桌面设备状态）、`chat_rc_workspace_picker`（工作区选择），
 * 错误码也全是 `rc_device_offline` / `rc_daemon_disconnected` / `rc_harness_timeout` ——
 * 它强调的始终是「**桌面设备 / 守护进程 / 本地运行时**」。
 *
 * 但我之前把这个页做成了「手机里的一个聊天窗口」，顶部只有会话标题 ——
 * 用户完全看不出**这件事正在他的电脑上跑**。所以这里加一条 **执行上下文条**：
 * 电脑名 + 在线状态 + 工作区目录 + 正在运行时电脑在忙。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    title: String,
    onBack: () -> Unit,
    vm: ChatViewModel,
    /** 电脑名（来自配对时主机返回的 instance 名），显示执行上下文。 */
    hostName: String? = null,
    /** 工作区目录，来自 `session.page` 的 cwd。 */
    workspace: String? = null,
    onOpenDrawer: (() -> Unit)? = null,
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
                                        .background(DshTheme.online, CircleShape),
                                )
                                Spacer(Modifier.width(5.dp))
                                Text(
                                    "正在运行",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        DshIcon(
                            DshIcons.ArrowBack,
                            contentDescription = "返回",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            size = 22.dp,
                        )
                    }
                },
                actions = {
                    AnimatedVisibility(visible = state.running) {
                        IconButton(
                            onClick = { vm.cancel() },
                            colors = IconButtonDefaults.iconButtonColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer,
                                contentColor = MaterialTheme.colorScheme.onErrorContainer,
                            ),
                            modifier = Modifier
                                .padding(end = DshTheme.m.sm)
                                .size(34.dp),
                        ) {
                            DshIcon(
                                DshIcons.Stop,
                                contentDescription = "停止当轮",
                                size = 13.dp,
                            )
                        }
                    }
                    if (onOpenDrawer != null) {
                        IconButton(onClick = onOpenDrawer) {
                            DshIcon(
                                DshIcons.Menu,
                                contentDescription = "打开抽屉",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                size = 20.dp,
                            )
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
            // 🔴 电脑准备中：远程创建会话时，手机要能看见「电脑正在准备」。
            //
            // 对齐逆向 MiniMax 移动端 `com.xproducer.yingshiai` 的
            // `claw_pod_start_process_0..3` 四阶段：
            //   唤醒 MaxClaw → 加载知识和技能 → 准备你的云端工作空间 → 即将准备完成
            //
            // 为什么必须有：我们是「手机发起、电脑执行」。从点发送到电脑真的开始跑，
            // 中间有几秒到几十秒（唤醒进程、加载技能、准备工作区）。
            // 没有这个反馈，用户会以为**App 卡了**，然后重复点击。
            if (state.preparing) {
                PreparingBanner(step = state.preparingStep)
            }

            // 🔴 执行上下文条：让「事情正在哪台电脑跑」变得可感知。
            ExecutionContextBar(
                hostName = hostName,
                workspace = workspace,
                running = state.running,
            )

            // 🔴 任务执行进度与规划卡片（对齐 MiniMax team_plan_card / cycle_phase 交互）
            val taskSteps = remember(state.lines, state.running) {
                io.github.dshmobile.app.ui.components.TaskProgressParser.extractSteps(state.lines, state.running)
            }
            if (taskSteps.isNotEmpty()) {
                io.github.dshmobile.app.ui.components.TaskProgressCard(
                    steps = taskSteps,
                    running = state.running,
                    modifier = Modifier.padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.xs),
                )
            }

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

            state.error?.let { message ->
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.padding(
                        horizontal = DshTheme.m.gutter,
                        vertical = DshTheme.m.xs,
                    ),
                ) {
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier.padding(
                            horizontal = DshTheme.m.md,
                            vertical = DshTheme.m.sm,
                        ),
                    )
                }
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
                        icon = DshIcons.ChatBubble,
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
                    verticalArrangement = Arrangement.spacedBy(DshTheme.m.xs),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(state.lines.size, key = { state.lines[it].key }) { i ->
                        LineBubble(state.lines[i])
                    }
                    // 对齐 Web 端 .composerHero 的 padding-bottom:32px
                    item { Spacer(Modifier.height(DshTheme.m.xxl)) }
                }
            }
        }
    }
}

// ── 电脑准备中 ──────────────────────────────────────────────────────────────

/**
 * 「电脑准备中」横幅 —— 远程创建会话时的分阶段反馈。
 *
 * 文案与阶段划分对齐逆向 MiniMax 移动端的 `claw_pod_start_process_0..3`
 * （唤醒 → 加载知识和技能 → 准备工作空间 → 即将完成），
 * 但换成我们真实的阶段名。
 *
 * 设计要点：
 *  - **阶段可见**：每一步单独显示，用户知道在等什么，而不是一个转圈；
 *  - **可点的阶段**：已完成/当前/未开始用不同圆点区分，扫一眼就知道进度；
 *  - **不高**：整条横幅压在 60dp 内，不能把消息流挤没。
 */
@Composable
private fun PreparingBanner(step: Int) {
    val stages = listOf("连接电脑", "加载技能", "准备工作区", "开始执行")

    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // 旋转的进度圈（不依赖第三方库）
            val spin by rememberInfiniteTransition(label = "prep").animateFloat(
                initialValue = 0f,
                targetValue = 360f,
                animationSpec = infiniteRepeatable(tween(1100)),
                label = "spin",
            )
            CircularProgressIndicator(
                progress = { spin / 360f },
                modifier = Modifier.size(15.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(DshTheme.m.sm))
            Text(
                text = stages.getOrElse(step) { stages.last() },
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = "在你的电脑上",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
            )
        }

        // 阶段进度条：四个点，当前项高亮
        Row(
            Modifier.padding(top = DshTheme.m.sm),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            stages.indices.forEach { i ->
                val done = i < step
                val current = i == step
                Box(
                    Modifier
                        .height(3.dp)
                        .weight(1f)
                        .background(
                            when {
                                current -> MaterialTheme.colorScheme.primary
                                done -> MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)
                                else -> MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.15f)
                            },
                            RoundedCornerShape(2.dp),
                        ),
                )
            }
        }
    }
}

// ── 执行上下文条 ────────────────────────────────────────────────────────────

/**
 * 执行上下文条 —— **「手机 = 遥控器，电脑 = 干活的」这条产品模型的视觉落点**。
 *
 * 之前这个页顶��只有会话标题，用户看不出这三件事：
 *   1. 这件事**在哪台电脑**上跑；
 *   2. 在电脑的**哪个目录**（工作区）里跑；
 *   3. 电脑此刻**是不是正在忙**。
 *
 * 逆向 MiniMax 移动端（`com.xproducer.yingshiai`）时发现它对这件事非常上心：
 *  - `rc_device_status_item` 布局 = 状态点 + 设备名
 *  - `chat_rc_workspace_picker` / `workspace_select` 文案 = 工作区选择器
 *  - `rc_device_offline` / `rc_daemon_disconnected` = 强调「桌面设备」「守护进程」
 *
 * 设计取舍：
 *  - **信息密度低**：一行两栏（设备 / 目录），不让它抢正文的注意力；
 *  - **状态用点不用字**：「电脑在忙」是个持续状态，不是事件，用呼吸点更合适；
 *  - **目录用等宽字体**：路径是技术信息，等宽更好扫读；
 *  - 空闲时不显示「空闲」字样 —— 没消息时它就是隐形的，不制造噪音。
 */
@Composable
private fun ExecutionContextBar(
    hostName: String?,
    workspace: String?,
    running: Boolean,
) {
    val displayHost = hostName?.takeIf { it.isNotBlank() } ?: "我的电脑"
    val busyColor = MaterialTheme.colorScheme.primary
    val clipboardManager = androidx.compose.ui.platform.LocalClipboardManager.current
    var showDialog by remember { mutableStateOf(false) }

    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable { showDialog = true }
            .padding(horizontal = DshTheme.m.gutter, vertical = DshTheme.m.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 左：设备身份（图标 + 名字 + 状态）
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.weight(1f, fill = false),
        ) {
            Box(
                Modifier
                    .size(26.dp)
                    .background(
                        if (running) busyColor.copy(alpha = 0.14f)
                        else MaterialTheme.colorScheme.surfaceContainerHighest,
                        RoundedCornerShape(8.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                DshIcon(
                    DshIcons.Desktop,
                    contentDescription = null,
                    tint = if (running) busyColor else MaterialTheme.colorScheme.onSurfaceVariant,
                    size = 15.dp,
                )
            }
            Spacer(Modifier.width(DshTheme.m.sm))
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = displayHost,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.width(6.dp))
                    Box(
                        Modifier
                            .size(6.dp)
                            .background(
                                if (running) busyColor else DshTheme.online,
                                CircleShape,
                            ),
                    )
                }
                Text(
                    text = if (running) "正在这台电脑上执行任务…" else "远程守护中 · 点击看详情",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (running) busyColor else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }

        // 右：工作区目录（有才显示）
        workspace?.takeIf { it.isNotBlank() }?.let { dir ->
            Spacer(Modifier.width(DshTheme.m.sm))
            Row(
                Modifier
                    .background(
                        MaterialTheme.colorScheme.surfaceContainerHighest,
                        RoundedCornerShape(6.dp),
                    )
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DshIcon(
                    DshIcons.Folder,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    size = 12.dp,
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = shortPath(dir),
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }

    if (showDialog) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showDialog = false },
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    DshIcon(DshIcons.Desktop, contentDescription = null, size = 20.dp, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(8.dp))
                    Text("远端电脑执行环境", style = MaterialTheme.typography.titleMedium)
                }
            },
            text = {
                Column {
                    Text("设备名称", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(displayHost, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))

                    Text("当前工作区目录", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val fullDir = workspace?.takeIf { it.isNotBlank() } ?: "（未指定，使用电脑默认路径）"
                    Text(
                        fullDir,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Spacer(Modifier.height(8.dp))

                    Text("执行心智说明", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        "手机作为遥控器下发指令并审批高风险操作，代码执行、文件修改均在你的电脑原生环境中完成。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                if (!workspace.isNullOrBlank()) {
                    TextButton(onClick = {
                        clipboardManager.setText(androidx.compose.ui.text.AnnotatedString(workspace))
                        showDialog = false
                    }) {
                        Text("复制目录路径")
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { showDialog = false }) {
                    Text("关闭")
                }
            },
        )
    }
}

/**
 * 路径只显示最后两段。
 *
 * `C:\Users\me\Downloads\aiwork\dsh-native-mobile` 在手机上放不下，
 * 而用户真正关心的是**项目名**和它的上级目录。
 */
private fun shortPath(path: String, keep: Int = 2): String {
    val normalized = path.replace('\\', '/').trimEnd('/')
    val parts = normalized.split('/').filter { it.isNotBlank() }
    if (parts.size <= keep) return normalized
    return "…/" + parts.takeLast(keep).joinToString("/")
}

// ── 消息行 ──────────────────────────────────────────────────────────────────

/** 工具调用的紫色（Web 端 `--meter-tint: #a78bfa`）。 */
private val ToolTint = Color(0xFFA78BFA)

/**
 * 消息正文样式。
 *
 * Web 端：`font-size: var(--dsh-content-font-size, 14px)`、
 * `line-height: calc(22px + delta)`。手机沿用 14/22 这组比例。
 */
private val MessageTextStyle = TextStyle(
    fontFamily = FontFamily.SansSerif,
    fontSize = 14.5.sp,
    lineHeight = 22.sp,
    lineHeightStyle = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.None,
    ),
)

/**
 * 一条消息。
 *
 * 严格按 Web 端 `.userRow` / `.userStack` / `.bubble` 三段式：
 *  - 用户：右对齐列，气泡 `--radius-xl`，`padding 10/16`，最大 82% 宽
 *  - agent：左对齐**纯文本**，不装在盒子里
 *  - 工具：采用可折叠展开的 DisclosureToolCard，对齐 DSH Web 端规范
 */
@Composable
private fun LineBubble(line: ChatLine) {
    val fromUser = line.role == "user"

    val isTool = line.kind == "tool/call" || line.kind == "tool/result" ||
        line.role == "tool" || line.role == "system"

    if (isTool) {
        io.github.dshmobile.app.ui.components.DisclosureToolCard(
            line = line,
            modifier = Modifier.padding(vertical = 4.dp),
        )
        return
    }

    // .userRow { align-items:flex-end; gap:6px }
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (fromUser) Alignment.End else Alignment.Start,
    ) {
        // .userStack { max-width: min(748px * .702, 82%) }
        // 手机上没有 748px 的"内容宽度"概念，用 contentMaxWidth 等价。
        Box(Modifier.widthIn(max = DshTheme.m.contentMaxWidth)) {
            if (fromUser) {
                // .bubble { background: var(--dsw-specific-bubble); radius-xl; padding:10px 16px }
                Text(
                    text = line.text,
                    style = MessageTextStyle,
                    color = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier
                        .background(
                            MaterialTheme.colorScheme.primary,
                            RoundedCornerShape(
                                topStart = 18.dp,
                                topEnd = 18.dp,
                                bottomStart = 18.dp,
                                bottomEnd = 5.dp,
                            ),
                        )
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            } else {
                // agent 消息：走 Markdown 渲染（Web 端同样是 markdown）
                MarkdownText(
                    text = line.text,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

// ── 输入区 ──────────────────────────────────────────────────────────────────

/**
 * 输入区。
 *
 * 对齐 Web 端 `.composerSeat`：
 *  - `position:sticky; bottom:0` —— 固定底部
 *  - 顶部 **36px 渐隐遮罩**：内容滚到底部时淡出，而不是硬切
 *  - `.composerHero { padding-bottom:32px }` —— 输入框自身留白
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

    Box {
        // 36px 渐隐：把滚动内容"化"进输入区，避免硬边界
        Box(
            Modifier
                .fillMaxWidth()
                .height(36.dp)
                .background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, MaterialTheme.colorScheme.background),
                    ),
                )
                .align(Alignment.BottomCenter),
        )
        Column(
            Modifier
                .fillMaxWidth()
                .padding(
                    start = DshTheme.m.gutter,
                    end = DshTheme.m.gutter,
                    top = DshTheme.m.md,
                    bottom = DshTheme.m.sm,
                ),
        ) {
            Row(
                Modifier.fillMaxWidth(),
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
                    shape = RoundedCornerShape(18.dp),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.surface,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                        disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                        focusedTextColor = MaterialTheme.colorScheme.onSurface,
                        unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
                    ),
                    modifier = Modifier
                        .weight(1f)
                        // Web 端用 --dsw-elevation-stroke-color 描边代替阴影；
                        // 有内容时描边转主色，给"输入中"一点反馈
                        .border(
                            1.dp,
                            if (value.isNotBlank()) {
                                MaterialTheme.colorScheme.primary.copy(alpha = 0.4f)
                            } else {
                                MaterialTheme.colorScheme.outlineVariant
                            },
                            RoundedCornerShape(18.dp),
                        ),
                )

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
                    Box(
                        Modifier
                            .size(48.dp)
                            .background(
                                if (canSend) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surfaceContainerHighest,
                                CircleShape,
                            )
                            .clickable(enabled = canSend, onClick = onSend),
                        contentAlignment = Alignment.Center,
                    ) {
                        DshIcon(
                            DshIcons.Send,
                            contentDescription = "发送",
                            tint = if (canSend) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                            size = 20.dp,
                        )
                    }
                }
            }
        }
    }
}

// ── 审批 / 提问卡片 ─────────────────────────────────────────────────────────

/**
 * 待应答卡片。
 *
 * ⚠️ 这是**整个 App 最要紧的一块 UI** —— 手机上点"允许"，等于授权电脑执行操作。
 * 刻意做成显眼、有明确边界、按钮语义清晰的样子：
 *  - 左侧 3px 语义色竖条：即使文字很多也能一眼扫到
 *  - 「拒绝」描边 /「允许」填充 —— 降低误触危险操作的概率
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
            .drawBehind {
                drawRect(color = accent, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height))
            }
            .padding(
                start = DshTheme.m.md,
                end = DshTheme.m.md,
                top = DshTheme.m.md,
                bottom = DshTheme.m.md,
            ),
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                DshIcon(
                    if (isQuestion) DshIcons.ChatBubble else DshIcons.Warning,
                    contentDescription = null,
                    tint = accent,
                    size = 15.dp,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = if (isQuestion) "需要你选择" else "需要你批准",
                    style = MaterialTheme.typography.labelMedium,
                    color = accent,
                    fontWeight = FontWeight.SemiBold,
                )
            }
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
                OptionChips(options = options, onPick = onOption)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(DshTheme.m.sm)) {
                    TextButton(
                        onClick = onDeny,
                        shape = MaterialTheme.shapes.small,
                        border = BorderStroke(1.dp, accent),
                    ) {
                        Text(
                            "拒绝",
                            style = MaterialTheme.typography.labelLarge,
                            color = accent,
                        )
                    }
                    TextButton(
                        onClick = onApprove,
                        shape = MaterialTheme.shapes.small,
                        colors = ButtonDefaults.textButtonColors(
                            containerColor = accent,
                            contentColor = Color.White,
                        ),
                    ) {
                        Text("允许一次", style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        }
    }
}

/** 选项标签流：Compose 的 FlowRow 仍在实验期，手写一个简单换行容器。 */
@Composable
private fun OptionChips(
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
                        border = BorderStroke(
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
