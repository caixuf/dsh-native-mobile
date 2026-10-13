package io.github.dshmobile.app.render

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight

/**
 * 生产级轻量语法高亮引擎。
 *
 * ## 为什么不引大体量三方库（如 Prism / highlight.js / tree-sitter）
 * - 纯 Android 原生 Compose 场景，无额外 Native 或 JS 引擎开销；
 * - 毫秒级正则 Tokenizer，针对移动端流式与长代码块极致优化；
 * - 采用现代深色主题经典配色（Tokyo Night / VS Code Dark+ 调色体系）：
 *   - 关键字 (Keyword)：紫蓝 #9D7CD8 / #7AA2F7
 *   - 字符串 (String)：柔绿 #9ECE6A
 *   - 数字/布尔 (Number/Bool)：暖橙 #FF9E64
 *   - 注释 (Comment)：柔灰带斜体 #636F8E
 *   - 类型/注解 (Type/Annotation)：青蓝 #2AC3DE
 *   - 标点/符号 (Punctuation)：淡青灰 #A9B1D6
 */
object CodeHighlighter {

    private val ColorKeyword = Color(0xFFBB9AF7)       // 优雅紫
    private val ColorControl = Color(0xFF7AA2F7)       // 控制流蓝
    private val ColorString = Color(0xFF9ECE6A)        // 柔和草绿
    private val ColorNumber = Color(0xFFFF9E64)        // 柔和橙
    private val ColorBoolean = Color(0xFFF7768E)       // 亮珊瑚红
    private val ColorComment = Color(0xFF717C9B)       // 低饱和蓝灰
    private val ColorType = Color(0xFF2AC3DE)          // 亮青
    private val ColorAnnotation = Color(0xFFE0AF68)    // 姜黄
    private val ColorDefault = Color(0xFFCFD5EA)       // 默认代码文字

    private val KEYWORDS_COMMON = setOf(
        // Kotlin / Java
        "fun", "val", "var", "class", "interface", "object", "data", "sealed", "enum",
        "override", "public", "private", "protected", "internal", "package", "import",
        "return", "if", "else", "when", "for", "while", "do", "break", "continue",
        "try", "catch", "finally", "throw", "throwable", "super", "this", "new",
        "extends", "implements", "static", "final", "abstract", "suspend", "inline",
        // JS / TS
        "const", "let", "function", "export", "default", "from", "async", "await",
        "type", "declare", "module", "namespace", "typeof", "instanceof", "yield",
        // Python
        "def", "elif", "except", "with", "as", "pass", "lambda", "global", "nonlocal",
        "raise", "yield", "assert",
        // Rust / Go / C / C++
        "fn", "mut", "let", "impl", "trait", "pub", "struct", "match", "loop", "go",
        "func", "chan", "defer", "const", "extern", "void", "int", "char", "bool",
        // SQL
        "select", "insert", "update", "delete", "from", "where", "group", "by", "order",
        "having", "limit", "join", "left", "right", "inner", "outer", "on", "as", "create",
        "table", "view", "index", "drop", "alter",
        // Shell
        "echo", "exit", "set", "cd", "ls", "grep", "cat", "mkdir", "rm", "cp", "mv",
        "sudo", "chmod", "chown", "curl", "wget", "git", "adb", "gradlew", "npm", "pnpm",
    )

    private val BOOLEANS_AND_NULL = setOf(
        "true", "false", "null", "nil", "None", "undefined", "NaN", "TRUE", "FALSE", "NULL",
    )

    /**
     * 将代码字符串渲染为带语法高亮的 [AnnotatedString]。
     */
    fun highlight(code: String, language: String? = null): AnnotatedString {
        if (code.isBlank()) {
            return buildAnnotatedString {
                append(code)
            }
        }

        val lang = language?.lowercase()?.trim()

        return buildAnnotatedString {
            val lines = code.split('\n')
            var inMultiLineComment = false

            lines.forEachIndexed { lineIdx, line ->
                if (lineIdx > 0) append("\n")

                if (inMultiLineComment) {
                    val endCommentIdx = line.indexOf("*/")
                    if (endCommentIdx != -1) {
                        val commentPart = line.substring(0, endCommentIdx + 2)
                        pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                        append(commentPart)
                        pop()
                        inMultiLineComment = false
                        val rest = line.substring(endCommentIdx + 2)
                        highlightLine(rest, lang)
                    } else {
                        pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                        append(line)
                        pop()
                    }
                    return@forEachIndexed
                }

                // 单行全行注释
                val trimmed = line.trimStart()
                if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--")) {
                    pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                    append(line)
                    pop()
                    return@forEachIndexed
                }

                // 检查多行注释起始
                val multiStart = line.indexOf("/*")
                if (multiStart != -1 && !line.substring(0, multiStart).contains("\"")) {
                    val multiEnd = line.indexOf("*/", multiStart + 2)
                    if (multiEnd != -1) {
                        // 同一行内闭合的多行注释
                        highlightLine(line.substring(0, multiStart), lang)
                        pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                        append(line.substring(multiStart, multiEnd + 2))
                        pop()
                        highlightLine(line.substring(multiEnd + 2), lang)
                    } else {
                        // 跨行注释起始
                        highlightLine(line.substring(0, multiStart), lang)
                        pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                        append(line.substring(multiStart))
                        pop()
                        inMultiLineComment = true
                    }
                    return@forEachIndexed
                }

                // 逐行解析
                highlightLine(line, lang)
            }
        }
    }

    private fun AnnotatedString.Builder.highlightLine(line: String, lang: String?) {
        var idx = 0
        val len = line.length

        while (idx < len) {
            val c = line[idx]

            // 1. 行内单行注释 (//, #, --)
            if (c == '/' && idx + 1 < len && line[idx + 1] == '/') {
                pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                append(line.substring(idx))
                pop()
                break
            }
            if ((c == '#' && (lang in listOf("py", "python", "sh", "bash", "shell", "yaml", "yml") || lang == null)) ||
                (c == '-' && idx + 1 < len && line[idx + 1] == '-' && (lang == "sql" || lang == null))
            ) {
                pushStyle(SpanStyle(color = ColorComment, fontStyle = FontStyle.Italic))
                append(line.substring(idx))
                pop()
                break
            }

            // 2. 字符串字面量 ("...", '...', `...`)
            if (c == '"' || c == '\'' || c == '`') {
                val quote = c
                var end = idx + 1
                var escaped = false
                while (end < len) {
                    val curr = line[end]
                    if (curr == '\\' && !escaped) {
                        escaped = true
                    } else if (curr == quote && !escaped) {
                        break
                    } else {
                        escaped = false
                    }
                    end++
                }
                val strContent = if (end < len) line.substring(idx, end + 1) else line.substring(idx)
                pushStyle(SpanStyle(color = ColorString))
                append(strContent)
                pop()
                idx = if (end < len) end + 1 else len
                continue
            }

            // 3. 注解 (@Annotation)
            if (c == '@' && idx + 1 < len && line[idx + 1].isLetter()) {
                var end = idx + 1
                while (end < len && (line[end].isLetterOrDigit() || line[end] == '.' || line[end] == '_')) {
                    end++
                }
                pushStyle(SpanStyle(color = ColorAnnotation, fontWeight = FontWeight.Medium))
                append(line.substring(idx, end))
                pop()
                idx = end
                continue
            }

            // 4. 数字字面量
            if (c.isDigit() && (idx == 0 || !line[idx - 1].isLetterOrDigit() && line[idx - 1] != '_')) {
                var end = idx + 1
                var hasDot = false
                while (end < len) {
                    val curr = line[end]
                    if (curr == '.' && !hasDot && end + 1 < len && line[end + 1].isDigit()) {
                        hasDot = true
                        end++
                    } else if (curr.isLetterOrDigit() || curr == '_') {
                        end++
                    } else {
                        break
                    }
                }
                pushStyle(SpanStyle(color = ColorNumber))
                append(line.substring(idx, end))
                pop()
                idx = end
                continue
            }

            // 5. 标识符 / 关键字 / 类型
            if (c.isLetter() || c == '_' || c == '$') {
                var end = idx + 1
                while (end < len && (line[end].isLetterOrDigit() || line[end] == '_' || line[end] == '$')) {
                    end++
                }
                val word = line.substring(idx, end)
                val wordLower = word.lowercase()

                when {
                    wordLower in KEYWORDS_COMMON -> {
                        val isControl = wordLower in setOf("if", "else", "when", "for", "while", "return", "throw", "try", "catch")
                        pushStyle(
                            SpanStyle(
                                color = if (isControl) ColorControl else ColorKeyword,
                                fontWeight = FontWeight.SemiBold,
                            ),
                        )
                        append(word)
                        pop()
                    }
                    word in BOOLEANS_AND_NULL -> {
                        pushStyle(SpanStyle(color = ColorBoolean, fontWeight = FontWeight.Medium))
                        append(word)
                        pop()
                    }
                    word.first().isUpperCase() && word.length > 1 -> {
                        // PascalCase 常见类型名 (e.g. String, ChatViewModel, List)
                        pushStyle(SpanStyle(color = ColorType, fontWeight = FontWeight.Normal))
                        append(word)
                        pop()
                    }
                    else -> {
                        pushStyle(SpanStyle(color = ColorDefault))
                        append(word)
                        pop()
                    }
                }
                idx = end
                continue
            }

            // 6. 普通符号或空格
            pushStyle(SpanStyle(color = ColorDefault))
            append(c.toString())
            pop()
            idx++
        }
    }
}
