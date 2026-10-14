package io.github.dshmobile.app.ui

/**
 * 工作区聚合模型（P1）。
 *
 * 权威事实：
 * DSH 宿主没有 `workspace/list` RPC，工作区列表必须从 `session/list` 的 `cwd` 字段聚合并派生。
 * 一台主机可能包含多个工作区（含 WSL 路径）。
 */
data class WorkspaceGroup(
    /** 宿主工作区路径；null 或空白表示未关联目录的临时会话。 */
    val cwd: String?,
    /** 友好显示名称，例如 `Ubuntu · FlowEngine` 或 `dsh-native-mobile`。 */
    val displayName: String,
    /** 副标题/完整路径展示。 */
    val subtitle: String,
    /** 该工作区下的所有普通主会话（按 updatedAt 倒序）。 */
    val sessions: List<SessionRow>,
    /** 该工作区下的子代理会话（origin == "subagent"）。 */
    val subagents: List<SessionRow> = emptyList(),
    /** 组内运行中会话总数。 */
    val runningCount: Int = 0,
    /** 组内最新活跃时间戳。 */
    val latestUpdatedAt: Long = 0L,
) {
    val totalCount: Int get() = sessions.size + subagents.size
    val isRunning: Boolean get() = runningCount > 0

    /**
     * 是否是 DSH 的**内部目录**（不是用户真正的工作区）。
     *
     * 🔴 为什么必须区分（2026-10-14 用真实数据实测）：
     *
     * 你主机上 115 条会话按 cwd 分成 8 组，但其中两组是 DSH 自己产生的：
     *
     * | 会话数 | 路径 | 性质 |
     * |---|---|---|
     * | 39 | `C:\Users\...\.dsh\profiles\desktop` | DSH 配置目录 |
     * | 14 | `...\.dsh\profiles\desktop\node_modules\dsh-bot-gateway\runtime-data\users\telegram-...` | 机器人运行时数据 |
     *
     * 加起来 **53 条（46%）是系统噪音**。它们和真正的工作区平铺在一起，
     * 会把用户真正关心的 `aiwork`、`FlowEngine` 挤到下面 —— 这正是"看着乱"的来源。
     *
     * 处理策略：**不删除、不隐藏**（用户可能确实想进去看），
     * 而是标记出来，由 UI 折叠到一个「系统目录」分组里默认收起。
     * 这样既不丢数据，首屏又只留真正的工作区。
     */
    val isSystemDir: Boolean
        get() {
            val key = WorkspaceFormatter.normalizeKey(cwd)
            if (key.isEmpty()) return false
            return key.contains("/.dsh/") ||
                key.endsWith("/.dsh") ||
                key.contains("/node_modules/") ||
                key.contains("/runtime-data/") ||
                key.contains("/appdata/roaming/")
        }
}

object WorkspaceFormatter {

    /**
     * 路径归一化 —— **分组的唯一依据**。
     *
     * 🔴 实测发现（2026-10-14）：直接拿 `cwd` 字符串分组会**把同一个目录拆成多个组**，
     * 屏幕上出现好几个同名的「aiwork」，比不分组还乱。实测到的三种变体：
     *
     * | 输入 A | 输入 B | 旧行为 | 正确行为 |
     * |---|---|---|---|
     * | `C:\...\aiwork` | `c:\users\...\aiwork` | 2 个组 ❌ | 1 个组 |
     * | `C:\...\aiwork` | `C:\...\aiwork\` | 2 个组 ❌ | 1 个组 |
     * | `\\wsl.localhost\Ubuntu\...` | `\\wsl$\Ubuntu\...` | 2 个组 ❌ | 1 个组 |
     *
     * 归一化规则：
     *  1. 去首尾空白、去掉**结尾分隔符**（`\` 与 `/` 都算，且可以叠加）；
     *  2. 反斜杠统一为正斜杠，便于比较；
     *  3. WSL UNC 前缀统一 —— `\\wsl$\` 与 `\\wsl.localhost\` 指向同一台机器；
     *  4. **大小写折叠**：Windows 路径大小写不敏感，Linux 路径敏感，
     *     但作为"展示分组"用途，折叠更符合直觉（宁可合并也不要拆散）。
     *     真出现大小写不同的两个真实目录时，影响也只是显示合并 —— 可接受。
     *  5. `null` 与空白统一成一个哨兵值，归为「默认工作区」。
     *
     * ⚠️ 归一化**只用于分组比较**，展示仍用原始路径（见 [format] 的 subtitle）。
     */
    fun normalizeKey(rawPath: String?): String {
        val t = rawPath?.trim() ?: return ""
        if (t.isBlank()) return ""

        // 去掉所有结尾分隔符（`C:\a\\` 这种也覆盖）
        var s = t.trimEnd('\\', '/')
        if (s.isBlank()) return ""

        // 反斜杠统一成正斜杠
        s = s.replace('\\', '/')

        // WSL UNC 前缀统一：//wsl.localhost/Ubuntu/... 与 //wsl$/Ubuntu/... 视为同一台。
        //
        // ⚠️ 这里**不能用 `String.replace(Regex, String)`** —— 它的替换串里
        // `$` 是反向引用语法，而我们的替换目标恰好是 `//wsl$/`，
        // 会被解析成"组引用"并抛 `IllegalArgumentException: Illegal group reference`（踩过）。
        // 用普通字符串替换（非正则）最稳：前缀是固定字面量，不需要正则。
        if (s.regionMatches(0, "//wsl.localhost/", 0, 16, ignoreCase = true)) {
            s = "//wsl$/" + s.substring(16)
        } else if (s.regionMatches(0, "//wsl$/", 0, 7, ignoreCase = true)) {
            // 已是统一形态，但要修掉大小写（如 //WSL$/）
            s = "//wsl$/" + s.substring(7)
        }

        return s.lowercase()
    }

    /**
     * 将原始路径转换为友好格式（对齐任务 9）。
     *
     * 规则：
     * 1. WSL 路径：
     *    `\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine` 或 `\\wsl$\Ubuntu\...`
     *    -> `Ubuntu · FlowEngine`
     * 2. Windows 盘符路径：
     *    `C:\Users\20247\Downloads\aiwork\dsh-native-mobile` -> `dsh-native-mobile`
     * 3. Linux/Unix 路径：
     *    `/home/caixuf/code/FlowEngine` -> `FlowEngine`
     * 4. 空/未绑定：
     *    `默认工作区`
     */
    fun format(rawPath: String?): Pair<String, String> {
        val trimmed = rawPath?.trim()?.trimEnd('\\', '/') ?: return "默认工作区" to "未关联宿主目录"
        if (trimmed.isBlank()) return "默认工作区" to "未关联宿主目录"

        // 匹配 WSL UNC 路径：
        // \\wsl.localhost\<Distro>\<Path...> 或 \\wsl$\<Distro>\<Path...>
        val wslRegex = Regex("""^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$""", RegexOption.IGNORE_CASE)
        val wslMatch = wslRegex.find(trimmed)
        if (wslMatch != null) {
            val distro = wslMatch.groupValues[1]
            val innerPath = wslMatch.groupValues[2].replace('\\', '/')
            val lastSegment = innerPath.split('/').filter { it.isNotBlank() }.lastOrNull() ?: distro
            return "$distro · $lastSegment" to trimmed
        }

        // 普通路径（Windows 驱动器盘符或 POSIX 路径）
        val normalized = trimmed.replace('\\', '/')
        val parts = normalized.split('/').filter { it.isNotBlank() }
        val lastSegment = parts.lastOrNull() ?: trimmed
        return lastSegment to trimmed
    }

    /**
     * 将会话列表（主会话与子代理会话）按工作区 cwd 分组，并按业务规则排序：
     * 1. 存在运行中会话的组优先排在前面；
     * 2. 其余按最新活跃时间降序排列；
     * 3. 组内会话按 updatedAt 降序排序。
     *
     * 🔴 分组键用 [normalizeKey] 而不是原始字符串 —— 否则同一目录的
     * 大小写/结尾分隔符/WSL 前缀变体会被拆成多个同名组（实测踩到）。
     * 组内仍保留**原始 cwd** 用于展示。
     */
    fun groupSessions(
        sessions: List<SessionRow>,
        subagents: List<SessionRow> = emptyList(),
    ): List<WorkspaceGroup> {
        // 按归一化键聚合；原始 cwd 取该组第一个非空值用于展示。
        val all = sessions + subagents
        val grouped = LinkedHashMap<String, MutableList<SessionRow>>()
        for (row in all) {
            grouped.getOrPut(normalizeKey(row.workspace)) { mutableListOf() }.add(row)
        }

        return grouped.map { (_, rows) ->
            val wsSessions = rows.filterNot { it.isSubagent }.sortedByDescending { it.updatedAt }
            val wsSubagents = rows.filter { it.isSubagent }.sortedByDescending { it.updatedAt }
            // 展示用原始路径：优先取普通会话的，其次子代理的
            val rawCwd = (wsSessions + wsSubagents).firstNotNullOfOrNull {
                it.workspace?.takeIf { w -> w.isNotBlank() }
            }
            val (name, sub) = format(rawCwd)
            val runningCount = rows.count { it.running }
            val latestTime = rows.maxOfOrNull { it.updatedAt } ?: 0L

            WorkspaceGroup(
                cwd = rawCwd,
                displayName = name,
                subtitle = sub,
                sessions = wsSessions,
                subagents = wsSubagents,
                runningCount = runningCount,
                latestUpdatedAt = latestTime,
            )
        }.sortedWith(
            // 排序优先级：
            //  1. **用户工作区排在系统目录之前** —— 首屏先看到真正关心的东西
            //  2. 有运行中会话的组置顶（用户正在等结果）
            //  3. 其余按最新活跃时间倒序
            compareBy<WorkspaceGroup> { it.isSystemDir }
                .thenByDescending { it.runningCount > 0 }
                .thenByDescending { it.latestUpdatedAt }
        )
    }
}
