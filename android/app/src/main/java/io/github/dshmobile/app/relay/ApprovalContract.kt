package io.github.dshmobile.app.relay

/**
 * 审批 / 提问应答的**协议契约** —— 单一事实来源。
 *
 * ## 这个文件为什么必须存在
 *
 * 主机的审批词表只有**四个裸字符串**：
 *
 *     allowed-once | rejected | cancelled | unavailable
 *
 * **词表外的值不报错、不崩、日志干净 —— 而是被静默归一化成 `unavailable`**，
 * 而 `unavailable` 的语义是「没有审批通道」，落到工具层就是**拒绝**。
 * 现象是「用户在通知栏点了允许，工具却被拒绝」，排查成本极高。
 *
 * 这条约束在本项目里被删过一次（Kotlin 的 `ApprovalContractTest`，11 条），
 * 又在 Web 栈里复现过一次（App.tsx 手写字面量）。所以这里的做法不是"写对一次"，
 * 而是**让写错不可能**：
 *
 *   1. 词表只有一处定义（[VOCABULARY]）；
 *   2. [approvalOutcome] 只能从词表取值，并在运行时**再校验一次**（写错立刻抛，
 *      而不是被主机静默归一化）；
 *   3. 全仓只有本文件允许出现这些字面量 —— 由 `test-approval-contract.mjs`
 *      与 `ApprovalContractTest.kt` 双向钉死。
 *
 * 对应真机事实（2026-10-14 实测）：应答走 RPC endpoint `$events/result`，
 * args = `{clientId, eventId, outcome}`，`outcome = {kind:"result", value:<裸字符串>}`。
 */
object ApprovalContract {

    /** 应答端点。**不是** `/api/respond`（真实主机上不存在该端点）。 */
    const val EVENT_RESULT_ENDPOINT = "\$events/result"

    /** 事件流内部 endpoint。 */
    const val EVENT_STREAM_ENDPOINT = "\$events"

    /** mux 下行路径（真实主机只有这一条 WS）。 */
    const val MUX_PATH = "/mobile-gateway/remote.mux"

    const val ALLOWED_ONCE = "allowed-once"
    const val REJECTED = "rejected"
    const val CANCELLED = "cancelled"
    const val UNAVAILABLE = "unavailable"

    /** 主机词表（逐字）。 */
    val VOCABULARY: Set<String> = linkedSetOf(ALLOWED_ONCE, REJECTED, CANCELLED, UNAVAILABLE)

    /** 审批的两个出口值。**只在这里取值。** */
    fun approvalValue(allow: Boolean): String = if (allow) ALLOWED_ONCE else REJECTED

    /**
     * 词表校验。词表外的值必须**在这里炸掉**，不能发出去被主机静默归一化。
     */
    fun requireInVocabulary(value: String): String {
        require(value in VOCABULARY) {
            "审批应答值 '$value' 不在主机词表 $VOCABULARY 内 —— " +
                "发出去不会报错，而是被静默归一化成 $UNAVAILABLE（= 拒绝）"
        }
        return value
    }

    /** 审批 outcome：`{kind:"result", value:<裸字符串>}`。 */
    fun approvalOutcome(allow: Boolean): Map<String, Any?> =
        mapOf("kind" to "result", "value" to requireInVocabulary(approvalValue(allow)))

    /**
     * 提问 outcome：`{kind:"result", value:{answers:[{id,selected}]}}`。
     * `id` 必须是**问题** id（不是选项 id），`selected` 是选项 label 列表。
     */
    fun questionOutcome(questionId: String, selected: List<String>): Map<String, Any?> =
        mapOf(
            "kind" to "result",
            "value" to mapOf(
                "answers" to listOf(
                    mapOf("id" to questionId, "selected" to selected)
                )
            )
        )

    /** waterfall 被客户端主动拒绝时的形状：`{kind:"rejected", error:{name,message}}`。 */
    fun rejected(message: String): Map<String, Any?> =
        mapOf("kind" to "rejected", "error" to mapOf("name" to "Error", "message" to message))

    /**
     * 客户端请求信封。
     *
     * 🔴 `payload` 必须包成 `{args:{...}}`，`method` 用**斜杠**形式 —— 两条都是实测结论。
     */
    fun clientRequest(rpcId: String, method: String, args: Map<String, Any?>): Map<String, Any?> =
        mapOf(
            "type" to "client-request",
            "rpcId" to rpcId,
            "method" to method,
            "payload" to mapOf("args" to args)
        )

    /** `$events/result` 的完整请求体（JSON 文本）。 */
    fun resultEnvelope(
        rpcId: String,
        clientId: String,
        eventId: String,
        outcome: Map<String, Any?>,
    ): String = MiniJson.write(
        clientRequest(
            rpcId,
            EVENT_RESULT_ENDPOINT,
            mapOf("clientId" to clientId, "eventId" to eventId, "outcome" to outcome)
        )
    )

    /**
     * 打开事件流的帧。
     *
     * 🔴 网关对 open 帧的要求是**精确 4 键**（`type/streamId/endpoint/payload`），
     * 键多一个少一个都会以 1008 关闭 socket；`endpoint` 必须非空。
     */
    fun openEventStream(streamId: String): String = MiniJson.write(
        mapOf(
            "type" to "open",
            "streamId" to streamId,
            "endpoint" to EVENT_STREAM_ENDPOINT,
            "payload" to mapOf("args" to emptyMap<String, Any?>())
        )
    )
}