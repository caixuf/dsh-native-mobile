package io.github.dshmobile.app.render

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 容错的 JSON → 文本渲染。
 *
 * 为什么不做严格映射：DSH 的 `SessionEvent.data` 在官方 schema 里就是 `unknown()`
 * （设计如此——事件负载由各插件扩展），严格数据类会在上游加一个字段时直接编不过，
 * 或者更糟：静默丢内容。这里按启发式抽取，宁可多显示也不要静默吞掉。
 */
object JsonRender {

    private val TEXT_KEYS = listOf("text", "value", "body", "summary", "preview", "title")
    private val ROLE_KEYS = listOf("role", "author", "speaker", "kind", "type")

    fun isNull(el: JsonElement?): Boolean = el == null || el is JsonNull

    fun str(obj: JsonObject, vararg keys: String): String? {
        for (k in keys) {
            val v = obj[k]
            if (v is JsonPrimitive && v.isString) {
                val s = v.content
                if (s.isNotBlank()) return s
            } else if (v is JsonPrimitive && !v.isString && v.content != "null" && v.content.isNotBlank()) {
                return v.content
            }
        }
        return null
    }

    fun long(obj: JsonObject, vararg keys: String): Long? {
        for (k in keys) {
            val v = obj[k] as? JsonPrimitive ?: continue
            v.content.toLongOrNull()?.let { return it }
        }
        return null
    }

    fun arr(obj: JsonObject, key: String): JsonArray? = obj[key] as? JsonArray

    fun obj(el: JsonElement?, key: String): JsonObject? = (el as? JsonObject)?.get(key) as? JsonObject

    /**
     * 从任意内容块里抽出可读文本。
     * 覆盖官方已知形状：`{type:'text', text}`、`{type:'reasoning', text}`、
     * `{type:'tool', name, arguments}`，以及直接给字符串的情况。
     */
    fun textOf(el: JsonElement?): String? = when (el) {
        null, is JsonNull -> null
        is JsonPrimitive -> if (el.isString) el.content.takeIf { it.isNotBlank() } else null
        is JsonArray -> el.mapNotNull { textOf(it) }.takeIf { it.isNotEmpty() }?.joinToString("\n")
        is JsonObject -> {
            val type = str(el, "type")
            when (type) {
                "text", "output_text", "reasoning_text" -> str(el, *TEXT_KEYS.toTypedArray())
                "tool_use", "tool", "tool-call" -> {
                    val name = str(el, "name", "tool") ?: "工具"
                    val args = el["arguments"] ?: el["input"]
                    if (args == null) "调用 $name" else "调用 $name · ${compact(args, 160)}"
                }

                "image", "image_url" -> "[图片]"
                else -> {
                    val direct = str(el, *TEXT_KEYS.toTypedArray())
                    when {
                        direct != null -> direct
                        type != null && el.size <= 4 && el["type"] != null -> "[$type]"
                        else -> {
                            // 再往里找一层常见容器
                            val nested = el["content"] ?: el["message"] ?: el["data"]
                            nested?.let { textOf(it) } ?: compact(el, 400)
                        }
                    }
                }
            }
        }
    }

    /** 角色推断，用于左右分栏。 */
    fun roleOf(entry: JsonObject): String {
        str(entry, *ROLE_KEYS.toTypedArray())?.let { role ->
            val r = role.lowercase()
            return when {
                "user" in r || "human" in r || "prompt" in r -> "user"
                "assistant" in r || "model" in r || "ai" in r -> "assistant"
                "system" in r -> "system"
                else -> role
            }
        }
        return "unknown"
    }

    /** 紧凑的单行 JSON，用于未知结构的兜底展示。 */
    fun compact(el: JsonElement, limit: Int = 240): String {
        val raw = runCatching { el.toString().replace(Regex("\\s+"), " ") }.getOrDefault("<不可序列化>")
        return if (raw.length <= limit) raw else raw.take(limit) + "…"
    }

    /** 事件类型名：优先 `type`，其次 `kind`，再退化成键名提示。 */
    fun typeOf(entry: JsonObject): String =
        str(entry, "type", "kind", "event") ?: "event"
}