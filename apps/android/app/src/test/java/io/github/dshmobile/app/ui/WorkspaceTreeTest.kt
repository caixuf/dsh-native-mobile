package io.github.dshmobile.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工作区/会话树分组与 WSL 路径解析单元测试（P1）。
 */
class WorkspaceTreeTest {

    @Test
    fun testWslPathFormatting() {
        val (name1, sub1) = WorkspaceFormatter.format("""\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine""")
        assertEquals("Ubuntu · FlowEngine", name1)
        assertEquals("""\\wsl.localhost\Ubuntu\home\caixuf\code\FlowEngine""", sub1)

        val (name2, sub2) = WorkspaceFormatter.format("""\\wsl$\Ubuntu\home\caixuf\code\FlowEngine""")
        assertEquals("Ubuntu · FlowEngine", name2)

        val (name3, sub3) = WorkspaceFormatter.format("""\\wsl.localhost\Debian\opt\project""")
        assertEquals("Debian · project", name3)
    }

    @Test
    fun testWindowsAndPosixPathFormatting() {
        val (winName, winSub) = WorkspaceFormatter.format("""C:\Users\20247\Downloads\aiwork\dsh-native-mobile""")
        assertEquals("dsh-native-mobile", winName)
        assertEquals("""C:\Users\20247\Downloads\aiwork\dsh-native-mobile""", winSub)

        val (posixName, _) = WorkspaceFormatter.format("/home/caixuf/code/FlowEngine")
        assertEquals("FlowEngine", posixName)

        val (defaultName, defaultSub) = WorkspaceFormatter.format(null)
        assertEquals("默认工作区", defaultName)
        assertEquals("未关联宿主目录", defaultSub)

        val (emptyName, _) = WorkspaceFormatter.format("   ")
        assertEquals("默认工作区", emptyName)
    }

    @Test
    fun testGroupSessionsAggregationAndSorting() {
        val now = System.currentTimeMillis()
        val s1 = SessionRow("1", "Win Session 1", "", now - 1000, running = false, workspace = """C:\code\repoA""")
        val s2 = SessionRow("2", "Win Session 2", "", now, running = true, workspace = """C:\code\repoA""")
        val s3 = SessionRow("3", "WSL Session 1", "", now + 1000, running = false, workspace = """\\wsl.localhost\Ubuntu\home\repoB""")
        val sa1 = SessionRow("sa1", "Subagent 1", "", now - 500, running = false, isSubagent = true, workspace = """C:\code\repoA""")

        val groups = WorkspaceFormatter.groupSessions(
            sessions = listOf(s1, s2, s3),
            subagents = listOf(sa1),
        )

        assertEquals(2, groups.size)
        // repoA 含有正在运行的会话 (s2.running == true)，因此优先排在最前
        val first = groups[0]
        assertEquals("repoA", first.displayName)
        assertTrue("含运行中会话的组优先置顶", first.isRunning)
        assertEquals(1, first.runningCount)
        assertEquals(2, first.sessions.size)
        assertEquals(1, first.subagents.size)
        assertEquals("2", first.sessions[0].sessionId) // 组内按 updatedAt 倒序

        val second = groups[1]
        assertEquals("Ubuntu · repoB", second.displayName)
        assertFalse(second.isRunning)
        assertEquals(1, second.sessions.size)
    }
}
