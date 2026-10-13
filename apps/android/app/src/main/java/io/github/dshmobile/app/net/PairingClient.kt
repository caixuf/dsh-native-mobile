package io.github.dshmobile.app.net

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** 配对结果：令牌只在这一次返回，磁盘上只留摘要。 */
data class PairedHost(
    val label: String,
    val baseUrl: String,
    val token: String,
    val deviceId: String,
    val instanceName: String,
)

/**
 * 配对客户端：两条入口，**账号密码为主**。
 *
 * 用户反馈「配对码太麻烦」（要复制 22 位、区分大小写），因此：
 *   - `login()` —— 账号 + 密码，跟平常登录一样，是首选入口
 *   - `pair()`  —— 一次性配对码，保留作备选（也支持扫码自动填）
 *
 * 两条入口签发的设备令牌完全同构，后续鉴权无差别。
 */
object PairingClient {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    /** 解析二维码内容：`http://host:port/mobile-gateway/pair#dshm1.XXXX-XXXX-XXXX-XXXX` */
    fun parsePairingTarget(raw: String): PairingTarget? {
        val text = raw.trim()
        val hash = text.indexOf('#')
        val urlPart = if (hash >= 0) text.substring(0, hash) else text
        val code = if (hash >= 0) text.substring(hash + 1) else ""
        val base = urlPart.substringBefore("/mobile-gateway/").trimEnd('/')
        if (!base.startsWith("http://") && !base.startsWith("https://")) return null
        return PairingTarget(baseUrl = base, code = code)
    }

    /** 账号密码登录：换取长期设备令牌。 */
    fun login(baseUrl: String, username: String, password: String, deviceName: String): Result<PairedHost> = runCatching {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + DshConnection.LOGIN_PATH)
            .header("Content-Type", "application/json")
            .post(
                buildJsonObject {
                    put("username", username.trim())
                    put("password", password)
                    put("deviceName", deviceName)
                    put("platform", "android")
                }.toString().toRequestBody(JSON),
            )
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val body = Envelopes.json.parseToJsonElement(text).jsonObject
            if (!response.isSuccessful) {
                val err = body.obj("error")
                throw DshCallException(
                    err?.str("code") ?: "login_failed",
                    err?.str("message") ?: "登录失败（HTTP ${response.code}）",
                )
            }
            PairedHost(
                label = body.obj("instance")?.get("name")?.jsonPrimitive?.content ?: baseUrl,
                baseUrl = baseUrl.trimEnd('/'),
                token = body.get("token")?.jsonPrimitive?.content
                    ?: throw DshCallException("malformed", "网关未返回设备令牌"),
                deviceId = body.obj("device")?.get("id")?.jsonPrimitive?.content ?: "unknown",
                instanceName = body.obj("instance")?.get("name")?.jsonPrimitive?.content ?: "",
            )
        }
    }

    /** 探测网关是否在线（公开的健康检查）。 */
    fun probe(baseUrl: String): String? = runCatching {
        val request = Request.Builder().url(baseUrl.trimEnd('/') + DshConnection.HEALTH_PATH).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = Envelopes.json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
            if (body["ok"]?.jsonPrimitive?.content == "true") {
                body.obj("instance")?.get("name")?.jsonPrimitive?.content
            } else {
                null
            }
        }
    }.getOrNull()

    /** 用配对码换设备令牌。 */
    fun pair(baseUrl: String, code: String, deviceName: String): Result<PairedHost> = runCatching {
        val payload = buildJsonObject {
            put("code", code.trim())
            put("deviceName", deviceName)
            put("platform", "android")
        }
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + DshConnection.PAIR_PATH)
            .header("Content-Type", "application/json")
            .post(payload.toString().toRequestBody(JSON))
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val body = Envelopes.json.parseToJsonElement(text).jsonObject
            if (!response.isSuccessful) {
                val err = body.obj("error")
                throw DshCallException(
                    err?.get("code")?.jsonPrimitive?.content ?: "pair_failed",
                    err?.get("message")?.jsonPrimitive?.content ?: "配对失败（HTTP ${response.code}）",
                )
            }
            val device = body.obj("device")
            val token = body.get("token")?.jsonPrimitive?.content
                ?: throw DshCallException("malformed", "网关未返回设备令牌")
            PairedHost(
                label = body.obj("instance")?.get("name")?.jsonPrimitive?.content ?: baseUrl,
                baseUrl = baseUrl.trimEnd('/'),
                token = token,
                deviceId = device?.get("id")?.jsonPrimitive?.content ?: "unknown",
                instanceName = body.obj("instance")?.get("name")?.jsonPrimitive?.content ?: "",
            )
        }
    }

    // 注：这里曾有一个 textPrompt() helper，形状是错的（把 content 数组包进了
    // {value: …}），而且没有任何调用点 —— 已删除。发消息的正确构造在
    // ChatViewModel.send()：content 直接就是 [{type:'text', text}] 数组，
    // 且 session.prompt 还需要必填的 requestId。
}

data class PairingTarget(val baseUrl: String, val code: String)