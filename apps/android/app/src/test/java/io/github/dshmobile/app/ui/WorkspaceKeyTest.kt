package io.github.dshmobile.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工作区路径归一化测试（P1 回归）。
 *
 * 🔴 实测发现（2026-10-14，独立复核 Gem 的聚合逻辑时抓到）：
 *
 * 直接拿 `cwd` 字符串分组，会**把同一个目录拆成多个组**，
 * 屏幕上出现好几个同名的「aiwork」—— 比不分组还乱。实测三种变体：
 *
 * | A | B | 旧行为 | 现在 |
 * |---|---|---|---|
 * | `C:\...\aiwork` | `c:\users\...\aiwork` | 2 组 ❌ | 1 组 |
 * | `C:\...\aiwork` | `C:\...\aiwork\` | 2 组 ❌ | 1 组 |
 * | `\\wsl.localhost\Ubuntu\...` | `\\wsl$\Ubuntu\...` | 2 组 ❌ | 1 组 |
 *
 * 这条测试锁死修复，防止再退回"字符串精确比较"。
 */
class WorkspaceKeyTest {

    // ── normalizeKey 本身 ───────────────────────────────────────────────────

    @Test
    fun `case differences normalize to the same key`() {
        assertEquals(
            "Windows 路径大小写不敏感",
            WorkspaceFormatter.normalizeKey("""C:\Users\20247\Downloads\aiwork"""),
            WorkspaceFormatter.normalizeKey("""c:\users\20247\downloads\aiwork"""),
        )
    }

    @Test
    fun `trailing separators normalize away`() {
        val base = """C:\Users\20247\Downloads\aiwork"""
        val expected = WorkspaceFormatter.normalizeKey(base)
        assertEquals("结尾反斜杠应被忽略", expected, WorkspaceFormatter.normalizeKey("$base\\"))
        assertEquals("结尾正斜杠应被忽略", expected, WorkspaceFormatter.normalizeKey("$base/"))
        assertEquals("重复分隔符应被忽略", expected, WorkspaceFormatter.normalizeKey("$base\\\\"))
    }

    @Test
    fun `wsl localhost and wsl dollar prefix unify`() {
        assertEquals(
            "两种 WSL UNC 前缀指向同一台机器",
            WorkspaceFormatter.normalizeKey("""\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine"""),
            WorkspaceFormatter.normalizeKey("""\\wsl$\Ubuntu\home\caixuf\code\FlowEngine"""),
        )
    }

    @Test
    fun `surrounding whitespace is ignored`() {
        assertEquals(
            WorkspaceFormatter.normalizeKey("/home/user/proj"),
            WorkspaceFormatter.normalizeKey("  /home/user/proj  "),
        )
    }

    @Test
    fun `null and blank share one sentinel key`() {
        assertEquals("null 与空白应归为一组", "", WorkspaceFormatter.normalizeKey(null))
        assertEquals("", WorkspaceFormatter.normalizeKey("   "))
        assertEquals("", WorkspaceFormatter.normalizeKey(""))
    }

    @Test
    fun `genuinely different paths stay different`() {
        assertFalse(
            "不同目录不能被误合并",
            WorkspaceFormatter.normalizeKey("/home/user/projA") ==
                WorkspaceFormatter.normalizeKey("/home/user/projB"),
        )
    }

    // ── 分组结果 ────────────────────────────────────────────────────────────

    private fun row(
        id: String,
        workspace: String?,
        updated: Long = 0,
        running: Boolean = false,
        sub: Boolean = false,
    ) = SessionRow(id, "t$id", "", updated, running = running, isSubagent = sub, workspace = workspace)

    @Test
    fun `same directory written differently groups into one`() {
        val groups = WorkspaceFormatter.groupSessions(
            listOf(
                row("1", """C:\Users\20247\Downloads\aiwork""", 1000),
                row("2", """c:\users\20247\downloads\aiwork""", 2000),
                row("3", """C:\Users\20247\Downloads\aiwork\""", 3000),
            ),
        )
        assertEquals("🔴 同一目录的三种写法必须合成一个组", 1, groups.size)
        assertEquals(3, groups[0].sessions.size)
        // 展示名取目录末段
        assertEquals("aiwork", groups[0].displayName)
    }

    @Test
    fun `wsl variants group into one`() {
        val groups = WorkspaceFormatter.groupSessions(
            listOf(
                row("1", """\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine""", 1000),
                row("2", """\\wsl$\Ubuntu\home\caixuf\code\FlowEngine""", 2000),
            ),
        )
        assertEquals(1, groups.size)
        assertEquals("Ubuntu · FlowEngine", groups[0].displayName)
    }

    @Test
    fun `null workspace sessions group together as default`() {
        val groups = WorkspaceFormatter.groupSessions(
            listOf(row("1", null, 1000), row("2", null, 2000), row("3", "   ", 3000)),
        )
        assertEquals("未绑定目录的会话应合成一个默认组", 1, groups.size)
        assertEquals("默认工作区", groups[0].displayName)
        assertEquals(3, groups[0].sessions.size)
    }

    @Test
    fun `display keeps the original path not the normalized one`() {
        val raw = """C:\Users\20247\Downloads\aiwork"""
        val groups = WorkspaceFormatter.groupSessions(listOf(row("1", raw)))
        assertEquals("subtitle 应保留原始路径（归一化只用于比较）", raw, groups[0].subtitle)
    }

    @Test
    fun `subagents attach to the group of their workspace`() {
        val groups = WorkspaceFormatter.groupSessions(
            sessions = listOf(row("1", """C:\repo""", 1000)),
            subagents = listOf(row("sa", """C:\repo""", 500, sub = true)),
        )
        assertEquals(1, groups.size)
        assertEquals(1, groups[0].sessions.size)
        assertEquals(1, groups[0].subagents.size)
        assertEquals("子代理也应计入总数", 2, groups[0].totalCount)
    }

    @Test
    fun `group with only subagents still appears`() {
        val groups = WorkspaceFormatter.groupSessions(
            sessions = emptyList(),
            subagents = listOf(row("sa", """C:\only\sub""", 100, sub = true)),
        )
        assertEquals("只有子代理的工作区不能消失", 1, groups.size)
        assertEquals(1, groups[0].subagents.size)
    }

    @Test
    fun `running group sorts first`() {
        val groups = WorkspaceFormatter.groupSessions(
            listOf(
                row("1", """C:\idle""", 9000, running = false),
                row("2", """C:\busy""", 1000, running = true),
            ),
        )
        assertEquals("busy", groups[0].displayName)
        assertTrue(groups[0].isRunning)
        assertEquals(1, groups[0].runningCount)
    }

    @Test
    fun `empty input yields no groups`() {
        assertEquals(0, WorkspaceFormatter.groupSessions(emptyList()).size)
        assertEquals(0, WorkspaceFormatter.groupSessions(emptyList(), emptyList()).size)
    }

    @Test
    fun `sessions inside a group sort by updatedAt descending`() {
        val groups = WorkspaceFormatter.groupSessions(
            listOf(
                row("old", """C:\repo""", 1000),
                row("new", """C:\repo""", 9000),
                row("mid", """C:\repo""", 5000),
            ),
        )
        assertEquals(listOf("new", "mid", "old"), groups[0].sessions.map { it.sessionId })
    }

    @Test
    fun `formatter handles wsl and windows and posix and default`() {
        assertEquals("Ubuntu · FlowEngine", WorkspaceFormatter.format("""\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine""").first)
        assertEquals("FlowEngine", WorkspaceFormatter.format("/home/caixuf/code/FlowEngine").first)
        assertEquals("dsh-native-mobile", WorkspaceFormatter.format("""C:\Users\20247\Downloads\aiwork\dsh-native-mobile""").first)
        assertEquals("默认工作区", WorkspaceFormatter.format(null).first)
        assertEquals("默认工作区", WorkspaceFormatter.format("   ").first)
    }

    // ── 系统目录识别 ────────────────────────────────────────────────────────
    //
    // 实测：115 条会话里 **53 条（46%）** 落在 DSH 内部目录，
    // 与真正的工作区平铺会把用户关心的内容挤下去。

    @Test
    fun `dsh internal directories are flagged as system`() {
        val cases = listOf(
            """C:\Users\20247\.dsh\profiles\desktop""",
            """C:\Users\20247\.dsh\profiles\desktop\node_modules\dsh-bot-gateway\runtime-data\users\telegram-8192862144""",
            "/home/user/.dsh/profiles/desktop",
            """C:\Users\me\AppData\Roaming\something""",
        )
        for (c in cases) {
            val g = WorkspaceFormatter.groupSessions(listOf(row("1", c)))[0]
            assertTrue("应识别为系统目录: $c", g.isSystemDir)
        }
    }

    @Test
    fun `real user workspaces are not flagged as system`() {
        val cases = listOf(
            """C:\Users\20247\Downloads\aiwork""",
            """C:\Users\20247\Downloads\aiwork\dsh-native-mobile""",
            """\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine""",
            "/home/caixuf/code/claude-code-providers",
        )
        for (c in cases) {
            val g = WorkspaceFormatter.groupSessions(listOf(row("1", c)))[0]
            assertFalse("不该被当成系统目录: $c", g.isSystemDir)
        }
    }

    @Test
    fun `user workspaces sort before system directories`() {
        val groups = WorkspaceFormatter.groupSessions(
            listOf(
                // 系统目录更新更晚、会话更多，但必须排在后面
                row("sys1", """C:\Users\20247\.dsh\profiles\desktop""", 9000),
                row("sys2", """C:\Users\20247\.dsh\profiles\desktop""", 9000),
                row("u1", """C:\Users\20247\Downloads\aiwork""", 1000),
            ),
        )
        assertEquals("🔴 用户工作区必须排在系统目录之前", "aiwork", groups[0].displayName)
        assertFalse(groups[0].isSystemDir)
        assertTrue("系统目录仍要保留（只是排后面）", groups.any { it.isSystemDir })
    }

    @Test
    fun `default workspace is not a system dir`() {
        val g = WorkspaceFormatter.groupSessions(listOf(row("1", null)))[0]
        assertFalse("未绑定目录不应被当成系统目录", g.isSystemDir)
    }
}
