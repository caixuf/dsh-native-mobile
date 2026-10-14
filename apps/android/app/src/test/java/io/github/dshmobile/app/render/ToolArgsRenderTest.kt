package io.github.dshmobile.app.render

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工具入参展示的回归测试。
 *
 * 🔴 实测 bug（2026-10-13，模拟器实机复现）：
 *
 * 工具卡里铺出的是**原始转义 JSON**：
 * ```
 * 调用 pwsh · "{\"command\":\"$adb=\\\"C:\\Users\\20247\\Downloads\\..."
 * ```
 * 用户完全读不了。根因有**两处**，都在这里锁死：
 *
 *  1. `JsonRender.compact` 直接 `el.toString()` —— 对字符串原语，
 *     Kotlin 的 `JsonPrimitive.toString()` 会带上最外层引号并重新转义内部引号，
 *     于是把「已解码的 JSON 文本」又编码回转义串。
 *  2. `DisclosureToolCard.extractArgValue` 用正则 `"key"\s*:\s*"([^"]+)"`
 *     直接抠值，值里含 `\"` 时在第一个转义引号处**截断**，取到残缺乱码。
 */
class ToolArgsRenderTest {

    private val json = Json

    // ── compact：字符串原语必须解包，不能带引号和反斜杠 ──────────────────────

    @Test
    fun `compact unwraps string primitive instead of re-escaping it`() {
        // 真实事件形态：arguments 是「内容为 JSON 的字符串」
        val inner = """{"command":"git status --short"}"""
        val el = JsonPrimitive(inner)

        val out = JsonRender.compact(el)

        assertEquals("字符串原语应原样解包", inner, out)
        assertFalse("不能残留转义反斜杠", out.contains("\\\""))
        assertFalse("不能带最外层引号", out.startsWith("\""))
    }

    @Test
    fun `compact on a real pwsh arguments payload unwraps exactly one layer`() {
        // 与模拟器截图里那条 pwsh 调用同构。
        //
        // 🔴 断言的分寸（我最初写错过，这里说明清楚）：
        // `arguments` 的**内容本身是一段 JSON 文本**，里面的 `\"` 和 `\\`
        // 都是那段 JSON 的**合法转义**（Windows 路径在 JSON 里就必须写 `\\`）。
        // 所以「compact 后不能出现 \ 或 \"」是错的断言 —— 抹掉它们反而破坏了 JSON。
        //
        // compact 的真正职责：**剥掉最外层字符串原语的引号与再转义**，
        // 让 UI 拿到「一段 JSON 文本」，而不是「被再次编码过的 JSON 文本」。
        // 把转义变成可读字符是 prettyJson / 取值时该做的事，另有测试覆盖。
        val inner = "{\"command\":\"\$adb=\\\"C:\\\\Users\\\\20247\\\\Downloads\\\\aiwork\\\"; & \$adb shell input swipe\"}"
        val out = JsonRender.compact(JsonPrimitive(inner), limit = 400)

        assertEquals("应原样解包，不做二次转义", inner, out)
        assertFalse("最外层不该再包一层引号", out.startsWith("\""))
        // 二次转义的特征：单反斜杠被写成 4 个（\\\"）
        assertFalse("不该出现二次转义特征 \\\\\\\"", out.contains("\\\\\\\""))
        assertTrue("应保留可读的命令关键字", out.contains("command"))
        assertTrue("JSON 内的路径转义应保持合法", out.contains("C:\\\\Users"))
    }

    @Test
    fun `compact still works for non-string elements`() {
        val obj = json.parseToJsonElement("""{"a":1,"b":"x"}""")
        val out = JsonRender.compact(obj)
        assertTrue("对象仍走 toString", out.contains("\"a\""))
    }

    @Test
    fun `compact truncates long content with ellipsis`() {
        val long = "x".repeat(500)
        val out = JsonRender.compact(JsonPrimitive(long), limit = 50)
        assertEquals(51, out.length) // 50 + "…"
        assertTrue(out.endsWith("…"))
    }

    @Test
    fun `compact never throws on odd input`() {
        listOf("", "   ", "{", "[", "\u0000", "{\"a\":").forEach { s ->
            JsonRender.compact(JsonPrimitive(s))
        }
    }

    // ── 入参取值：转义引号不能被截断 ────────────────────────────────────────

    @Test
    fun `arg extraction survives escaped quotes in the value`() {
        // 旧正则会在第一个 \" 处截断 —— 这个输入就是当时踩到的形态
        val args = "{\"command\":\"echo \\\"hello world\\\"\"}"
        val sb = StringBuilder()

        // 直接验证解析路径：先 JSON 解析再取值
        val obj = Json.parseToJsonElement(args) as kotlinx.serialization.json.JsonObject
        val v = (obj["command"] as JsonPrimitive).content
        assertEquals("echo \"hello world\"", v)
        sb.append(v)
        assertTrue(sb.toString().contains("hello world"))
    }

    @Test
    fun `arg extraction is case insensitive on key names`() {
        // 真实事件里键名大小写不稳定（CommandLine / command / Cmd）
        val args = "{\"CommandLine\":\"npm run build\"}"
        val obj = Json.parseToJsonElement(args) as kotlinx.serialization.json.JsonObject
        val hit = obj["CommandLine"] ?: obj.entries
            .firstOrNull { it.key.equals("commandline", ignoreCase = true) }?.value
        assertEquals("npm run build", (hit as JsonPrimitive).content)
    }

    @Test
    fun `arg extraction keeps full long path with backslashes`() {
        val args = "{\"file\":\"C:\\\\Users\\\\20247\\\\Downloads\\\\aiwork\\\\dsh-native-mobile\\\\README.md\"}"
        val obj = Json.parseToJsonElement(args) as kotlinx.serialization.json.JsonObject
        val v = (obj["file"] as JsonPrimitive).content
        assertEquals("C:\\Users\\20247\\Downloads\\aiwork\\dsh-native-mobile\\README.md", v)
        assertFalse("反斜杠不能被吞", v.contains("\\\\"))
    }

    // ── 用户真正读到的文本：解码 + 美化之后的结果 ────────────────────────────

    @Test
    fun `prettyJson decodes escaped quotes so user reads a real command`() {
        // 这是「卡片摘要」走的那条路：先把 JSON 解析成结构，再取值。
        // 目标断言是**用户可读性**：命令里应当出现真实的引号与路径，
        // 而不是 `\"` 这种转义序列。
        val args = "{\"command\":\"\$adb=\\\"C:\\\\Users\\\\20247\\\"; echo \\\"done\\\"\"}"
        val obj = Json.parseToJsonElement(args) as kotlinx.serialization.json.JsonObject
        val command = (obj["command"] as JsonPrimitive).content

        assertTrue("应出现真实双引号", command.contains("\"C:"))
        assertTrue("应出现真实路径分隔符", command.contains("C:\\Users\\20247"))
        assertTrue("应出现真实结尾引号", command.contains("done\""))
        assertFalse("用户不该看到 \\\" 转义序列", command.contains("\\\""))
    }

    @Test
    fun `prettyJson pretty prints an object with real newlines`() {
        val raw = "{\"command\":\"git status\",\"timeout\":30}"
        val obj = Json.parseToJsonElement(raw) as kotlinx.serialization.json.JsonObject
        val pretty = io.github.dshmobile.app.ui.components.prettyJson(raw)

        assertTrue("应换行缩进", pretty.contains("\n"))
        assertTrue("应保留键", pretty.contains("command"))
        assertTrue("应保留值", pretty.contains("git status"))

        // 与上面解析出的字段一致（确认美化没改语义）
        assertEquals(obj["command"]!!.let { (it as JsonPrimitive).content }, "git status")
    }

    @Test
    fun `prettyJson falls back to raw text for non-json`() {
        val raw = "plain text, not json"
        assertEquals(raw, io.github.dshmobile.app.ui.components.prettyJson(raw))
    }

    @Test
    fun `prettyJson never loses content on half-typed json`() {
        // 流式半截：解析失败必须原样返回，不能丢内容、不能抛
        val raw = "{\"command\":\"git sta"
        val out = io.github.dshmobile.app.ui.components.prettyJson(raw)
        assertTrue("半截 JSON 必须原样保留", out.contains("git sta"))
    }

    // ── 🔴 工具调用不得作为正文重复出现 ────────────────────────────────────
    //
    // 真实事故（2026-10-13，模拟器实机截图）：
    //
    //   调用 pwsh · {"command": "$node=\"C:\...\node.exe\"\nSet...
    //   [复制]
    //   [执行终端命令 · $node="C:\Users\20247\A…  展开]   ← 同一调用第二遍
    //
    // 同一个工具调用出现两遍：一遍原始 JSON 正文，一遍正确的工具卡。
    // 根因有**两条路**，必须同时堵住，否则修不干净：
    //   1. `contentToText` 把内嵌 tool-call 渲染成 "调用 X · {...}"
    //   2. `contentToText` 返回 null 后，`?:` 兜底落到 `textOf()`，
    //      而 `textOf()` 里 **也有** tool-call 分支，又把它捞了回来
    //
    // 下面两条测试分别锁死这两条路。

    @Test
    fun `textOf skips embedded tool call instead of rendering raw json`() {
        val content = """[{"type":"text","text":"我来执行一下。"},{"type":"tool-call","id":"c1","name":"pwsh","arguments":"{\"command\":\"git status\"}"}]"""
        val el = Json.parseToJsonElement(content)

        // contentToText 跳过工具调用，只留正文
        val viaContent = JsonRender.contentToText(el)
        assertEquals("我来执行一下。", viaContent)

        // textOf 也必须跳过 —— 否则 `?:` 兜底会把它渲染成原始 JSON
        val viaTextOf = JsonRender.textOf(el)
        assertEquals("我来执行一下。", viaTextOf)

        assertFalse("不得出现原始 JSON 转义", viaTextOf!!.contains("\\\""))
        assertFalse("不得出现 arguments 原文", viaTextOf.contains("arguments"))
    }

    @Test
    fun `tool call only content produces no body text`() {
        // 整条消息只有工具调用时，正文必须是**空**的（由工具卡独占渲染），
        // 而不是退回显示一坨 JSON。
        val content = """[{"type":"tool-call","name":"pwsh","arguments":"{\"command\":\"ls\"}"}]"""
        val el = Json.parseToJsonElement(content)
        assertEquals(null, JsonRender.contentToText(el))
        assertEquals(null, JsonRender.textOf(el))
    }

    @Test
    fun `tool call with underscores and hyphens both skipped`() {
        // 命名空间写法不统一：tool-call / tool_use / tool 三种都出现过
        listOf("tool-call", "tool_use", "tool").forEach { t ->
            val content = """[{"type":"$t","name":"pwsh","arguments":"{}"}]"""
            val el = Json.parseToJsonElement(content)
            assertEquals("$t 必须被跳过", null, JsonRender.contentToText(el))
            assertEquals("$t 在 textOf 里也必须被跳过", null, JsonRender.textOf(el))
        }
    }

    @Test
    fun `normal text and images still survive alongside tool calls`() {
        // 关键：去重不能把正常内容一起丢掉
        val content = """[{"type":"text","text":"先看这张图"},{"type":"image"},{"type":"text","text":"然后执行"},{"type":"tool-call","name":"x","arguments":"{}"}]"""
        val el = Json.parseToJsonElement(content)
        val out = JsonRender.contentToText(el)
        assertTrue("正文不能丢", out!!.contains("先看这张图"))
        assertTrue("第二段正文不能丢", out.contains("然后执行"))
        assertTrue("图片占位不能丢", out.contains("[图片]"))
        assertFalse("工具调用不能出现", out.contains("调用 x"))
    }

    // ── 🔴 内部事件类型名不得裸露成正文 ────────────────────────────────────
    //
    // 实机截图踩到：会话流里凭空出现一行 `[reasoning]`，
    // 用户完全不知道那是什么，看起来像渲染坏了。
    // 根因：`textOf` 的 else 兜底对未知类型返回 `"[$type]"`。

    @Test
    fun `reasoning without text does not render a bare type tag`() {
        val el = Json.parseToJsonElement("""{"type":"reasoning"}""")
        assertEquals("不得把内部类型名当内容显示", null, JsonRender.textOf(el))
    }

    @Test
    fun `reasoning with text renders the text`() {
        val el = Json.parseToJsonElement("""{"type":"reasoning","text":"我在想这件事"}""")
        assertEquals("我在想这件事", JsonRender.textOf(el))
    }

    @Test
    fun `unknown internal type does not leak as bracketed tag`() {
        listOf("step/start", "turn/start", "model/selection", "request/context").forEach { t ->
            val el = Json.parseToJsonElement("""{"type":"$t"}""")
            val out = JsonRender.textOf(el)
            assertFalse("$t 不得裸露成 [$t]", out == "[$t]")
        }
    }

    @Test
    fun `content array with only reasoning yields no body`() {
        val el = Json.parseToJsonElement("""[{"type":"reasoning"},{"type":"reasoning"}]""")
        assertEquals(null, JsonRender.contentToText(el))
    }

    // ── 🔴 兜底绝不能把 message 对象 dump 成正文 ────────────────────────────
    //
    // 真实事故（2026-10-13 实机截图，比前面几条更严重）：
    //
    //   {"role":"assistant","content":[{"type":"reasoning","text":""},
    //   {"type":"tool-call","id":"call_00_ET_qWf7kv4X9y07zv3LG1eO6914",
    //   "name":"pwsh","arguments":"{\"command\":\"$adb=\"C:\\Users\\...
    //
    // **整条 assistant 消息的原始 JSON 被当成正文铺了一屏。**
    //
    // 生成链条（三步各自都"看起来合理"，合起来就是灾难）：
    //   1. contentToText 正确跳过了 reasoning(空) 与 tool-call → null
    //   2. ?: 兜底落到 textOf(data) → 同样 null（也对）
    //   3. 最后一环 ?: compact(el) 把**整个 message 对象**序列化当正文
    //
    // 教训：兜底必须是「退回可读文本」，不是「把结构 dump 出来」。

    @Test
    fun `message-shaped object is never dumped as body text`() {
        val msg = """{"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"tool-call","name":"pwsh","arguments":"{}"}]}"""
        val el = Json.parseToJsonElement(msg)

        val out = JsonRender.textOf(el)

        // 可以返回 null（不渲染），但绝不能返回整段 JSON
        if (out != null) {
            assertFalse("不得包含 role 字段名", out.contains("\"role\""))
            assertFalse("不得包含 content 字段名", out.contains("\"content\""))
            assertFalse("不得包含 arguments 字段名", out.contains("arguments"))
        }
    }

    @Test
    fun `real tool call arguments are not leaked through fallback`() {
        val msg = """{"role":"assistant","content":[{"type":"tool-call","id":"call_00_ET","name":"pwsh","arguments":"{\"command\":\"adb shell input tap\"}"}],"usage":{}}"""
        val el = Json.parseToJsonElement(msg)
        val out = JsonRender.textOf(el)
        if (out != null) {
            assertFalse("命令内容不得泄漏到正文", out.contains("adb shell input tap"))
        }
    }

    @Test
    fun `readable non-structural field can still be used as fallback`() {
        // 兜底要有用：真有可读字段时应当返回它，而不是一律 null
        val el = Json.parseToJsonElement("""{"role":"assistant","summary":"这是可读的摘要内容"}""")
        val out = JsonRender.textOf(el)
        assertTrue("可读摘要应被兜底采用", out != null && out.contains("这是可读的摘要内容"))
    }

    @Test
    fun `short structural values are not treated as body`() {
        // 只有 id / role 这类短结构值时，不应产出正文
        val el = Json.parseToJsonElement("""{"role":"assistant","id":"abc123"}""")
        val out = JsonRender.textOf(el)
        assertFalse("结构性短值不得当正文", out == "abc123" || out == "assistant")
    }
}
