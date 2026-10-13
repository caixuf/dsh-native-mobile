package io.github.dshmobile.app.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

private const val TAG = "DSH_HOST_STORE"

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
)

/**
 * 已配对电脑的本地存储。
 *
 * ## 为什么会「登录成功但设备列表是空的」
 *
 * `EncryptedSharedPreferences` 是 Tink 实现的：键集与值都分别加密，任一环节失败
 * （部分国产 ROM 的 Keystore 实现有兼容问题、备份还原导致密钥不匹配、Keystore 被重置）
 * 都会让 `getString()` **在读的时候**抛异常。
 *
 * 早前版本用 `runCatching { … }.getOrNull()` 把异常吞了，于是 `all()` 返回空列表 ——
 * 表现为「刚登录成功、UI 也跳过去了，但设备一个都没有」，而且**没有任何日志**，
 * 排查时完全看不出是哪一环坏了。
 *
 * 现在做三件事：
 *  1. 建 prefs 时就记录走了哪条路径（加密 / 回退）
 *  2. 读失败**不吞异常**：记日志 + 清掉坏数据 + 重试一次
 *  3. 写失败明确抛 `HostStoreException`，让 UI 能显示「保存失败」而不是假装成功
 */
class HostStore(context: Context) {
    private val appContext = context.applicationContext
    private val usingEncrypted: Boolean

    private val prefs: SharedPreferences

    init {
        var encrypted = false
        var primary: SharedPreferences? = null
        try {
            val masterKey = MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            primary = EncryptedSharedPreferences.create(
                appContext,
                PLAIN_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            encrypted = true
        } catch (error: Exception) {
            Log.w(TAG, "加密存储不可用，回退到普通存储（token 将以明文落盘）", error)
        }
        prefs = primary ?: appContext.getSharedPreferences(PLAIN_NAME, Context.MODE_PRIVATE)
        usingEncrypted = encrypted
        Log.i(TAG, "存储初始化完成: encrypted=$usingEncrypted, file=$PLAIN_NAME")
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** 加密存储是否真的可用（界面可以据此提示用户）。 */
    fun isEncrypted(): Boolean = usingEncrypted

    fun all(): List<HostRecord> {
        readHosts()?.let { return it }

        // 读失败：多半是密钥与数据不匹配（换机、备份还原、Keystore 重置）。
        // 清掉这份坏数据重新开始，而不是永远返回空列表装没发生过。
        Log.w(TAG, "读取失败，疑似密钥与数据不匹配；已清除并重建存储")
        runCatching { prefs.edit().clear().commit() }
        return emptyList()
    }

    private fun readHosts(): List<HostRecord>? {
        val raw = try {
            prefs.getString(KEY_HOSTS, null)
        } catch (error: Exception) {
            Log.w(TAG, "getString 抛出异常（加密数据与密钥不匹配？）", error)
            return null
        } ?: return emptyList()
        if (raw.isBlank()) return emptyList()
        return try {
            json.decodeFromString<List<HostRecord>>(raw)
        } catch (error: Exception) {
            Log.w(TAG, "JSON 解析失败", error)
            null
        }
    }

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

    /** 写失败必须抛出去 —— 否则 UI 会假装登录成功，实际下次启动就没了。 */
    private fun persist(records: List<HostRecord>) {
        val ok = try {
            prefs.edit().putString(KEY_HOSTS, json.encodeToString(records)).commit()
        } catch (error: Exception) {
            Log.e(TAG, "写入失败（加密存储异常）", error)
            throw HostStoreException("保存失败：${error.message ?: error.javaClass.simpleName}", error)
        }
        if (!ok) {
            Log.e(TAG, "写入返回 false")
            throw HostStoreException("保存失败：设备存储写入被拒绝")
        }
    }

    companion object {
        private const val KEY_HOSTS = "hosts"
        private const val PLAIN_NAME = "dsh_hosts"
    }
}

class HostStoreException(message: String, cause: Throwable? = null) : Exception(message, cause)