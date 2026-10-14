package io.github.dshmobile.app.relay

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID
import java.util.concurrent.TimeUnit

/** 一次应答投递的结果。失败必须能被如实报出来，不能吞掉。 */
data class RelayDelivery(val ok: Boolean, val status: Int, val message: String?)

/**
 * 与网关通信的**唯一出口**（事件流用 WS，应答用 HTTP）。
 *
 * 🔴 原生端和网页端有一处关键差异：**原生可以设请求头**，所以这里用
 * `Authorization: Bearer`，把令牌放在头里 —— 而不是像 WebView 那样塞进 `?token=`
 * 查询参数（那会让 30 天完全控制凭据落进 Caddy/FRP 访问日志）。
 */
object RelayClient {

    private val JSON = "application/json; charset=utf-8".toMediaType()

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            // 半开连接检测：TCP 已死但没收到 FIN 时，只有 ping 能发现（否则会假装连着）
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    /** 应答端点 URL。注意 endpoint 本身含斜杠（`$events/result`）。 */
    fun apiUrl(baseUrl: String, endpoint: String): String =
        baseUrl.trimEnd('/') + "/mobile-gateway/api/" + endpoint

    fun wsUrl(baseUrl: String): String = baseUrl.trimEnd('/')
        .replaceFirst("http://", "ws://")
        .replaceFirst("https://", "wss://") + ApprovalContract.MUX_PATH

    private fun newRpcId(): String = "r" + UUID.randomUUID().toString().replace("-", "").take(8)

    /** 投递审批/提问应答。**同步**调用，请放在后台线程。 */
    fun sendOutcome(
        baseUrl: String,
        token: String,
        clientId: String,
        eventId: String,
        outcome: Map<String, Any?>,
    ): RelayDelivery {
        val body = ApprovalContract.resultEnvelope(newRpcId(), clientId, eventId, outcome)
        val request = Request.Builder()
            .url(apiUrl(baseUrl, ApprovalContract.EVENT_RESULT_ENDPOINT))
            .addHeader("Authorization", "Bearer $token")
            .post(body.toRequestBody(JSON))
            .build()

        return try {
            http.newCall(request).execute().use { response ->
                val text = runCatching { response.body?.string() }.getOrNull().orEmpty()
                if (!response.isSuccessful) {
                    // 401/403 是可操作的信号：让上层区分「要重新配对」与「网络抖动」。
                    return RelayDelivery(false, response.code, httpMessage(response.code))
                }
                // 网关可能回 200 但 result.ok=false（主机侧拒绝）—— 那**不算送达**。
                val parsed = runCatching { MiniJson.obj(MiniJson.parse(text)) }.getOrNull()
                val result = MiniJson.obj(parsed?.get("result"))
                val ok = MiniJson.str(result, "ok") != "false" &&
                    (result?.get("ok") as? Boolean) != false
                if (!ok) {
                    val err = MiniJson.obj(result?.get("error"))
                    RelayDelivery(false, response.code, MiniJson.str(err, "message") ?: "主机拒绝了应答")
                } else {
                    RelayDelivery(true, response.code, null)
                }
            }
        } catch (e: Exception) {
            RelayDelivery(false, 0, e.message ?: "网络不可达")
        }
    }

    fun httpMessage(code: Int): String = when (code) {
        401 -> "设备令牌缺失或已过期（401）"
        403 -> "设备令牌已失效（403）"
        else -> "网关返回 HTTP $code"
    }
}