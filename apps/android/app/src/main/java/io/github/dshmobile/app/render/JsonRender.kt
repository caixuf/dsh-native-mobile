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

    /** 入参可空：真实事件里 data / message 经常缺失，不该因此抛异常。 */
    fun str(obj: JsonObject?, vararg keys: String): String? {
        if (obj == null) return null
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

    /** 入参可空，同 [str]。 */
    fun long(obj: JsonObject?, vararg keys: String): Long? {
        if (obj == null) return null
        for (k in keys) {
            val v = obj[k] as? JsonPrimitive ?: continue
            v.content.toLongOrNull()?.let { return it }
        }
        return null
    }

    /**
     * 读 JSON 布尔。
     *
     * ⚠️ 别再用 `obj[k]?.jsonPrimitive?.content == "true"` 这种写法：JSON 布尔值的
     * `content` 恰好是 `"true"`/`"false"`，能碰对，但如果服务端把字段发成字符串
     * `"true"` 或数字 `1`，那个写法就静默判错。这里统一按字面量解析。
     */
    fun bool(obj: JsonObject?, vararg keys: String): Boolean? {
        if (obj == null) return null
        for (k in keys) {
            val v = obj[k] as? JsonPrimitive ?: continue
            when (v.content.lowercase()) {
                "true", "1" -> return true
                "false", "0" -> return false
            }
        }
        return null
    }

    fun arr(obj: JsonObject, key: String): JsonArray? = obj[key] as? JsonArray

    fun obj(el: JsonElement?, key: String): JsonObject? = (el as? JsonObject)?.get(key) as? JsonObject

    /**
     * 从任意内容块里抽出可读文本。
     *
     * 形状全部经真实主机实测确认（`scripts/inspect-event-shapes.mjs`，300 条记录）：
     *
     *   assistant/message → data = { turn, step, message:{role,content,source,id}, usage, stream }
     *   user/message      → data = { content:[…], source, role, id }     ← 内容在**顶层**
     *   system/message    → data = { turn, step, message:{role,content,…} }
     *   tool/call         → data = { turn, step, callId, name, arguments }  ← arguments 是 **JSON 字符串**
     *   tool/result       → data = { turn, step, message:{role,source,toolCallId,content,isError} }
     *   step/start|end    → data = { turn, step }
     *   turn/start|end    → data = { turn } / { turn, reason:{kind,error} }
     *
     * ⚠️ 注意 `tool/call` 的 `arguments` 是**字符串**（内含 JSON），不是对象。
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
                            // 再往里找一层常见容器。
                            // 注意顺序：真实事件里 `message`（assistant/system/tool_result）
                            // 与 `content`（user）都承载正文，两者都要试。
                            val nested = el["content"] ?: el["message"] ?: el["data"]
                            nested?.let { textOf(it) } ?: compact(el, 400)
                        }
                    }
                }
            }
        }
    }

    /**
     * 把任意 content 数组渲染成文本。
     *
     * 实测真实事件的 content 元素类型：
     *   `{type:'text', text:'…'}`        —— 正文
     *   `{type:'reasoning', text:'…'}`   —— 思考过程（assistant/message 里常见）
     *   `{type:'tool-call', id, name, arguments}` —— 内嵌工具调用
     *   `{type:'image', …}`              —— 图片
     *
     * ⚠️ 实测确认内嵌工具调用的 type 是 **`tool-call`**（连字符），
     * 与顶层 `tool/call` 事件的命名空间写法不同，别只认 `tool_use`。
     *
     * 旧版只走 `str()` 抓顶层键，遇到对象数组就落到 `compact()`，
     * 于是界面出现 `[object Object]`。这里逐个元素显式处理。
     */
    fun contentToText(content: JsonElement?): String? {
        if (content == null) return null
        val parts = when (content) {
            is JsonArray -> content.mapNotNull { el ->
                val obj = el as? JsonObject
                when {
                    obj == null -> textOf(el)
                    // text / value 是正文（reasoning 也带 text）
                    str(obj, "text", "value") != null -> str(obj, "text", "value")
                    else -> when (str(obj, "type")) {
                        "image", "image_url" -> "[图片]"
                        // 内嵌工具调用：type 是 tool-call（连字符），不是 tool_use
                        "tool-call", "tool_use", "tool" -> {
                            val name = str(obj, "name", "tool") ?: "工具"
                            val args = obj["arguments"] ?: obj["input"]
                            if (args == null) "调用 $name" else "调用 $name · ${compact(args, 160)}"
                        }
                        // reasoning 等纯过程元素不单独展示（其 text 上面已取过）
                        else -> null
                    }
                }
            }
            is JsonObject -> listOfNotNull(str(content, "text", "value") ?: textOf(content))
            else -> listOfNotNull(textOf(content))
        }
        return parts.takeIf { it.isNotEmpty() }?.joinToString("\n")
    }

    /**
     * 角色推断，用于左右分栏。
     *
     * 🔴 必须从 **data** 里读，不是从 entry 顶层 —— 实测真实事件的 role 在
     * `data.role`（user/message）或 `data.message.role`（assistant/system/tool_result），
     * entry 本身只有 seq/time/data。从顶层读会永远拿到 unknown。
     *
     * 但 `tool/call` **根本没有 role 字段**（它的 data 是
     * `{turn, step, callId, name, arguments}`），只能按事件类型推断。
     */
    fun roleOf(entry: JsonObject): String {
        val data = entry["data"] as? JsonObject
        val message = data?.get("message") as? JsonObject

        // 依次试 data.role → data.message.role
        val raw = str(data, "role")
            ?: str(message, "role")
            ?: return roleFromType(typeOf(entry))

        val r = raw.lowercase()
        return when (r) {
            // 🔴 顺序与匹配方式都很重要：**先精确、再前后缀子串**，不要用 `in` 裸匹配。
            //
            // 原来写成 `"tool" in r` 之类的裸子串匹配，导致 `assistantToolResult`
            // 这种含 "tool" 的值被判成 tool；而 `"ai" in r` 更糟 ——
            // **"assistant" 里就含 "ai"，但 "detail"/"email"/"maintain" 也含**，
            // 于是大量正文被误判成 assistant/user，最后落到 `else -> raw`，
            // 角色彻底失配（正文没走 Markdown 渲染就是这个原因）。
            "user", "human", "prompt", "user-input" -> "user"
            "assistant", "model", "ai", "agent", "bot", "output" -> "assistant"
            "system", "developer" -> "system"
            "tool", "tool-call", "tool_call", "toolcall", "function" -> "tool"
            else -> when {
                r.startsWith("user") || r.startsWith("human") -> "user"
                r.startsWith("assistant") || r.startsWith("model") -> "assistant"
                r.startsWith("tool") || r.startsWith("function") -> "tool"
                r.startsWith("system") -> "system"
                // 认不出来就归 assistant：正文类内容绝大多数如此，
                // 宁可渲染成正文，也不要静默走纯文本分支。
                else -> "assistant"
            }
        }
    }

    /** 无 role 字段时按事件类型推断（实测 tool/call 就属于这种情况）。 */
    private fun roleFromType(kind: String): String = when (kind) {
        "user/message" -> "user"
        "assistant/message" -> "assistant"
        "system/message" -> "system"
        "tool/call", "tool/result" -> "tool"
        else -> "unknown"
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