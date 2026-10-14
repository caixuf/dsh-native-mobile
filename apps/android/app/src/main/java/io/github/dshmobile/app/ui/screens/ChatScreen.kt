package io.github.dshmobile.app.ui.screens

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import io.github.dshmobile.app.ui.WorkspaceFormatter
import io.github.dshmobile.app.ui.AmbientWallpaper
import io.github.dshmobile.app.ui.GlassCard
import io.github.dshmobile.app.ui.PulseDot
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
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
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.core.content.ContextCompat
import io.github.dshmobile.app.ui.components.VoiceRecordingOverlay
import io.github.dshmobile.app.ui.components.rememberVoiceInputState

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

    // 🔴 跟随滚动重写（2026-10-14 体验审计，两处真问题）
    //
    // 原实现：
    //     LaunchedEffect(state.lines.size) {
    //         if (state.lines.isNotEmpty()) listState.animateScrollToItem(state.lines.lastIndex)
    //     }
    //
    // 问题 ①：key 只有 `size` —— 流式输出时末尾那条消息是**原地变长**的
    //         （size 不变），于是**完全不跟随**。用户看到的现象是
    //         "AI 在打字但画面不动，得自己一直往下滑"。
    // 问题 ②：一旦新增一行（如 tool/call 事件），就**无条件**动画拽到底部。
    //         即使用户正在上滑读历史，也会被生生打断。
    //         这是"不丝滑"里体感最差的一项。
    //
    // 现在：
    //   - key 加入**末尾文本长度**，覆盖"原地变长"这一流式主场景
    //   - 先判断用户是否**在底部附近**，只在底部时才跟随（不打断上滑）
    //   - 保留 animateScrollToItem：它是可被用户手势打断的（见下面说明）
    //
    // 关于为何仍用 animate 而非 scrollToItem：`animateScrollToItem` 在用户
    // 手指触碰列表时会让位给手势，而 `scrollToItem` 是瞬时跳变。跟随滚动
    // 用动画的观感更连续，也更符合"丝滑"的诉求。
    val lastLine = state.lines.lastOrNull()
    LaunchedEffect(state.lines.size, lastLine?.key, lastLine?.text?.length) {
        if (state.lines.isEmpty()) return@LaunchedEffect
        val info = listState.layoutInfo
        val lastVisible = info.visibleItemsInfo.lastOrNull()
        // 判据：最后一项可见，且其下沿没有超出视口太多。
        // 留 200px 余量 —— 容忍子像素/行高误差，避免"明明在底部却判定为不在"。
        val atBottom = lastVisible == null ||
            (
                lastVisible.index >= info.totalItemsCount - 1 &&
                    lastVisible.offset + lastVisible.size <= info.viewportEndOffset + 200
                )
        if (atBottom) {
            listState.animateScrollToItem(state.lines.lastIndex)
        }
    }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .imePadding(),
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
                // 🔴 运行中**不再锁输入**（2026-10-14）。
                //
                // 原实现是 `enabled = !state.running`，把输入框整个禁用 ——
                // 但协议本来就支持运行中继续发：`session.prompt` 的
                // `mode=queue` 会排在当前回合之后，这正是客户端的「任务队列」。
                // 锁住输入是纯粹的自我设限，用户被迫干等一整轮才能打下一句。
                //
                // 现在始终可输入；运行中发出的消息进本地队列并按 queue 模式提交。
                enabled = true,
                running = state.running,
                queue = state.queue,
                onSend = {
                    if (draft.isNotBlank()) {
                        vm.send(draft)
                        draft = ""
                    }
                },
                onRemoveQueued = { vm.removeQueued(it) },
                onPromoteQueued = { vm.promoteToSteer(it) },
                onRetryQueued = { vm.retryQueued(it) },
            )
        },
    ) { padding ->
        AmbientWallpaper(Modifier.padding(padding)) {
            Column(Modifier.fillMaxSize()) {
                // 🔴 电脑准备中：远程创建会话时，手机要能看见「电脑正在准备」。
                if (state.preparing) {
                    PreparingBanner(step = state.preparingStep)
                }

                // 🔴 执行上下文条：让「事情正在哪台电脑跑」变得可感知。
                ExecutionContextBar(
                    hostName = hostName,
                    workspace = workspace,
                    running = state.running,
                )

                // 🔴 快速配置选择器条（在进行中会话中可随时切换模式/权限/模型）
                if (state.lines.isNotEmpty()) {
                    SessionConfigStrip(
                        selectedMode = state.selectedMode,
                        selectedPerm = state.selectedPermission,
                        selectedModel = state.selectedModel,
                        availableModes = state.availableModes,
                        availablePerms = state.availablePermissions,
                        availableModels = state.availableModels,
                        onSelectMode = { vm.selectMode(it) },
                        onSelectPerm = { vm.selectPermission(it) },
                        onSelectModel = { vm.selectModel(it) },
                    )
                }

                // 🔴 任务执行进度与规划卡片（对齐 MiniMax team_plan_card / cycle_phase 交互）
                //
                // ⚠️ key 不能取整个 `state.lines`（2026-10-14 性能审计发现）。
                //
                // 原来的写法是 `remember(state.lines, state.running)` —— 而 `lines`
                // 每次轮询都会被**重建成一个新 List 实例**，`List.equals` 逐项比对后
                // 判为不等 → 每 2.5 秒对**全部**消息重跑一遍 `extractSteps`，
                // 其内部会对每条 assistant 消息的**全文**做 `CHECKLIST_REGEX.findAll`。
                // 长会话下这是 O(总字符数) 的重扫。
                //
                // `extractSteps` 的输入实际上只有三样东西：
                //   ① 列表长度（决定"当前轮次"的切片边界）
                //   ② 最后一条 assistant 文本（流式时它才是变化的那个）
                //   ③ running 状态
                // 所以按这三样做 key，效果等价而代价从 O(全文) 降到 O(1)。
                //
                // 取舍说明：若**中间**某条 assistant 文本在长度与末条都不变的前提下
                // 被改写，这里的 steps 会暂时滞后一次更新才刷新。本应用的 lines 在
                // 流式期间是**只追加**（只有尾部在变），reload 时整表替换通常也会
                // 改变长度或末条文本，因此这个窗口在实践中不出现。
                val lastAssistantText = state.lines
                    .lastOrNull { it.role == "assistant" || it.role == "agent" }
                    ?.text
                val taskSteps = remember(state.lines.size, lastAssistantText, state.running) {
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

                // 一次性提示：如实告知某项操作的真实效果（例如模式/权限
                // 在 DSH 侧不可远程切换）。用中性色而非错误色 —— 这不是失败。
                state.hint?.let { message ->
                    LaunchedEffect(message) {
                        kotlinx.coroutines.delay(4000)
                        vm.consumeHint()
                    }
                    Surface(
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.padding(
                            horizontal = DshTheme.m.gutter,
                            vertical = DshTheme.m.xs,
                        ),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(
                                horizontal = DshTheme.m.md,
                                vertical = DshTheme.m.sm,
                            ),
                        ) {
                            DshIcon(
                                DshIcons.Info,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSecondaryContainer,
                                size = 14.dp,
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = message,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                        }
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

                    state.lines.isEmpty() -> {
                        ChatEmptyHeroState(
                            workspace = workspace,
                            selectedMode = state.selectedMode,
                            selectedPerm = state.selectedPermission,
                            selectedModel = state.selectedModel,
                            availableModes = state.availableModes,
                            availablePerms = state.availablePermissions,
                            availableModels = state.availableModels,
                            onSelectMode = { vm.selectMode(it) },
                            onSelectPerm = { vm.selectPermission(it) },
                            onSelectModel = { vm.selectModel(it) },
                            onPickSuggestion = { prompt ->
                                draft = prompt
                            },
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

    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = DshTheme.m.gutter, vertical = 6.dp),
    ) {
        GlassCard(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { showDialog = true },
            shape = RoundedCornerShape(14.dp),
            backgroundColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.82f),
            borderColor = if (running) MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)
                         else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 左：设备身份（图标 + 名字 + 呼吸状态脉冲）
                Box(
                    Modifier
                        .size(32.dp)
                        .background(
                            if (running) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.75f)
                            else MaterialTheme.colorScheme.surfaceContainerHighest,
                            RoundedCornerShape(10.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    DshIcon(
                        DshIcons.Desktop,
                        contentDescription = null,
                        tint = if (running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        size = 17.dp,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f, fill = false)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = displayHost,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.width(6.dp))
                        PulseDot(
                            color = if (running) MaterialTheme.colorScheme.primary else DshTheme.online,
                            size = 6.dp,
                            // 运行中脉动更"急"，静止时更"缓" —— 用动画节奏传达状态
                            pulseScale = if (running) 2.2f else 1.6f,
                        )
                    }
                    Text(
                        text = if (running) "正在电脑原生环境执行任务…" else "远程守护中 · 点击看详情",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                        maxLines = 1,
                    )
                }

                // 右：工作区目录（有才显示）
                workspace?.takeIf { it.isNotBlank() }?.let { dir ->
                    Spacer(Modifier.width(8.dp))
                    Row(
                        Modifier
                            .background(
                                MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.8f),
                                RoundedCornerShape(8.dp),
                            )
                            .border(
                                1.dp,
                                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                                RoundedCornerShape(8.dp),
                            )
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        DshIcon(
                            DshIcons.Folder,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            size = 12.dp,
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            text = shortPath(dir),
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
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
        Box(Modifier.widthIn(max = if (fromUser) 310.dp else DshTheme.m.contentMaxWidth)) {
            if (fromUser) {
                val isDark = isSystemInDarkTheme()
                Box(
                    modifier = Modifier
                        .background(
                            brush = Brush.linearGradient(
                                colors = if (isDark) listOf(Color(0xFF262937), Color(0xFF1B1D28))
                                else listOf(Color(0xFFFFFFFF), Color(0xFFF1F3F7)),
                            ),
                            shape = RoundedCornerShape(
                                topStart = 18.dp,
                                topEnd = 18.dp,
                                bottomStart = 18.dp,
                                bottomEnd = 4.dp,
                            ),
                        )
                        .border(
                            1.dp,
                            if (isDark) Color(0xFF383C4E) else Color(0xFFE2E5EB),
                            RoundedCornerShape(
                                topStart = 18.dp,
                                topEnd = 18.dp,
                                bottomStart = 18.dp,
                                bottomEnd = 4.dp,
                            ),
                        )
                        .padding(horizontal = 14.dp, vertical = 11.dp),
                ) {
                    SelectionContainer {
                        MarkdownText(
                            text = line.text,
                            color = if (isDark) Color(0xFFF3F4F8) else Color(0xFF111827),
                        )
                    }
                }
            } else {
                // agent 消息：增加顶层精美 Agent 身份标识与呼吸小标
                Column {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(bottom = 6.dp),
                    ) {
                        Box(
                            Modifier
                                .size(18.dp)
                                .background(
                                    MaterialTheme.colorScheme.primaryContainer,
                                    CircleShape,
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            DshIcon(
                                DshIcons.Cpu,
                                contentDescription = null,
                                size = 11.dp,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = "DeepSeek · Agent",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                            letterSpacing = 0.5.sp,
                        )
                    }

                    SelectionContainer {
                        MarkdownText(
                            text = line.text,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                    if (line.text.isNotBlank()) {
                        MessageActionBar(text = line.text)
                    }
                }
            }
        }
    }
}

/** 回答底部操作栏（一键整条复制 + 触感震动反馈）。 */
@Composable
private fun MessageActionBar(text: String) {
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val haptics = LocalHapticFeedback.current
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            kotlinx.coroutines.delay(2000)
            copied = false
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .clickable {
                    clipboard.setText(androidx.compose.ui.text.AnnotatedString(text))
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    copied = true
                }
                .padding(horizontal = 6.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DshIcon(
                imageVector = if (copied) DshIcons.Check else DshIcons.Copy,
                contentDescription = if (copied) "已复制" else "复制回答",
                tint = if (copied) DshTheme.online else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                size = 13.dp,
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = if (copied) "已复制" else "复制",
                style = MaterialTheme.typography.labelSmall,
                // 对比度修正（2026-10-14 计算得出，非目测）：
                // 原来是 onSurfaceVariant.copy(alpha=0.5f) + 11sp。合成色 #b8b8c0
                // 在浅底上对比度仅 1.97:1，而 11sp 属正文级，WCAG 2.1 AA 要求 4.5:1。
                // 去掉 alpha 后为完整的 onSurfaceVariant（#717182），对比度 4.79:1 ✓。
                color = if (copied) DshTheme.online else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 11.sp,
            )
        }
    }
}

// ── 待发送队列 ──────────────────────────────────────────────────────────────

/**
 * 待发送队列条。
 *
 * ## 为什么需要它
 *
 * 用户在**运行中**发出的消息会按 `mode=queue` 提交给主机 ——
 * 主机会在当前回合结束后依次执行。但主机**不会主动推送"我的队列里有什么"**，
 * 所以客户端必须自己记账，否则用户看到的现象是「发了但屏幕上没反应」。
 *
 * 这一条解决了三件事：
 *  - **可见**：明确告诉他"已排队，会在当前回合后执行"
 *  - **可撤销**：还没提交的可以直接删掉，不必等它真的跑起来
 *  - **可插话**：想立刻打断当前回合，就把它提升为 `steer`
 *
 * 交互对齐客户端：客户端在输入框上方给排队消息留位，并支持
 * 「插话发送全部排队消息」（`session.updateQueue` 的 promote-to-steer）。
 */
@Composable
private fun QueueStrip(
    queue: List<io.github.dshmobile.app.ui.QueuedMessage>,
    onRemove: (String) -> Unit,
    onPromote: (String) -> Unit,
    onRetry: (String) -> Unit,
) {
    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        backgroundColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
        borderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.35f),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                DshIcon(
                    DshIcons.TaskList,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    size = 13.dp,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = "待发送 ${queue.size} 条 · 当前回合结束后依次执行",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }

            queue.forEach { item ->
                QueueRow(item = item, onRemove = onRemove, onPromote = onPromote, onRetry = onRetry)
            }
        }
    }
}

@Composable
private fun QueueRow(
    item: io.github.dshmobile.app.ui.QueuedMessage,
    onRemove: (String) -> Unit,
    onPromote: (String) -> Unit,
    onRetry: (String) -> Unit,
) {
    val failed = item.status == "failed"
    val steered = item.mode == "steer"

    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(start = 8.dp, end = 4.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 状态点：失败红、插话橙、正常主色
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(
                    when {
                        failed -> MaterialTheme.colorScheme.error
                        steered -> MaterialTheme.colorScheme.tertiary
                        else -> MaterialTheme.colorScheme.primary
                    },
                ),
        )
        Spacer(Modifier.width(7.dp))

        Column(Modifier.weight(1f)) {
            Text(
                text = item.text.replace('\n', ' '),
                style = MaterialTheme.typography.bodySmall,
                color = if (failed) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (failed || steered) {
                Text(
                    text = when {
                        failed -> "发送失败" + (item.error?.let { "：$it" } ?: "") 
                        else -> "插话模式 · 立即注入当前回合"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (failed) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.tertiary
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (failed) {
            IconButton(onClick = { onRetry(item.localId) }, modifier = Modifier.size(30.dp)) {
                DshIcon(
                    DshIcons.Refresh,
                    contentDescription = "重试",
                    tint = MaterialTheme.colorScheme.primary,
                    size = 15.dp,
                )
            }
        } else if (!steered) {
            IconButton(onClick = { onPromote(item.localId) }, modifier = Modifier.size(30.dp)) {
                DshIcon(
                    DshIcons.Send,
                    contentDescription = "改为插话，立即注入当前回合",
                    tint = MaterialTheme.colorScheme.tertiary,
                    size = 15.dp,
                )
            }
        }

        IconButton(onClick = { onRemove(item.localId) }, modifier = Modifier.size(30.dp)) {
            DshIcon(
                DshIcons.Close,
                contentDescription = "移除",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                size = 15.dp,
            )
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
    running: Boolean,
    queue: List<io.github.dshmobile.app.ui.QueuedMessage>,
    onSend: () -> Unit,
    onRemoveQueued: (String) -> Unit,
    onPromoteQueued: (String) -> Unit,
    onRetryQueued: (String) -> Unit,
) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current

    val voiceState = rememberVoiceInputState { text ->
        if (text.isNotBlank()) {
            val combined = if (value.isBlank()) text else "$value $text"
            onValueChange(combined)
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { isGranted ->
        if (isGranted) {
            voiceState.start()
        }
    }

    // 🔴 运行中也允许发送（进队列）。只在"正在提交"这一瞬间防抖，
    //    避免用户连点导致同一句话重复入队。
    val canSend = value.isNotBlank() && enabled

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
                .navigationBarsPadding()
                .padding(
                    start = DshTheme.m.gutter,
                    end = DshTheme.m.gutter,
                    top = DshTheme.m.md,
                    bottom = DshTheme.m.sm,
                ),
        ) {
            // 语音录音转写动态波纹浮层
            VoiceRecordingOverlay(
                isListening = voiceState.isListening,
                isCancelling = voiceState.isCancelling,
                liveTranscript = voiceState.liveTranscript,
                rmsLevel = voiceState.rmsLevel,
            )

            // ── 待发送队列 ────────────────────────────────────────────────
            // 运行中发出的消息先在这里可见，用户能确认"发出去了"、
            // 也能撤销或改为插话。没有它的话，运行中发消息像是石沉大海。
            if (queue.isNotEmpty()) {
                QueueStrip(
                    queue = queue,
                    onRemove = onRemoveQueued,
                    onPromote = onPromoteQueued,
                    onRetry = onRetryQueued,
                )
                Spacer(Modifier.height(DshTheme.m.sm))
            }

            var showActionMenu by remember { mutableStateOf(false) }

            if (showActionMenu) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 6.dp)
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    ActionChip("/plan 计划") {
                        val next = if (value.isBlank()) "/plan " else "$value /plan "
                        onValueChange(next)
                        showActionMenu = false
                    }
                    ActionChip("/test 测试") {
                        val next = if (value.isBlank()) "/test " else "$value /test "
                        onValueChange(next)
                        showActionMenu = false
                    }
                    ActionChip("@ 引用文件") {
                        val next = if (value.isBlank()) "@" else "$value @"
                        onValueChange(next)
                        showActionMenu = false
                    }
                    ActionChip("+ 工作区上下文") {
                        val next = if (value.isBlank()) "[附带当前工作区上下文] " else "$value [附带当前工作区上下文] "
                        onValueChange(next)
                        showActionMenu = false
                    }
                }
            }

            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(26.dp),
                backgroundColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                borderColor = if (value.isNotBlank()) MaterialTheme.colorScheme.primary.copy(alpha = 0.6f)
                             else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 6.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    // 🔴 客户端对齐：+ 附件与快捷指令入口（Task 17）
                    Box(
                        Modifier
                            .size(42.dp)
                            .clip(CircleShape)
                            .background(
                                if (showActionMenu) MaterialTheme.colorScheme.primaryContainer
                                else MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.6f),
                            )
                            .clickable { showActionMenu = !showActionMenu },
                        contentAlignment = Alignment.Center,
                    ) {
                        DshIcon(
                            DshIcons.Add,
                            contentDescription = "添加指令或附件",
                            tint = if (showActionMenu) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                            size = 19.dp,
                        )
                    }

                    TextField(
                        value = value,
                        onValueChange = onValueChange,
                        placeholder = {
                            Text(
                                when {
                                    !enabled -> "连接已断开…"
                                    running -> "运行中也可以发，会排队执行…"
                                    value.isEmpty() -> "描述你想要构建的内容，/ 调用指令…"
                                    else -> "发消息，或按住右侧说话…"
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        enabled = enabled,
                        maxLines = 6,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            disabledContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                            focusedTextColor = MaterialTheme.colorScheme.onSurface,
                            unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
                        ),
                        modifier = Modifier.weight(1f),
                    )

                    if (sending || !enabled) {
                        Box(
                            Modifier
                                .size(42.dp)
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
                    } else if (canSend) {
                        // 有文字时显示常规发送按钮
                        Box(
                            Modifier
                                .size(42.dp)
                                .background(
                                    MaterialTheme.colorScheme.primary,
                                    CircleShape,
                                )
                                .clickable(onClick = onSend),
                            contentAlignment = Alignment.Center,
                        ) {
                            DshIcon(
                                DshIcons.Send,
                                contentDescription = "发送",
                                tint = MaterialTheme.colorScheme.onPrimary,
                                size = 18.dp,
                            )
                        }
                    } else {
                        // 输入框为空时显示 MiniMax 风格的按住说话麦克风按钮
                        Box(
                            Modifier
                                .size(42.dp)
                                .background(
                                    if (voiceState.isListening) MaterialTheme.colorScheme.primaryContainer
                                    else MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.6f),
                                    CircleShape,
                                )
                                .pointerInput(enabled) {
                                    awaitEachGesture {
                                        awaitFirstDown(requireUnconsumed = false)
                                        val hasPerm = ContextCompat.checkSelfPermission(
                                            context,
                                            Manifest.permission.RECORD_AUDIO,
                                        ) == PackageManager.PERMISSION_GRANTED
                                        if (!hasPerm) {
                                            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                            return@awaitEachGesture
                                        }
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        voiceState.start()

                                        var totalDragY = 0f
                                        do {
                                            val event = awaitPointerEvent()
                                            val change = event.changes.firstOrNull() ?: break
                                            totalDragY += change.position.y - change.previousPosition.y
                                            voiceState.isCancelling = (totalDragY < -130f)
                                        } while (event.changes.any { it.pressed })

                                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        voiceState.stop(cancel = voiceState.isCancelling)
                                    }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            DshIcon(
                                DshIcons.Mic,
                                contentDescription = "按住说话",
                                tint = if (voiceState.isListening) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                size = 18.dp,
                            )
                        }
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

@Composable
private fun ActionChip(
    text: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
}

/**
 * 客户端对齐的空态会话主屏（P2 / P3）：
 * - 「探索未至之境」大标题
 * - 四个核心胶囊（工作区 / 模式 / 权限 / 模型）
 * - 快捷 Prompt 引导卡片
 */
@Composable
private fun ChatEmptyHeroState(
    workspace: String?,
    selectedMode: String,
    selectedPerm: String,
    selectedModel: String,
    availableModes: List<String>,
    availablePerms: List<String>,
    availableModels: List<String>,
    onSelectMode: (String) -> Unit,
    onSelectPerm: (String) -> Unit,
    onSelectModel: (String) -> Unit,
    onPickSuggestion: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showModeDialog by remember { mutableStateOf(false) }
    var showPermDialog by remember { mutableStateOf(false) }
    var showModelDialog by remember { mutableStateOf(false) }

    val (wsName, _) = remember(workspace) {
        WorkspaceFormatter.format(workspace)
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = DshTheme.m.gutter),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                // 顶部高质感标识
                Surface(
                    shape = RoundedCornerShape(20.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.3f)),
                    modifier = Modifier.padding(bottom = 12.dp),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        PulseDot(
                            color = MaterialTheme.colorScheme.primary,
                            size = 6.dp,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = "DSH NATIVE · 遥控中枢",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                            letterSpacing = 0.6.sp,
                        )
                    }
                }

                Text(
                    text = "探索未至之境",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onBackground,
                    letterSpacing = (-0.5).sp,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "与远端电脑上的深度智能体协同构建 · 本地原生算力",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                )
            }

            // 四大控件胶囊选择器行（工作区 / 模式 / 权限 / 模型）
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ConfigPill(
                    icon = DshIcons.Folder,
                    label = wsName,
                    onClick = { /* 当前工作区 */ },
                )

                ConfigPill(
                    icon = DshIcons.TaskList,
                    label = "$selectedMode ▾",
                    onClick = { showModeDialog = true },
                )

                ConfigPill(
                    icon = DshIcons.ShieldAlert,
                    label = "$selectedPerm ▾",
                    onClick = { showPermDialog = true },
                )

                ConfigPill(
                    icon = DshIcons.Desktop,
                    label = "$selectedModel ▾",
                    onClick = { showModelDialog = true },
                )
            }

            Spacer(Modifier.height(6.dp))

            // Studio Bento Prompt 引导卡片
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                val suggestions = listOf(
                    Triple(DshIcons.Folder, "代码架构探查", "分析当前工程结构并梳理主流程"),
                    Triple(DshIcons.TaskList, "自动化质量验证", "检查代码变更并运行单元测试"),
                    Triple(DshIcons.Desktop, "演进路线规划", "规划下一阶段的功能实现计划"),
                )
                suggestions.forEach { (icon, title, prompt) ->
                    GlassCard(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPickSuggestion(prompt) },
                        shape = RoundedCornerShape(14.dp),
                        backgroundColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
                        borderColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .size(36.dp)
                                    .background(
                                        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.7f),
                                        RoundedCornerShape(10.dp),
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                DshIcon(
                                    icon,
                                    contentDescription = null,
                                    size = 18.dp,
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = title,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Spacer(Modifier.height(2.dp))
                                Text(
                                    text = prompt,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Spacer(Modifier.width(8.dp))
                            DshIcon(
                                DshIcons.Send,
                                contentDescription = null,
                                size = 15.dp,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }
        }
    }

    if (showModeDialog) {
        SingleSelectDialog(
            title = "选择智能体模式",
            options = availableModes,
            selected = selectedMode,
            onSelect = {
                onSelectMode(it)
                showModeDialog = false
            },
            onDismiss = { showModeDialog = false },
        )
    }

    if (showPermDialog) {
        SingleSelectDialog(
            title = "选择操作权限范围",
            options = availablePerms,
            selected = selectedPerm,
            onSelect = {
                onSelectPerm(it)
                showPermDialog = false
            },
            onDismiss = { showPermDialog = false },
        )
    }

    if (showModelDialog) {
        SingleSelectDialog(
            title = "选择大语言模型",
            options = availableModels,
            selected = selectedModel,
            onSelect = {
                onSelectModel(it)
                showModelDialog = false
            },
            onDismiss = { showModelDialog = false },
        )
    }
}

/**
 * 运行中会话顶部的快捷模式/权限/模型选择条。
 */
@Composable
private fun SessionConfigStrip(
    selectedMode: String,
    selectedPerm: String,
    selectedModel: String,
    availableModes: List<String>,
    availablePerms: List<String>,
    availableModels: List<String>,
    onSelectMode: (String) -> Unit,
    onSelectPerm: (String) -> Unit,
    onSelectModel: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showModeDialog by remember { mutableStateOf(false) }
    var showPermDialog by remember { mutableStateOf(false) }
    var showModelDialog by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = DshTheme.m.gutter, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConfigPill(
            icon = DshIcons.TaskList,
            label = "$selectedMode ▾",
            onClick = { showModeDialog = true },
        )

        ConfigPill(
            icon = DshIcons.ShieldAlert,
            label = "$selectedPerm ▾",
            onClick = { showPermDialog = true },
        )

        ConfigPill(
            icon = DshIcons.Desktop,
            label = "$selectedModel ▾",
            onClick = { showModelDialog = true },
        )
    }

    if (showModeDialog) {
        SingleSelectDialog(
            title = "切换智能体模式",
            options = availableModes,
            selected = selectedMode,
            onSelect = {
                onSelectMode(it)
                showModeDialog = false
            },
            onDismiss = { showModeDialog = false },
        )
    }

    if (showPermDialog) {
        SingleSelectDialog(
            title = "切换操作权限",
            options = availablePerms,
            selected = selectedPerm,
            onSelect = {
                onSelectPerm(it)
                showPermDialog = false
            },
            onDismiss = { showPermDialog = false },
        )
    }

    if (showModelDialog) {
        SingleSelectDialog(
            title = "切换大语言模型",
            options = availableModels,
            selected = selectedModel,
            onSelect = {
                onSelectModel(it)
                showModelDialog = false
            },
            onDismiss = { showModelDialog = false },
        )
    }
}

@Composable
private fun ConfigPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
        ),
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DshIcon(icon, contentDescription = null, size = 13.dp, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(5.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun SingleSelectDialog(
    title: String,
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                options.forEach { opt ->
                    Surface(
                        onClick = { onSelect(opt) },
                        shape = RoundedCornerShape(10.dp),
                        color = if (opt == selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
                        border = BorderStroke(
                            1.dp,
                            if (opt == selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = opt,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (opt == selected) FontWeight.SemiBold else FontWeight.Normal,
                                color = if (opt == selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f),
                            )
                            if (opt == selected) {
                                DshIcon(DshIcons.Check, contentDescription = null, size = 16.dp, tint = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
