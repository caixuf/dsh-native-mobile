package io.github.dshmobile.app.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
 * 四种线上形态由 `type` 区分：
 *   `client-request`  手机 → 主机，POST /api/<method>
 *   `server-response` 主机 → 手机，对 client-request 的应答
 *   `server-request` 主机 → 手机，只走两条下行 WebSocket
 *   `client-response` 手机 → 主机，对 server-request 的应答，POST /api/respond
 *
 * 注意官方约定：下行通道**只下行**，客户端不得发送任何数据；且不带子协议、不带查询串。
 */
object Envelopes {
    const val TYPE_CLIENT_REQUEST = "client-request"
    const val TYPE_SERVER_RESPONSE = "server-response"
    const val TYPE_SERVER_REQUEST = "server-request"
    const val TYPE_CLIENT_RESPONSE = "client-response"

    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    fun toEndpoint(dotted: String): String {
        val i = dotted.indexOf('.')
        return if (i < 0) dotted else dotted.substring(0, i) + "/" + dotted.substring(i + 1)
    }

    fun clientRequest(rpcId: String, method: String, args: JsonObject): JsonObject = buildJsonObject {
        put("type", TYPE_CLIENT_REQUEST)
        put("rpcId", rpcId)
        put("method", toEndpoint(method))
        put("payload", buildJsonObject { put("args", args) })
    }

    /**
     * 应答一条主机下发的 server-request（审批 / 提问）。
     *
     * ⚠️ 官方契约里 `result` 的形状是 `{ ok: boolean, value: unknown }`，**不是**裸的业务对象。
     * 见 `docs/api-contract.md` §1.4：
     *
     *     POST /api/respond
     *     { "type":"client-response", "rpcId":"…", "result": { "ok": true, "value": {…} } }
     *
     * 早前的实现直接把 `{kind:"allow"}` 当作 result 传出去，主机会回
     * `{"accepted":false,"reason":"bad-response"}` —— 表现为「点了允许但没反应」。
     * 这里统一由本函数补信封，调用方只提供业务 value。
     */
    fun clientResponse(rpcId: String, value: JsonObject): JsonObject = buildJsonObject {
        put("type", TYPE_CLIENT_RESPONSE)
        put("rpcId", rpcId)
        put("result", buildJsonObject {
            put("ok", true)
            put("value", value)
        })
    }
}

/** 一条来自主机的 server-request（等价于一次主机发起的提问/审批/推送）。 */
data class HostRequest(
    val rpcId: String,
    val method: String,
    val payload: JsonObject,
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

/** 链路状态。`Ready` 要求两条下行流都打开且 `host.describe` 成功，与官方判定一致。 */
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