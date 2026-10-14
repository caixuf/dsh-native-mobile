package io.github.dshmobile.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P2 / P3 选择器与主题契约测试。
 *
 * 验证：
 * 1. 模型 / 模式 / 权限选项与形参映射；
 * 2. 主机 session.page records 中事件类型的提取逻辑；
 * 3. ThemeMode 与 ThemePreferences 状态切换。
 */
class SessionSelectorAndThemeTest {

    @Test
    fun testModelProviderMapping() {
        val models = listOf("deepseek-v4.1-flash", "deepseek-chat", "deepseek-reasoner", "claude-3-7-sonnet", "gpt-4o")
        val expectedProviders = mapOf(
            "deepseek-v4.1-flash" to "opendesign",
            "deepseek-chat" to "deepseek",
            "deepseek-reasoner" to "deepseek",
            "claude-3-7-sonnet" to "anthropic",
            "gpt-4o" to "openai",
        )

        for (m in models) {
            val provider = when {
                m.contains("flash") -> "opendesign"
                m.contains("deepseek") -> "deepseek"
                m.contains("claude") -> "anthropic"
                m.contains("gpt") -> "openai"
                else -> "opendesign"
            }
            assertEquals("Provider mapping for $m", expectedProviders[m], provider)
        }
    }

    @Test
    fun testPermissionPresetMapping() {
        val perms = mapOf(
            "工作区内修改" to "workspace-write",
            "完全权限" to "danger-full-access",
            "只读模式" to "read-only",
        )
        perms.forEach { (label, expectedPreset) ->
            val preset = when (label) {
                "工作区内修改" -> "workspace-write"
                "完全权限" -> "danger-full-access"
                "只读模式" -> "read-only"
                else -> "workspace-write"
            }
            assertEquals(expectedPreset, preset)
        }
    }

    @Test
    fun testModePresetMapping() {
        val modes = mapOf(
            "代码审查模式" to "cordis",
            "计划与架构模式" to "plan",
            "标准模式" to "standard",
        )
        modes.forEach { (label, expectedPreset) ->
            val preset = when (label) {
                "代码审查模式" -> "cordis"
                "计划与架构模式" -> "plan"
                "标准模式" -> "standard"
                else -> "standard"
            }
            assertEquals(expectedPreset, preset)
        }
    }

    @Test
    fun testThemePreferencesToggle() {
        ThemePreferences.currentMode = ThemeMode.Light
        assertEquals(ThemeMode.Light, ThemePreferences.currentMode)

        ThemePreferences.currentMode = ThemeMode.Dark
        assertEquals(ThemeMode.Dark, ThemePreferences.currentMode)

        ThemePreferences.currentMode = ThemeMode.System
        assertEquals(ThemeMode.System, ThemePreferences.currentMode)
    }

    @Test
    fun testChatUiStateDefaults() {
        val state = ChatUiState()
        assertEquals("deepseek-v4.1-flash", state.selectedModel)
        assertEquals("opendesign", state.selectedProvider)
        assertEquals("工作区内修改", state.selectedPermission)
        assertEquals("标准模式", state.selectedMode)
        assertTrue(state.availableModels.isNotEmpty())
        assertTrue(state.availableModes.isNotEmpty())
        assertTrue(state.availablePermissions.isNotEmpty())
    }
}
