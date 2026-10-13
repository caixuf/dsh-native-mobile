package io.github.dshmobile.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dshmobile.app.ui.ChatLine
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.icons.DshIcons

enum class StepStatus {
    COMPLETED,
    RUNNING,
    PENDING,
}

data class TaskStep(
    val title: String,
    val status: StepStatus,
    val detail: String? = null,
)

object TaskProgressParser {
    private val CHECKLIST_REGEX = Regex("""(?m)^[-*]\s*\[([ xX])\]\s*(.+)$""")

    /**
     * 从当前轮次的消息流与工具执行序列中解析出任务步骤清单。
     */
    fun extractSteps(lines: List<ChatLine>, running: Boolean): List<TaskStep> {
        if (lines.isEmpty()) return emptyList()

        // 找到当轮对话的起点（最后一条 user 消息）
        val lastUserIdx = lines.indexOfLast { it.role == "user" }
        val currentRoundLines = if (lastUserIdx >= 0) lines.subList(lastUserIdx + 1, lines.size) else lines

        // 1. 优先检查 Agent 输出中是否包含 Markdown 任务清单（- [x] / - [ ]）
        val checklistSteps = mutableListOf<TaskStep>()
        for (line in currentRoundLines) {
            if (line.role == "assistant" || line.role == "agent") {
                val matches = CHECKLIST_REGEX.findAll(line.text).toList()
                if (matches.isNotEmpty()) {
                    var foundRunning = false
                    for (match in matches) {
                        val isChecked = match.groupValues[1].lowercase() == "x"
                        val text = match.groupValues[2].trim()
                        val status = when {
                            isChecked -> StepStatus.COMPLETED
                            running && !foundRunning -> {
                                foundRunning = true
                                StepStatus.RUNNING
                            }
                            else -> StepStatus.PENDING
                        }
                        checklistSteps.add(TaskStep(title = text, status = status))
                    }
                }
            }
        }
        if (checklistSteps.isNotEmpty()) {
            return checklistSteps
        }

        // 2. 如果没有显式 Markdown 清单，解析当前轮次的工具调用链（过滤单独的 result 回包避免重复计算）
        val toolSteps = mutableListOf<TaskStep>()
        val toolLines = currentRoundLines.filter {
            (it.toolName != null || it.kind == "tool/call") && it.kind != "tool/result"
        }

        if (toolLines.isNotEmpty()) {
            for (i in toolLines.indices) {
                val item = toolLines[i]
                val name = item.toolName ?: item.key.substringBefore(':')
                val readableName = friendlyToolName(name)
                val detail = item.toolArgs?.let { snippet(it) }

                val isLast = i == toolLines.lastIndex
                val status = when {
                    item.toolResult != null -> StepStatus.COMPLETED
                    isLast && running -> StepStatus.RUNNING
                    else -> StepStatus.COMPLETED
                }
                toolSteps.add(TaskStep(title = readableName, status = status, detail = detail))
            }
            return toolSteps
        }

        // 3. 正在运行中但尚未触发工具调用
        if (running) {
            return listOf(TaskStep(title = "正在分析指令并规划步骤…", status = StepStatus.RUNNING))
        }

        return emptyList()
    }

    private fun friendlyToolName(raw: String): String = when (raw) {
        "run_command" -> "执行终端命令"
        "read_file" -> "读取文件内容"
        "replace_file_content" -> "更新文件代码"
        "multi_replace_file_content" -> "批量修改文件"
        "write_to_file" -> "新建文件"
        "grep_search" -> "检索项目代码"
        "list_dir" -> "浏览工程目录"
        "view_file" -> "查看文件"
        "search_web" -> "联网搜索"
        else -> raw
    }

    private fun snippet(raw: String, maxLen: Int = 42): String {
        val clean = raw.replace("\n", " ").trim()
        return if (clean.length > maxLen) clean.take(maxLen) + "…" else clean
    }
}

/**
 * 任务进度与规划卡片（对齐 MiniMax team_plan_card / cycle_phase 交互规范）。
 *
 * 在多步骤工具执行或复杂计划执行期间，呈现清晰的进度条与分步状态。
 */
@Composable
fun TaskProgressCard(
    steps: List<TaskStep>,
    running: Boolean,
    modifier: Modifier = Modifier,
) {
    if (steps.isEmpty()) return

    val completedCount = steps.count { it.status == StepStatus.COMPLETED }
    val totalCount = steps.size
    val progress = if (totalCount > 0) completedCount.toFloat() / totalCount else 0f
    val currentStep = steps.firstOrNull { it.status == StepStatus.RUNNING }

    var expanded by remember { mutableStateOf(false) }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (running) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)
            else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f),
        ),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .animateContentSize(),
    ) {
        Column(Modifier.fillMaxWidth()) {
            // 顶栏概要（点击展开/收起）
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 图标
                Box(
                    Modifier
                        .size(24.dp)
                        .background(
                            if (running) MaterialTheme.colorScheme.primaryContainer
                            else MaterialTheme.colorScheme.surfaceContainerHighest,
                            CircleShape,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    if (running) {
                        val spin by rememberInfiniteTransition(label = "prog").animateFloat(
                            initialValue = 0f,
                            targetValue = 360f,
                            animationSpec = infiniteRepeatable(tween(1000)),
                            label = "spin",
                        )
                        CircularProgressIndicator(
                            progress = { spin / 360f },
                            modifier = Modifier.size(13.dp),
                            strokeWidth = 1.8.dp,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    } else {
                        DshIcon(
                            DshIcons.TaskList,
                            contentDescription = null,
                            size = 14.dp,
                            tint = if (completedCount == totalCount) DshTheme.online
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Spacer(Modifier.width(10.dp))

                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "任务规划与执行",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "$completedCount/$totalCount 步骤完成",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (completedCount == totalCount) DshTheme.online
                            else MaterialTheme.colorScheme.primary,
                        )
                    }
                    if (!expanded && currentStep != null) {
                        Spacer(Modifier.height(2.dp))
                        Text(
                            text = "正在执行: ${currentStep.title}",
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.5.sp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                Spacer(Modifier.width(6.dp))

                DshIcon(
                    if (expanded) DshIcons.ChevronUp else DshIcons.ChevronDown,
                    contentDescription = if (expanded) "收起" else "展开",
                    size = 16.dp,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // 细长进度指示条
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(2.5.dp),
                color = if (completedCount == totalCount) DshTheme.online else MaterialTheme.colorScheme.primary,
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )

            // 展开后的步骤清单
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut(),
            ) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 260.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    steps.forEachIndexed { idx, step ->
                        StepItemRow(index = idx + 1, step = step)
                    }
                }
            }
        }
    }
}

@Composable
private fun StepItemRow(index: Int, step: TaskStep) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (step.status) {
            StepStatus.COMPLETED -> {
                Box(
                    Modifier
                        .size(18.dp)
                        .background(DshTheme.online.copy(alpha = 0.15f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    DshIcon(
                        DshIcons.Check,
                        contentDescription = "已完成",
                        tint = DshTheme.online,
                        size = 11.dp,
                    )
                }
            }
            StepStatus.RUNNING -> {
                Box(
                    Modifier
                        .size(18.dp)
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(11.dp),
                        strokeWidth = 1.6.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            StepStatus.PENDING -> {
                Box(
                    Modifier
                        .size(18.dp)
                        .border(1.2.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "$index",
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                }
            }
        }

        Spacer(Modifier.width(10.dp))

        Column(Modifier.weight(1f)) {
            Text(
                text = step.title,
                style = MaterialTheme.typography.bodySmall.copy(
                    fontWeight = if (step.status == StepStatus.RUNNING) FontWeight.SemiBold else FontWeight.Normal,
                ),
                color = when (step.status) {
                    StepStatus.COMPLETED -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f)
                    StepStatus.RUNNING -> MaterialTheme.colorScheme.primary
                    StepStatus.PENDING -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            step.detail?.let {
                Text(
                    text = it,
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
