package io.github.dshmobile.app.relay

/**
 * mux 下行的帧解码。
 *
 * 协议（实测，见 docs/design.md）：**只有一条 WS** `/mobile-gateway/remote.mux`，
 * 帧协议是 `open / item / end / error`，事件流用内部 endpoint `$events`。
 * 服务器帧形如：
 *
 * ```json
 * { "type": "item", "streamId": "s1", "value": { "type": "waterfall", ... } }
 * { "type": "end",  "streamId": "s1" }
 * ```
 *
 * 这一层是**纯函数**：输入 JSON 文本，输出类型化结果。任何解析失败都归类为
 * [ServerFrame.Invalid] 而不是抛异常 —— 一个坏帧不该把整条审批通道打断。
 */
sealed interface ServerFrame {
    /** `item` 帧，`value` 是内层对象。 */
    data class Item(val value: Map<String, Any?>) : ServerFrame

    /** `end` 帧：流被正常关闭。 */
    data class End(val streamId: String?) : ServerFrame

    /** `error` 帧：主机侧错误。 */
    data class Failure(val message: String) : ServerFrame

    /** 解析不出来 / 形状不符。**不抛异常**，交给调用方决定是否重连。 */
    data class Invalid(val reason: String) : ServerFrame
}

/**
 * 内层事件（`ServerFrame.Item.value`）。
 *
 * 主机回 `ready`(带 clientId) / `emit` / `waterfall` / `cancel`。
 * 只有 `waterfall` 是需要用户作答的。
 */
sealed interface EventMessage {
    data class Ready(val clientId: String) : EventMessage

    data class Waterfall(
        val eventName: String,
        val eventId: String,
        val request: Map<String, Any?>,
    ) : EventMessage

    data class Emit(val eventName: String) : EventMessage

    data class Cancelled(val eventId: String) : EventMessage

    /** 认识但不关心的事件（前向兼容：未知 type 静默丢弃，不报错）。 */
    data object Ignored : EventMessage
}

object MuxCodec {

    @Suppress("UNCHECKED_CAST")
    fun decode(text: String): ServerFrame {
        val root = try {
            MiniJson.obj(MiniJson.parse(text)) ?: return ServerFrame.Invalid("顶层不是对象")
        } catch (e: MiniJson.JsonError) {
            return ServerFrame.Invalid("JSON 解析失败: ${e.message}")
        }
        val type = MiniJson.str(root, "type") ?: return ServerFrame.Invalid("帧缺少 type")
        return when (type) {
            "item" -> {
                val value = MiniJson.obj(root["value"])
                    ?: return ServerFrame.Invalid("item 帧的 value 不是对象")
                ServerFrame.Item(value)
            }
            "end" -> ServerFrame.End(MiniJson.str(root, "streamId"))
            "error" -> ServerFrame.Failure(
                MiniJson.str(MiniJson.obj(root["error"]), "message") ?: "事件流出错"
            )
            else -> ServerFrame.Invalid("未知帧类型 '$type'")
        }
    }

    /** 把 `item` 的内层对象解成事件。 */
    fun decodeEvent(value: Map<String, Any?>): EventMessage =
        when (val type = MiniJson.str(value, "type")) {
            "ready" -> {
                val clientId = MiniJson.str(value, "clientId")
                if (clientId.isNullOrBlank()) EventMessage.Ignored else EventMessage.Ready(clientId)
            }
            "waterfall" -> {
                val request = MiniJson.obj(value["request"]) ?: value
                EventMessage.Waterfall(
                    eventName = MiniJson.strOr(value, "event", "unknown"),
                    eventId = MiniJson.strOr(value, "eventId", ""),
                    request = request,
                )
            }
            "emit" -> EventMessage.Emit(MiniJson.strOr(value, "event", "unknown"))
            "cancel" -> EventMessage.Cancelled(MiniJson.strOr(value, "eventId", ""))
            // 前向兼容：主机将来加新 type，老客户端必须静默忽略而不是崩/断连。
            // 缺失 type 同样是 Ignored —— 一条不认识的事件不该打断审批通道。
            null -> EventMessage.Ignored
            else -> EventMessage.Ignored
        }
}