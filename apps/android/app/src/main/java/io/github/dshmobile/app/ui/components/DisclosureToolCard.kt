package io.github.dshmobile.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
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
import io.github.dshmobile.app.render.CodeCard
import io.github.dshmobile.app.ui.ChatLine
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.icons.DshIcons
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 工具调用与执行过程折叠卡片（对齐 DSH Web 端 `DisclosureRow` / `ToolCard` 规范）。
 *
 * ## 设计思想：
 * - 默认收起为单行摘要胶囊，不霸占手机屏幕；
 * - 醒目标记操作类型（执行终端命令、读写文件、搜索代码等）；
 * - 点击整条均可平滑展开/收起，展开后以生产级 [CodeCard] 展示入参和长输出，并自带一键复制。
 */
@Composable
fun DisclosureToolCard(
    line: ChatLine,
    modifier: Modifier = Modifier,
    initialExpanded: Boolean = false,
) {
    var expanded by remember { mutableStateOf(initialExpanded) }
    val isDark = isSystemInDarkTheme()

    val (toolSummary, toolIcon, targetSummary) = parseToolSummary(line)

    val toolTint = if (line.isError) {
        MaterialTheme.colorScheme.error
    } else {
        Color(0xFFA78BFA) // DSH Web 端 --meter-tint 工具紫
    }

    val cardBg = if (isDark) Color(0xFF181924) else Color(0xFFF6F7FA)
    val cardBorder = when {
        line.isError -> MaterialTheme.colorScheme.error.copy(alpha = 0.4f)
        isDark -> Color(0xFF282A3A)
        else -> Color(0xFFE2E4EC)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(cardBg)
            .border(1.dp, cardBorder, RoundedCornerShape(10.dp)),
    ) {
        // ── 胶囊头部栏（可点击切换折叠）──
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.weight(1f, fill = false),
            ) {
                // 图标圆角容器
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .background(toolTint.copy(alpha = 0.14f), RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    DshIcon(
                        imageVector = toolIcon,
                        contentDescription = null,
                        tint = toolTint,
                        size = 13.dp,
                    )
                }

                Spacer(Modifier.width(9.dp))

                // 动作名称
                Text(
                    text = toolSummary,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (line.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )

                if (targetSummary.isNotBlank()) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "· $targetSummary",
                        style = MaterialTheme.typography.labelSmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            // 右侧状态与展开提示
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = 8.dp),
            ) {
                if (line.isError) {
                    Box(
                        modifier = Modifier
                            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 5.dp, vertical = 2.dp),
                    ) {
                        Text(
                            text = "失败",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                            fontSize = 10.sp,
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                }

                Text(
                    text = if (expanded) "收起" else "展开",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    fontSize = 11.sp,
                )
                Spacer(Modifier.width(3.dp))
                DshIcon(
                    imageVector = if (expanded) DshIcons.ChevronUp else DshIcons.ChevronDown,
                    contentDescription = if (expanded) "收起" else "展开",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    size = 14.dp,
                )
            }
        }

        // ── 展开内容（入参 & 输出结果）──
        AnimatedVisibility(
            visible = expanded,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(if (isDark) Color(0xFF232535) else Color(0xFFE8EAF0)),
                )
                Spacer(Modifier.height(8.dp))

                // 1. 如果有输入参数
                // 展示**解码后并美化过的 JSON**，而不是原始的转义串 ——
                // 展开是为了看清楚，铺一屏 `\"` 反斜杠完全违背这个目的。
                val argsContent = line.toolArgs
                if (!argsContent.isNullOrBlank()) {
                    Text(
                        text = "调用参数 / 入参",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                    CodeCard(
                        code = prettyJson(argsContent),
                        language = guessLanguage(line.toolName, argsContent),
                        maxHeightLines = 25,
                    )
                    Spacer(Modifier.height(10.dp))
                }

                // 2. 如果有执行结果 / 输出
                val resultContent = line.toolResult ?: if (line.kind == "tool/result") line.text else null
                if (!resultContent.isNullOrBlank()) {
                    Text(
                        text = if (line.isError) "错误输出" else "执行结果 / 输出",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = if (line.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                    CodeCard(
                        code = resultContent,
                        language = "shell",
                        maxHeightLines = 30,
                    )
                }

                // 3. 如果两者都空，显示正文
                if (argsContent.isNullOrBlank() && resultContent.isNullOrBlank()) {
                    Text(
                        text = line.text,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }
            }
        }
    }
}

/**
 * 复用的 JSON 实例：`Json { }` 每次构造都有成本，
 * 而工具卡在长会话里会被频繁重组（流式输出时每来一个 token 就重画）。
 */
private val lenientJson = Json { isLenient = true; ignoreUnknownKeys = true }
private val prettyJsonFormat = Json { prettyPrint = true; isLenient = true }

/**
 * 把工具入参美化输出。
 *
 * `arguments` 是 JSON 字符串，先解析再格式化；
 * 解析失败（流式半截、非标准 JSON）就原样返回，绝不因为美化而丢内容。
 */
internal fun prettyJson(raw: String): String {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw
    return runCatching {
        val el = lenientJson.parseToJsonElement(trimmed)
        prettyJsonFormat.encodeToString(JsonElement.serializer(), el)
    }.getOrDefault(raw)
}

/** 智能解析工具名称与关键目标 */
private fun parseToolSummary(line: ChatLine): Triple<String, androidx.compose.ui.graphics.vector.ImageVector, String> {
    val name = line.toolName?.lowercase() ?: ""
    val args = line.toolArgs ?: ""
    val rawText = line.text

    return when {
        name.contains("command") || name.contains("exec") || name.contains("pwsh") || name.contains("bash") || name.contains("shell") -> {
            val cmd = extractArgValue(args, "CommandLine", "command", "cmd") ?: ""
            Triple("执行终端命令", DshIcons.Terminal, truncateTarget(cmd))
        }
        name.contains("replace") || name.contains("write") || name.contains("edit") -> {
            val file = extractArgValue(args, "TargetFile", "file", "path") ?: ""
            Triple("编辑文件", DshIcons.Code, shortFileName(file))
        }
        name.contains("view") || name.contains("read") -> {
            val file = extractArgValue(args, "AbsolutePath", "path", "file") ?: ""
            Triple("读取文件", DshIcons.Code, shortFileName(file))
        }
        name.contains("grep") || name.contains("search") || name.contains("find") -> {
            val query = extractArgValue(args, "Query", "query", "pattern") ?: ""
            Triple("搜索代码", DshIcons.Search, truncateTarget(query))
        }
        name.isNotBlank() -> {
            Triple("调用工具: ${line.toolName}", DshIcons.Cpu, "")
        }
        line.kind == "tool/result" -> {
            Triple(if (line.isError) "工具执行失败" else "工具执行完毕", DshIcons.Check, "")
        }
        else -> {
            Triple("系统过程", DshIcons.Sparkles, truncateTarget(rawText))
        }
    }
}

/**
 * 从工具入参里取某个字段的值。
 *
 * 🔴 必须**先按 JSON 解析**，正则只作兜底。
 *
 * 为什么：`arguments` 是 JSON 字符串，值里经常含转义引号和大段路径
 * （例如 `{"command":"$adb=\"C:\\Users\\...\""}`）。
 * 旧实现用 `"key"\s*:\s*"([^"]+)"` 直接正则匹配，遇到**值内含转义引号**时
 * 会在第一个 `\"` 处截断，取到的是一段残缺的乱码；键名大小写不一致时也取不到。
 * 现在先走真正的 JSON 解析（大小写不敏感查键），解析不出来再退回正则。
 */
private fun extractArgValue(jsonStr: String, vararg keys: String): String? {
    if (jsonStr.isBlank()) return null

    // 1. 优先真正的 JSON 解析：能正确处理转义、嵌套、非字符串值
    parseJsonObjectLeniently(jsonStr)?.let { obj ->
        for (key in keys) {
            val v = obj[key] ?: obj.entries.firstOrNull { it.key.equals(key, ignoreCase = true) }?.value
            when (v) {
                is JsonPrimitive -> {
                    if (v.isString) return v.content
                    if (v.content != "null") return v.content
                }
                is JsonArray -> return v.joinToString(" ") { (it as? JsonPrimitive)?.content ?: it.toString() }
                is JsonObject -> return v.toString()
                else -> Unit
            }
        }
    }

    // 2. 兜底：正则，但**允许转义引号**（[^"\\] 或 \\. 交替），避免在 \" 处截断
    for (key in keys) {
        val pattern = Regex("\"$key\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"", RegexOption.IGNORE_CASE)
        val match = pattern.find(jsonStr)
        if (match != null) {
            return unescapeJsonString(match.groupValues[1])
        }
    }
    return null
}

/** 宽松解析：解析失败返回 null，绝不抛异常（渲染路径上崩溃不可接受）。 */
private fun parseJsonObjectLeniently(raw: String): JsonObject? = runCatching {
    lenientJson.parseToJsonElement(raw.trim()) as? JsonObject
}.getOrNull()

/** 把 JSON 字符串里的转义序列还原成真实字符。 */
private fun unescapeJsonString(s: String): String {
    val sb = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '\\' && i + 1 < s.length) {
            when (val n = s[i + 1]) {
                'n' -> sb.append('\n')
                't' -> sb.append('\t')
                'r' -> sb.append('\r')
                '"' -> sb.append('"')
                '\\' -> sb.append('\\')
                '/' -> sb.append('/')
                'b' -> sb.append('\b')
                'f' -> sb.append('\u000C')
                'u' -> {
                    val hex = s.substring(i + 2, minOf(i + 6, s.length))
                    val code = hex.toIntOrNull(16)
                    if (code != null) {
                        sb.append(code.toChar())
                        i += 4
                    } else {
                        sb.append(n)
                    }
                }
                else -> sb.append(n)
            }
            i += 2
        } else {
            sb.append(c)
            i++
        }
    }
    return sb.toString()
}

private fun shortFileName(fullPath: String): String {
    if (fullPath.isBlank()) return ""
    val normalized = fullPath.replace('\\', '/').trimEnd('/')
    return normalized.substringAfterLast('/')
}

private fun truncateTarget(s: String, maxLen: Int = 26): String {
    val clean = s.trim().replace('\n', ' ')
    return if (clean.length <= maxLen) clean else clean.take(maxLen) + "…"
}

private fun guessLanguage(toolName: String?, content: String): String {
    val name = toolName?.lowercase() ?: ""
    return when {
        name.contains("command") || name.contains("exec") || name.contains("shell") -> "shell"
        content.trimStart().startsWith("{") || content.trimStart().startsWith("[") -> "json"
        else -> "text"
    }
}
