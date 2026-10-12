package io.github.dshmobile.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

/** 一台已配对的电脑。令牌只存在加密存储里，绝不进日志。 */
@Serializable
data class HostRecord(
    val id: String = UUID.randomUUID().toString(),
    val label: String,
    val baseUrl: String,
    val token: String,
    val deviceId: String,
    val instanceName: String = "",
    val pairedAt: Long = System.currentTimeMillis(),
    val lastUsedAt: Long = System.currentTimeMillis(),
) {
    /** ws:// 或 wss:// 前缀。 */
    val wsBase: String get() = baseUrl.replaceFirst(Regex("^http"), "ws")
}

/**
 * 已配对电脑的本地存储。用 `EncryptedSharedPreferences`，密钥落在 Android Keystore，
 * 备份被禁用（见 manifest `allowBackup=false`），避免令牌随备份外流。
 */
class HostStore(context: Context) {
    private val prefs: SharedPreferences = runCatching {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "dsh_hosts",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrElse {
        // 极少数机型 Keystore 不可用时退回普通存储；仍然不写日志。
        context.getSharedPreferences("dsh_hosts_plain", Context.MODE_PRIVATE)
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun all(): List<HostRecord> =
        prefs.getString(KEY_HOSTS, null)
            ?.let { runCatching { json.decodeFromString<List<HostRecord>>(it) }.getOrNull() }
            ?: emptyList()

    fun upsert(record: HostRecord) {
        val next = all().filterNot { it.id == record.id } + record
        persist(next.sortedByDescending { it.lastUsedAt })
    }

    fun touch(id: String) {
        all().firstOrNull { it.id == id }?.let { upsert(it.copy(lastUsedAt = System.currentTimeMillis())) }
    }

    fun find(id: String): HostRecord? = all().firstOrNull { it.id == id }

    fun remove(id: String) {
        persist(all().filterNot { it.id == id })
    }

    fun rename(id: String, label: String) {
        all().firstOrNull { it.id == id }?.let { upsert(it.copy(label = label)) }
    }

    private fun persist(records: List<HostRecord>) {
        prefs.edit().putString(KEY_HOSTS, json.encodeToString(records)).apply()
    }

    companion object {
        private const val KEY_HOSTS = "hosts"
    }
}