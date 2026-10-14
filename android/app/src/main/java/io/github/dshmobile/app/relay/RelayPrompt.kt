package io.github.dshmobile.app.relay

/**
 * 待作答项 → 通知内容。
 *
 * **纯函数**，与 `src/App.tsx` 的 `handleHostRequest` 保持同一套判据
 * （两端的用户看到的东西必须一致，否则「手机上显示工具名、电脑上显示原因」这种
 * 割裂会让用户不敢点）：
 *
 * - `isApproval` 只看事件名里是否含 `approval`；
 * - 提问取 `questions[0]`，问题 id 用 `id`，选项取 `options[].label`。
 */
data class RelayPrompt(
    val eventId: String,
    val method: String,
    val title: String,
    /** 完整正文（未截断）。通知用 [notificationBody]。 */
    val body: String,
    val isApproval: Boolean,
    val questionId: String?,
    val options: List<String>,
    /**
     * 审批所属会话（真主机 `waterfall.request.sessionId`）。
     *
     * 通知被**点击**（不是按钮）时，壳靠它把用户直接送到出事的那个会话；
     * 取不到就是 null —— 那就只把 App 拉到前台，不能瞎跳。
     */
    val sessionId: String? = null,
) {
    /** 通知正文：Windows/macOS 都会截断长文，超长正文等于没正文。 */
    val notificationBody: String get() = PromptClassifier.truncate(body, PromptClassifier.MAX_BODY)

    /** 是否需要「允许/拒绝」两个按钮（审批），而不是选项列表（提问）。 */
    val needsAllowReject: Boolean get() = isApproval
}

object PromptClassifier {

    /** 通知正文上限。超过就截断 —— 长文本在系统通知里会被吞掉或撑爆布局。 */
    const val MAX_BODY = 180

    fun truncate(text: String, max: Int = MAX_BODY): String {
        val oneLine = text.replace('\n', ' ').replace(Regex("\\s+"), " ").trim()
        if (oneLine.length <= max) return oneLine
        return oneLine.substring(0, max - 1) + "…"
    }

    /**
     * 取本地化文案：真主机的 `displayReason` 形如 `{"en":"…","zh":"…"}`。
     * 优先中文 → 英文 → 任意非空字符串 → 纯字符串。取不到返回 null（交给调用方回落）。
     */
    fun localized(value: Any?): String? {
        if (value is String) return value.takeIf { it.isNotBlank() }
        val map = MiniJson.obj(value) ?: return null
        for (key in listOf("zh", "en")) {
            val text = MiniJson.str(map, key)
            if (!text.isNullOrBlank()) return text
        }
        return map.values.filterIsInstance<String>().firstOrNull { it.isNotBlank() }
    }

    /**
     * 审批所属的会话 id：`sessionId`，回落 `address.sessionId`
     * （与 `src/App.tsx` 的 `handleHostRequest` **同一判据** —— 两端取不到就会一端能跳、一端不能）。
     */
    fun sessionId(request: Map<String, Any?>): String? =
        MiniJson.str(request, "sessionId")?.takeIf { it.isNotBlank() }
            ?: MiniJson.str(MiniJson.obj(request["address"]), "sessionId")?.takeIf { it.isNotBlank() }

    /**
     * @return 需要用户作答的提示；**eventId 为空时返回 null** ——
     *         没有 eventId 就无法应答，弹一个点了没用的通知比不弹更糟。
     */
    @Suppress("UNCHECKED_CAST")
    fun classify(eventName: String, eventId: String, request: Map<String, Any?>): RelayPrompt? {
        if (eventId.isBlank()) return null

        val isApproval = eventName.contains("approval")
        val questions = MiniJson.arr(request["questions"])?.mapNotNull { MiniJson.obj(it) }
        val first = questions?.firstOrNull()

        val title = if (isApproval) {
            "工具调用需要批准"
        } else {
            MiniJson.str(first, "header")
                ?: MiniJson.str(first, "question")
                ?: "需要你确认"
        }

        val body = if (isApproval) {
            // 🔴 `displayReason` 是**多语言对象** `{en, zh}`（真主机实测），不是字符串。
            // 旧写法直接按字符串取 → 取不到 → 回落到只显示工具名，
            // 用户在通知栏看不到"为什么要批准"，只能盲点。
            localized(request["displayReason"])
                ?: MiniJson.str(request, "reason")
                ?: "工具调用: ${MiniJson.strOr(request, "toolName", "未知工具")}"
        } else {
            MiniJson.str(first, "question") ?: MiniJson.write(request)
        }

        val options = MiniJson.arr(first?.get("options"))
            ?.mapNotNull { MiniJson.obj(it) }
            ?.mapNotNull { MiniJson.str(it, "label") }
            ?.filter { it.isNotBlank() }
            ?: emptyList()

        return RelayPrompt(
            eventId = eventId,
            method = eventName,
            title = title.ifBlank { "需要你确认" },
            body = body.ifBlank { "来自电脑的请求" },
            isApproval = isApproval,
            questionId = MiniJson.str(first, "id"),
            options = options,
            sessionId = sessionId(request),
        )
    }
}

/**
 * 已应答事件账本。
 *
 * ## 为什么不能只放在内存里
 *
 * 桌面上「手机重复弹已处理的审批」的根因就是这个集合是内存态：进程一重启
 * （系统回收、用户滑掉、崩溃重启）它就空了，于是已应答的事件会**再弹一次**。
 * 用户在通知栏点过的审批又冒出来，会让人怀疑"到底批没批"。
 *
 * 所以账本要能 [snapshot] 落盘 / [restore] 读回；[capacity] 限制防止无限增长。
 */
class AnswerLedger(private val capacity: Int = 200) {

    private val ids = LinkedHashSet<String>()

    fun isAnswered(eventId: String): Boolean = ids.contains(eventId)

    /** @return true 表示这是**第一次**记录（调用方应据此决定是否弹通知）。 */
    fun markAnswered(eventId: String): Boolean {
        val added = ids.add(eventId)
        while (ids.size > capacity) {
            val oldest = ids.firstOrNull() ?: break
            ids.remove(oldest)
        }
        return added
    }

    /** 该事件被主机取消：把它从账本移除（用户仍可能看到它，不能算已答）。 */
    fun forget(eventId: String) {
        ids.remove(eventId)
    }

    fun snapshot(): List<String> = ids.toList()

    fun restore(saved: Collection<String>) {
        ids.clear()
        saved.forEach { ids.add(it) }
        while (ids.size > capacity) {
            val oldest = ids.firstOrNull() ?: break
            ids.remove(oldest)
        }
    }

    fun clear() = ids.clear()

    val size: Int get() = ids.size
}