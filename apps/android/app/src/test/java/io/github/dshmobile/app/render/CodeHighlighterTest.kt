package io.github.dshmobile.app.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeHighlighterTest {

    @Test
    fun `empty code returns empty string`() {
        val result = CodeHighlighter.highlight("")
        assertEquals("", result.text)
    }

    @Test
    fun `highlights kotlin keywords`() {
        val code = "fun calculate(x: Int): Boolean {\n    return x > 0\n}"
        val result = CodeHighlighter.highlight(code, "kotlin")
        assertEquals(code, result.text)
        assertTrue("应包含高亮样式", result.spanStyles.isNotEmpty())
    }

    @Test
    fun `highlights string literals`() {
        val code = "val msg = \"Hello World\""
        val result = CodeHighlighter.highlight(code, "kotlin")
        assertEquals(code, result.text)
        assertTrue(result.spanStyles.isNotEmpty())
    }

    @Test
    fun `highlights comments`() {
        val code = "// This is a comment\nval a = 1"
        val result = CodeHighlighter.highlight(code, "kotlin")
        assertEquals(code, result.text)
        assertTrue(result.spanStyles.isNotEmpty())
    }
}
