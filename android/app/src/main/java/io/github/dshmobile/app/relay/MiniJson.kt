package io.github.dshmobile.app.relay

/**
 * 极简 JSON 读写 —— **零依赖，可在 JVM 单测里直接跑**。
 *
 * ## 为什么不用 `org.json`
 *
 * `org.json` 是 Android 平台类，在 JVM 单元测试里是一个**抛异常的桩**
 * （`isReturnDefaultValues` 只让 getter 返回默认值）。一旦协议解析依赖它，
 * 「帧怎么解析、审批怎么分类」这类**契约逻辑就只能在设备上验** ——
 * 而这正是本项目反复吃亏的模式：逻辑对错没有护栏，只能靠人在真机上试。
 *
 * 协议里只有 字符串 / 数字 / 布尔 / null / 对象 / 数组 六种形状，
 * 手写一个 100 余行的解析器既够用又**完全可测**（见 MiniJsonTest）。
 *
 * ## 已知边界（有意为之）
 *
 * - 不做流式解析：整帧本来就在内存里，且网关有 32 MiB 总上限。
 * - 重复键取**最后一个**（与 JSON.parse 一致）。
 * - 非法输入抛 [JsonError]，**绝不返回半截结果** —— 静默半解析比崩溃更难查。
 */
object MiniJson {

    class JsonError(message: String) : Exception(message)

    // ── 解析 ────────────────────────────────────────────────────────────────

    fun parse(text: String): Any? {
        val p = Parser(text)
        val value = p.parseValue()
        p.skipWs()
        if (!p.atEnd()) throw JsonError("JSON 尾部有多余内容（位置 ${p.pos}）")
        return value
    }

    /** 便捷读取：把任意值当对象用；不是对象就返回 null（不抛）。 */
    @Suppress("UNCHECKED_CAST")
    fun obj(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

    /** 便捷读取：把任意值当数组用；不是数组就返回 null（不抛）。 */
    @Suppress("UNCHECKED_CAST")
    fun arr(value: Any?): List<Any?>? = value as? List<Any?>

    /** 取字符串字段；缺失/非字符串返回 null。 */
    fun str(map: Map<String, Any?>?, key: String): String? = map?.get(key) as? String

    /** 取字符串字段，带默认值。 */
    fun strOr(map: Map<String, Any?>?, key: String, fallback: String): String =
        str(map, key)?.takeIf { it.isNotEmpty() } ?: fallback

    private class Parser(private val text: String) {
        var pos = 0
            private set

        fun atEnd(): Boolean = pos >= text.length

        fun skipWs() {
            while (pos < text.length && text[pos].isWhitespace()) pos++
        }

        fun parseValue(): Any? {
            skipWs()
            if (atEnd()) throw JsonError("JSON 意外结束")
            return when (val c = text[pos]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> parseLiteral("true", true)
                'f' -> parseLiteral("false", false)
                'n' -> parseLiteral("null", null)
                else -> if (c == '-' || c.isDigit()) parseNumber() else throw JsonError("非法字符 '$c'（位置 $pos）")
            }
        }

        private fun parseObject(): Map<String, Any?> {
            expect('{')
            val out = LinkedHashMap<String, Any?>()
            skipWs()
            if (peek() == '}') { pos++; return out }
            while (true) {
                skipWs()
                if (peek() != '"') throw JsonError("对象的键必须是字符串（位置 $pos）")
                val key = parseString()
                skipWs()
                if (peek() != ':') throw JsonError("键 '$key' 后缺少 ':'（位置 $pos）")
                pos++
                out[key] = parseValue()
                skipWs()
                when (peek()) {
                    ',' -> pos++
                    '}' -> { pos++; return out }
                    else -> throw JsonError("对象里缺 ',' 或 '}'（位置 $pos）")
                }
            }
        }

        private fun parseArray(): List<Any?> {
            expect('[')
            val out = ArrayList<Any?>()
            skipWs()
            if (peek() == ']') { pos++; return out }
            while (true) {
                out.add(parseValue())
                skipWs()
                when (peek()) {
                    ',' -> pos++
                    ']' -> { pos++; return out }
                    else -> throw JsonError("数组里缺 ',' 或 ']'（位置 $pos）")
                }
            }
        }

        private fun parseString(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                if (atEnd()) throw JsonError("字符串没有闭合引号")
                when (val c = text[pos++]) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        if (atEnd()) throw JsonError("转义符后意外结束")
                        when (val e = text[pos++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > text.length) throw JsonError("\\u 转义不完整")
                                val hex = text.substring(pos, pos + 4)
                                val code = hex.toIntOrNull(16) ?: throw JsonError("\\u 转义非法: '$hex'")
                                pos += 4
                                sb.append(code.toChar())
                            }
                            else -> throw JsonError("未知转义符 '\\$e'")
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun parseNumber(): Double {
            val start = pos
            if (peek() == '-') pos++
            while (!atEnd() && (text[pos].isDigit() || text[pos] in ".eE+-")) pos++
            val raw = text.substring(start, pos)
            return raw.toDoubleOrNull() ?: throw JsonError("非法数字 '$raw'")
        }

        private fun parseLiteral(literal: String, value: Any?): Any? {
            if (!text.startsWith(literal, pos)) throw JsonError("非法字面量（位置 $pos）")
            pos += literal.length
            return value
        }

        private fun peek(): Char = if (atEnd()) '\u0000' else text[pos]

        private fun expect(c: Char) {
            if (atEnd() || text[pos] != c) throw JsonError("期望 '$c'（位置 $pos）")
            pos++
        }
    }

    // ── 序列化 ──────────────────────────────────────────────────────────────

    fun write(value: Any?): String {
        val sb = StringBuilder()
        writeTo(sb, value)
        return sb.toString()
    }

    private fun writeTo(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is String -> writeString(sb, value)
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int -> sb.append(value.toString())
            is Long -> sb.append(value.toString())
            is Double -> sb.append(if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString())
            is Float -> sb.append(value.toString())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    writeTo(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeTo(sb, item)
                }
                sb.append(']')
            }
            else -> writeString(sb, value.toString())
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }
}