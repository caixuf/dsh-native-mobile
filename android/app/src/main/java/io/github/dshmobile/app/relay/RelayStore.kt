package io.github.dshmobile.app.relay

import android.content.Context

/**
 * 中继的持久化状态。
 *
 * 关键点：**已应答账本必须落盘**。它曾经只存在内存里，进程被系统回收后重启，
 * 用户已经点过的审批会**再弹一次** —— 用户会怀疑「到底批没批」。
 */
class RelayStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val answered = AnswerLedger().also { it.restore(loadAnswered()) }

    var baseUrl: String?
        get() = prefs.getString(KEY_BASE_URL, null)
        private set(value) = prefs.edit().putString(KEY_BASE_URL, value).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        private set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var label: String
        get() = prefs.getString(KEY_LABEL, "") ?: ""
        private set(value) = prefs.edit().putString(KEY_LABEL, value).apply()

    /** 事件流 `ready` 帧带回的 clientId —— 应答必须带上它，否则主机无法归属。 */
    var clientId: String?
        get() = prefs.getString(KEY_CLIENT_ID, null)
        private set(value) = prefs.edit().putString(KEY_CLIENT_ID, value).apply()

    /** 最近一次断开原因，供网页端如实展示（不要假装"已连接"）。 */
    var lastError: String?
        get() = prefs.getString(KEY_LAST_ERROR, null)
        private set(value) = prefs.edit().putString(KEY_LAST_ERROR, value).apply()

    fun isConfigured(): Boolean = !baseUrl.isNullOrBlank() && !token.isNullOrBlank()

    fun saveConnection(baseUrl: String, token: String, label: String) {
        prefs.edit()
            .putString(KEY_BASE_URL, baseUrl)
            .putString(KEY_TOKEN, token)
            .putString(KEY_LABEL, label)
            .putString(KEY_LAST_ERROR, null)
            .apply()
    }

    fun clearConnection() {
        prefs.edit()
            .remove(KEY_BASE_URL)
            .remove(KEY_TOKEN)
            .remove(KEY_CLIENT_ID)
            .putString(KEY_LAST_ERROR, null)
            .apply()
        answered.clear()
        persistAnswered()
    }

    // ⚠️ 这两个方法**不能**叫 setClientId/setLastError：属性 clientId/lastError 的
    // 私有 setter 在 JVM 上就编译成 setClientId/setLastError，会同名冲突（platform clash）。
    fun rememberClientId(value: String?) {
        clientId = value
    }

    fun rememberLastError(value: String?) {
        lastError = value
    }

    /** @return true 表示第一次记录该事件（调用方据此决定是否弹通知）。 */
    fun markAnswered(eventId: String): Boolean {
        val first = answered.markAnswered(eventId)
        persistAnswered()
        return first
    }

    fun forgetAnswered(eventId: String) {
        answered.forget(eventId)
        persistAnswered()
    }

    private fun loadAnswered(): List<String> =
        prefs.getStringSet(KEY_ANSWERED, emptySet())?.toList() ?: emptyList()

    private fun persistAnswered() {
        // getStringSet 返回的集合**不可再改**，必须拷一份。
        prefs.edit().putStringSet(KEY_ANSWERED, LinkedHashSet(answered.snapshot())).apply()
    }

    private companion object {
        const val PREFS = "dsh_relay"
        const val KEY_BASE_URL = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_LABEL = "label"
        const val KEY_CLIENT_ID = "client_id"
        const val KEY_LAST_ERROR = "last_error"
        const val KEY_ANSWERED = "answered_event_ids"
    }
}