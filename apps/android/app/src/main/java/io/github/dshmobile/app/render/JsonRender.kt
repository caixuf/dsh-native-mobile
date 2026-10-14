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
                // 🔴 工具调用块一律跳过：它在 DSH 事件流里是**独立事件**，
                // 由 DisclosureToolCard 专门渲染。
                // 早期这里返回 `"调用 $name · ${compact(args)}"`，于是
                // `assistant/message` 的内容块 + 独立的 `tool/call` 事件
                // 让同一个调用在屏幕上**重复出现两遍**（一遍是原始 JSON 文本）。
                // 即使 contentToText 已经跳过，`?:` 兜底仍会落到本函数把它捞回来 ——
                // 所以跳过必须在这一层也做，否则修不干净。
                "tool-call", "tool_use", "tool" -> null

                "image", "image_url" -> "[图片]"

                // 🔴 reasoning（思考过程）不带 text 时**不要**打 `[reasoning]` 标签。
                //
                // 实机截图踩到：会话流里凭空出现一行 `[reasoning]`，
                // 用户完全不知道那是什么，看起来像渲染坏了。
                // 上游 DSH 的做法是把思考折叠成一行摘要胶囊
                // （"Thought 3 time(s)"），而不是把内部类型名裸露出来。
                // 这里没有 text 就返回 null —— 让上层决定是否折叠展示，
                // 绝不把内部事件类型名当内容显示。
                "reasoning", "thinking" -> str(el, *TEXT_KEYS.toTypedArray())

                else -> {
                    val direct = str(el, *TEXT_KEYS.toTypedArray())
                    when {
                        direct != null -> direct
                        // 未知类型且没有可取文本：同样是内部结构，不打裸标签。
                        // （旧实现在这里返回 "[$type]"，是 `[reasoning]` 那类噪音的来源。）
                        type != null && el.size <= 4 && el["type"] != null -> null
                        else -> {
                            // 再往里找一层常见容器。
                            // 注意顺序：真实事件里 `message`（assistant/system/tool_result）
                            // 与 `content`（user）都承载正文，两者都要试。
                            val nested = el["content"] ?: el["message"] ?: el["data"]
                            if (nested != null) textOf(nested) else fallbackText(el)
                        }
                    }
                }
            }
        }
    }

    /**
     * 兜底文本：**绝不把 message 形状的对象整体序列化成正文**。
     *
     * 🔴 真实事故（2026-10-13 实机截图）：
     * 会话流里出现了整条 `{"role":"assistant","content":[...],"name":"pwsh",
     * "arguments":"{\"command\":\"...` 的原始 JSON 正文。
     *
     * 生成链条：
     *   1. `contentToText` 正确跳过了 reasoning(空) 与 tool-call → 返回 null
     *   2. `?:` 链继续兜底到 `textOf(data)`，同样返回 null（都对）
     *   3. 最后一环 `?: compact(el, 400)` 把**整个 message 对象**序列化成 JSON 当正文
     *
     * 教训：兜底必须是「退回可读文本」，不能是「把结构 dump 出来」。
     * 只有在对象里**确实存在非结构性的可读字段**时才返回内容；
     * 否则返回 null，让上层不渲染这条 —— 少显示一句，好过给用户看一坨 JSON。
     */
    private val STRUCTURAL_KEYS = setOf(
        "role", "content", "type", "id", "callId", "name", "tool", "arguments",
        "input", "message", "data", "turn", "step", "seq", "time", "source",
        "usage", "stream", "toolCallId", "isError", "result",
    )

    private fun fallbackText(el: JsonObject): String? {
        // 只挑「非结构性」的字符串字段，且要有一定长度（避开 id 这类短值）
        val readable = el.entries
            .filter { (k, _) -> k !in STRUCTURAL_KEYS }
            .mapNotNull { (_, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content }
            .filter { it.isNotBlank() && it.length >= 8 }
            .firstOrNull()

        return readable
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
     * old: 旧版只走 `str()` 抓顶层键，遇到对象数组就落到 `compact()`，
     * 于是界面出现 `[object Object]`。这里逐个元素显式处理。
     *
     * 🔴 **内嵌 tool-call 不渲染成正文**（2026-10-13 模拟器实机复现）：
     * 工具调用在 DSH 的事件流里是**独立事件**（顶层 `tool/call`），
     * 而 `assistant/message.content` 里还会再内嵌一份同样的 `tool-call` 块。
     * 早期这里把它渲染成 `调用 bash · {"command":"..."}` 正文，
     * 结果**同一个工具调用在屏幕上出现两遍**：
     * 一遍是原始 JSON 文本，一遍是下面那张正常的工具卡。
     * 手机屏幕本来就窄，这种重复会把会话流淹掉。
     *
     * 所以这里对工具调用**一律返回 null**，交给独立的工具卡渲染。
     * 关键：只跳过工具调用，正文/图片照旧保留 —— 不能因为去重把内容也丢了。
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
                        // 内嵌工具调用：已有独立事件与独立卡片，这里必须跳过，否则重复两遍
                        "tool-call", "tool_use", "tool" -> null
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

    /**
     * 紧凑的单行文本，用于摘要展示（工具卡目标、未知结构兜底）。
     *
     * 🔴 必须**先解包字符串原语**再压缩。
     *
     * 真实事件里 `tool/call` 的 `arguments` 是一个 **JSON 字符串**
     * （内容本身还是 JSON，例如 `"{\"command\":\"git status\"}"`）。
     * 早期直接 `el.toString()`，`JsonPrimitive` 的 `toString()` 会带上
     * 最外层引号并重新转义内部引号，于是工具卡里铺出一整行
     * `"{\"command\":\"$adb=\\\"C:\\Users\\...\"` —— 用户看到的是原始转义串，
     * 完全不可读。这里对字符串原语取 `content`（已解码的真值）。
     */
    fun compact(el: JsonElement, limit: Int = 240): String {
        val decoded = when (el) {
            is JsonPrimitive -> if (el.isString) el.content else el.content
            else -> el.toString()
        }
        val raw = runCatching { decoded.replace(Regex("\\s+"), " ") }.getOrDefault("<不可序列化>")
        return if (raw.length <= limit) raw else raw.take(limit) + "…"
    }

    /** 事件类型名：优先 `type`，其次 `kind`，再退化成键名提示。 */
    fun typeOf(entry: JsonObject): String =
        str(entry, "type", "kind", "event") ?: "event"
}