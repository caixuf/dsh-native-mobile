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

    fun clientRequest(rpcId: String, method: String, payload: JsonObject): JsonObject = buildJsonObject {
        put("type", TYPE_CLIENT_REQUEST)
        put("rpcId", rpcId)
        put("method", method)
        put("payload", payload)
    }

    fun clientResponse(rpcId: String, result: JsonObject): JsonObject = buildJsonObject {
        put("type", TYPE_CLIENT_RESPONSE)
        put("rpcId", rpcId)
        put("result", result)
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