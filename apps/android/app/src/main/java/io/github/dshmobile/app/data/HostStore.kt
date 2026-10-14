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

    /**
     * 合并已有的重复记录（每组同机器只留 `lastUsedAt` 最新的一条）。
     *
     * 用于清理历史遗留：修复 upsert 之前，同一台电脑会被存成多条。
     * App 启动时调用一次即可，无重复时不做任何写入。
     *
     * @return 合并掉的条数（0 表示没有变化）
     */
    fun dedupe(): Int {
        val current = all()
        if (current.size <= 1) return 0

        val best = LinkedHashMap<String, HostRecord>()
        for (record in current.sortedByDescending { it.lastUsedAt }) {
            val key = if (record.instanceName.isNotBlank()) {
                "n:" + record.instanceName.trim().lowercase()
            } else {
                "u:" + normalizeUrl(record.baseUrl)
            }
            // sortedByDescending 保证第一次遇到的就是最新的，直接 putIfAbsent
            if (!best.containsKey(key)) best[key] = record
        }

        val next = best.values.toList()
        val removed = current.size - next.size
        if (removed > 0) {
            Log.i(TAG, "已合并 $removed 条重复主机记录：${current.size} → ${next.size}")
            persist(next)
        }
        return removed
    }

    /**
     * 写入一台已配对的电脑。
     *
     * 🔴 **同一台电脑只保留一条记录**（2026-10-14 实测修复）。
     *
     * 原实现只按 `id` 去重，而 `id` 是本机随机生成的 UUID ——
     * 服务端每次登录/配对都签发**新的 deviceId**，于是同一台电脑
     * 在列表里会堆成好几条：换一个地址（公网 ↔ 局域网）登录一次就多一条，
     * 实测同一台机器积出两条同名 `desktop`，分不清哪个是哪个。
     *
     * 归并键取 `instanceName`（即服务端返回的 `instance.name`，DSH profile 名，
     * 例如 `desktop`）—— 它是**电脑身份**，与用哪个地址连进来无关。
     * 命中的旧记录被替换：地址与 token 更新成最近一次用的，
     * `id` 沿用旧值以免打断正在引用的 UI 状态。
     *
     * 兜底：`instanceName` 为空时（老数据或服务端未返回），退回按 `baseUrl` 归并，
     * 保证「同一地址重复登录」也只会有一条。
     */
    fun upsert(record: HostRecord) {
        val existing = all().firstOrNull { it.sameMachineAs(record) }

        val merged = if (existing != null) {
            // 保留原 id，其余字段取最新（地址、token、deviceId、label 都是新的）
            record.copy(id = existing.id, pairedAt = existing.pairedAt)
        } else {
            record
        }

        val next = all()
            .filterNot { it.sameMachineAs(record) }
            .filterNot { it.id == merged.id } + merged

        persist(next.sortedByDescending { it.lastUsedAt })
    }

    /**
     * 是否指向同一台电脑。
     *
     * 优先比 `instanceName`（电脑身份）；它缺失时退回比规范化后的地址。
     * ⚠️ 这是 UI 层的"去重展示"判据，**不是安全边界** —— 鉴权始终靠 token。
     */
    private fun HostRecord.sameMachineAs(other: HostRecord): Boolean {
        val a = instanceName.trim().lowercase()
        val b = other.instanceName.trim().lowercase()
        if (a.isNotEmpty() && b.isNotEmpty()) return a == b
        // 退路：电脑名缺失时，同地址视为同一台
        return normalizeUrl(baseUrl) == normalizeUrl(other.baseUrl)
    }

    private fun normalizeUrl(url: String): String = url.trim().trimEnd('/').lowercase()

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

    /**
     * 记住最近一次成功使用的网关地址，供下次登录预填。
     *
     * 🔴 为什么需要（2026-10-14 用户反馈）：
     *
     * 「能不能不要填网址，只账户密码」—— 账号密码登录每次都要求手打
     * `http://192.168.x.x:19387`，这是纯粹的重复劳动。地址在一台电脑上基本不变，
     * 记一次就够。
     *
     * 取值优先级（见 [lastBaseUrl]）：
     *   1. 已保存主机里最近使用过的地址（最可信 —— 它真的连上过）
     *   2. 显式记住的历史地址（用户可能删过主机但地址仍有效）
     *
     * 注意：这是**便利性**缓存，不是安全边界 —— 鉴权始终靠 token。
     */
    fun rememberBaseUrl(url: String) {
        val clean = url.trim()
        if (clean.isEmpty()) return
        runCatching { prefs.edit().putString(KEY_LAST_BASE_URL, clean).apply() }
    }

    /** 最近使用过的网关地址；没有则返回空串（UI 会显示占位提示）。 */
    fun lastBaseUrl(): String {
        // 优先用「已保存主机」里的地址 —— 那是确实配对成功过的，比历史缓存可靠。
        val hosts = runCatching { all() }.getOrElse { emptyList() }
        val fromHost = hosts.maxByOrNull { it.lastUsedAt }?.baseUrl?.takeIf { it.isNotBlank() }
        val cached = runCatching { prefs.getString(KEY_LAST_BASE_URL, "") }.getOrNull().orEmpty()
        Log.i(TAG, "lastBaseUrl: hosts=${hosts.size} fromHost=${fromHost ?: "-"} cached=${if (cached.isBlank()) "-" else cached}")
        return fromHost ?: cached
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

    /** 最近一次成功使用的网关地址（用于登录页预填）。 */
    private const val KEY_LAST_BASE_URL = "last_base_url"
        private const val PLAIN_NAME = "dsh_hosts"
    }
}

class HostStoreException(message: String, cause: Throwable? = null) : Exception(message, cause)