package io.github.dshmobile.app.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * DSH 官方线上协议在移动端的实现。
 *
 * 这里**不发明新协议**——网关把 DSH 的 `/api` 原样桥过来，手机端与官方 Web 客户端
 * 讲同一种协议，因此上游新增能力我们不需要跟改。
 *
 * ## 🔴 三条经真实主机实测确认的硬约束（2026-10-13）
 *
 * 此前 App 三条**全错**，导致整条 `/api` 桥在真机上不可用。都是拿运行中的主机
 * 逐项探出来的（`scripts/probe-endpoint-form.mjs` / `probe-payload-shape.mjs`）：
 *
 * 1. **endpoint 用斜杠分隔，不是点号。**
 *    权威依据：`@deepseek-ai/dsh-api-gateway` 的
 *    `function endpointOf(namespace, method) { return `${namespace}/${method}`; }`
 *    实测：`session/list` → 200 被认领；`session.list` → 404 `not found`。
 *
 * 2. **payload 必须包成 `{ args: { … } }`。**
 *    裸 `{}` 被拒：`Remote payload must contain exactly one plain-object args field`。
 *
 * 3. **args 的键名是服务端 TS 声明的形参名**（可能带前导下划线），不是业务字段名。
 *    实测：`session/list` 要 `{ _request: {} }`；
 *    `session/page` 要 `{ request: { address, throughSeq } }`。
 *
 * 三条全错却一路绿到真机，是因为进程内测试的假宿主对任意形状都返回成功。
 * 已给假宿主加方法契约校验，并新增 `scripts/check-app-methods.mjs` 门禁。
 *
 * ## 🔴 2026-10-13 再次修正：事件流与应答通道（原描述全错）
 *
 * 权威来源 `@deepseek-ai/dsh-api-gateway/src/stream-protocol.ts`（从 app.asar 抠出）：
 *
 * 1. **只有一条 mux WebSocket**：`REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`。
 *    `/api/events.mux`、`/api/events.host` 在真实源码里**零出现** —— 原来那两条
 *    连上就被主机以 `invalid Remote endpoint` 断开（endpoint 校验要求 split('/')
 *    恰好 2 段，`/api/events.host` 有 3 段）。
 * 2. mux 上跑的是**帧协议**，一条 socket 承载多条逻辑流：
 *      客户端 → 主机  {type:'open', streamId, endpoint, payload}
 *                      {type:'item', streamId, value?} / {type:'end'|'cancel', streamId}
 *      主机 → 客户端  {type:'item', streamId, value?} / {type:'end'|'error', streamId}
 * 3. 事件流是其中**一条逻辑流**，endpoint 为内部常量 `$events`，
 *    payload 必须是 `{args:{}}`；主机在该流上回 `ready`/`emit`/`waterfall`/`cancel`。
 * 4. 审批/提问的应答**不走** `/api/respond`（该端点不存在，asar 零命中、实测 404），
 *    而是普通 RPC endpoint **`$events/result`**，args = `{clientId, eventId, outcome}`。
 *
 * 因此线上只剩**两种**信封形态：
 *   `client-request`   手机 → 主机（含 `$events/result` 应答）
 *   `server-response`  主机 → 手机，对 client-request 的应答
 *
 * 注意：mux 是**双向**的（要靠它发 open/item/end/cancel），与旧文档「下行通道只下行」
 * 的说法相反 —— 旧说法对应的是那两条并不存在的 `events.*`。
 */
object Envelopes {
    /**
     * 手机 → 主机的唯一信封形态。
     *
     * ⚠️ 曾经的 `server-request` / `client-response` 两个常量已删除：它们对应的是
     * 那两条**并不存在**的 `events.*` 下行流与 `/api/respond` 应答端点。
     * 留着只会诱导后来者按已证伪的协议写代码（本文件顶部记录了取证过程）。
     */
    const val TYPE_CLIENT_REQUEST = "client-request"

    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    fun toEndpoint(dotted: String): String {
        val i = dotted.indexOf('.')
        return if (i < 0) dotted else dotted.substring(0, i) + "/" + dotted.substring(i + 1)
    }

    /**
     * 构造一条 `client-request`（手机 → 主机的一问一答）。
     *
     * 审批/提问的应答**也走这条通道**（endpoint `$events/result`），
     * 不是独立的 `/api/respond` —— 后者在真实主机上不存在。
     */
    fun clientRequest(rpcId: String, method: String, args: JsonObject): JsonObject = buildJsonObject {
        put("type", TYPE_CLIENT_REQUEST)
        put("rpcId", rpcId)
        put("method", toEndpoint(method))
        put("payload", buildJsonObject { put("args", args) })
    }

    /**
     * 审批/提问的 `outcome` 构造器。
     *
     * 🔴 真实形状（`parseRemoteEventResult` 逐字，2026-10-13 从 app.asar 取证）：
     *
     *     { kind:'next' }                                   —— 交给下一个监听者
     *     { kind:'result', value?: unknown }                —— 采纳，带返回值
     *     { kind:'rejected', error:{name,message,code?,details?} } —— 拒绝
     *
     * 早前这里是 `{kind:'allow'|'deny'|'answer'}` 那种自造形状，且外面还套了
     * `{ok,value}` 信封 —— **两层都错**。实测打 `/api/respond` 返回 404，
     * 因为那个端点根本不存在。
     */
    /**
     * 审批（`approval/request`）的 `outcome`。
     *
     * 🔴 2026-10-13 从 app.asar 逐字取证：`value` 必须是 **ApprovalOutcome 字符串**，
     * 不是对象。权威链路：
     *
     *   stream-protocol.ts : outcome = { kind:'result', value?: unknown }
     *   dsh-api-gateway    : settleRemoteEvent(pending, {kind:'result', value: outcome.value})
     *   api-remotes        : forwardWaterfall → settled.resolve(outcome.value)
     *   dsh-user-approval  : ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'
     *   dsh-user-approval  : outcome => OUTCOMES.includes(outcome) ? outcome : 'unavailable'
     *   dsh-tools          : switch (outcome) { case 'allowed-once': allow; case 'rejected': deny;
     *                        default: assertNever(outcome) }
     *
     * 也就是说 `value` 要**裸字符串** `'allowed-once'`。早前发的是
     * `{approved:true}` 对象 —— 它不在 OUTCOMES 词表里，会被**归一化成
     * `'unavailable'`**，表现为「点了允许，工具却以『没有审批通道』被拒绝」。
     *
     * ⚠️ 宿主词表里**没有**「记住本次选择」这一项（只有那四个字符串），
     * 所以 UI 的 remember 选项不能上线，否则同样会被判为非法值。
     */
    fun approvalOutcome(allow: Boolean): JsonObject = buildJsonObject {
        put("kind", "result")
        put("value", if (allow) "allowed-once" else "rejected")
    }

    /**
     * 提问（`user-questions/request`）的 `outcome`。
     *
     * 🔴 权威形状（`AskUserQuestionAnswer` 声明，逐字）：
     *
     *     { answers: [ { id: string, selected: string[], custom?: string } ] }
     *
     * `id` 是**问题**的 id（`AskUserQuestionItem.id`），不是选项 id；
     * `selected` 是所选选项的 **label 数组**（多选时为多个）。
     * 早前发的是 `{answer:"文本"}` —— 形状完全不对，主机会当成非法应答。
     */
    fun questionOutcome(questionId: String, selected: List<String>): JsonObject = buildJsonObject {
        put("kind", "result")
        put("value", buildJsonObject {
            put("answers", buildJsonArray {
                add(buildJsonObject {
                    put("id", questionId)
                    put("selected", buildJsonArray { selected.forEach { add(JsonPrimitive(it)) } })
                })
            })
        })
    }

    /**
     * 拒绝 / 取消一条 waterfall。
     *
     * 形状（`parseRemoteEventRejection` 逐字）：`{name, message, code?, details?}`，
     * 其中 `name` 必须**非空**。主机侧 `restoreRemoteEventRejection` 会把它还原成
     * 一个 Error 抛回 waterfall —— 审批由此变成「用户拒绝」。
     */
    fun rejected(message: String, code: String? = null): JsonObject = buildJsonObject {
        put("kind", "rejected")
        put("error", buildJsonObject {
            put("name", "Error")
            put("message", message)
            if (code != null) put("code", code)
        })
    }
}

/**
 * 一条来自主机事件流、需要（或可能不需要）用户回应的项。
 *
 * @param rpcId 承载主机的 **eventId**（仅 `waterfall` 有）；应答时原样送回
 *              `$events/result`，主机靠它定位 pending。
 * @param method 事件名（`approval/request`、`user-questions/request`、`tick` …）。
 * @param payload 业务负载：`waterfall` 用帧里的 `request`，`emit` 用整帧。
 * @param answerable 是否**需要应答**。
 *
 * 🔴 这个标志是必需的：真实主机把两类事件都送到同一条 `$events` 流上 ——
 * `emit` 是纯通知（如 `schedule/changed`、`api-session/activity`），**应答它毫无意义**；
 * 只有 `waterfall`（`approval/request`、`user-questions/request`）才在等我们的结果。
 * 早前靠事件名里是否含 "approval"/"question" 来猜，既会漏（`user-questions/request`
 * 恰好能蒙中，但别的可应答事件就漏了），也可能把纯通知误判成审批弹窗。
 */
data class HostRequest(
    val rpcId: String,
    val method: String,
    val payload: JsonObject,
    val answerable: Boolean = false,
)

/** 解码后的 server-response。 */
sealed interface CallOutcome {
    data class Ok(val value: JsonElement) : CallOutcome
    data class Failed(val code: String, val message: String, val details: JsonElement?) : CallOutcome
}

/** 一问一答失败（含传输层），统一成可展示的错误。 */
class DshCallException(
    val code: String,
    override val message: String,
) : Exception(message)

/** 链路状态。`Ready` 要求 mux 已打开且 `session.list` 成功，与官方判定一致。 */
sealed interface LinkState {
    data object Disconnected : LinkState
    data class Connecting(val attempt: Int) : LinkState
    data class Ready(val hostName: String) : LinkState
    data class Degraded(val reason: String, val attempt: Int) : LinkState
}

// ---- 小工具 ---------------------------------------------------------------

internal fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.toString().equals("null", true) }?.content

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()

internal fun JsonElement.parse(): JsonObject = this as? JsonObject ?: JsonObject(emptyMap())

internal fun JsonObject.toMap(): Map<String, JsonElement> = this