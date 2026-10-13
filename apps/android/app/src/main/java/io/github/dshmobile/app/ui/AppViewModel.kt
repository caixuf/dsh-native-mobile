package io.github.dshmobile.app.ui

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.dshmobile.app.data.HostRecord
import io.github.dshmobile.app.data.HostStoreException
import io.github.dshmobile.app.data.HostStore
import io.github.dshmobile.app.net.DshCallException
import io.github.dshmobile.app.net.DshConnection
import io.github.dshmobile.app.net.LinkState
import io.github.dshmobile.app.net.PairingClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 会话列表项。字段取自 `session.list` 的 SessionSummary，缺字段时按缺省渲染。
 *
 * ## `isSubagent` 为什么必须有（2026-10-13 公网实测）
 *
 * 真实主机的 `session/list` 会把**子代理会话**也列出来，并且带两个区分字段：
 *
 *     { "sessionId":"885c6803-…", "origin":"subagent",
 *       "parentSessionId":"session-6d6f5432-…", … }
 *
 * 这类会话**不能用裸 sessionId 打开** —— 主机回
 * `subagent Sessions require their durable parent address`。
 * 实测 68 个会话里 **53 个**是这种，也就是说主列表里绝大多数条目点进去都是错误页。
 * 所以必须识别出来、默认不混在主列表里。
 *
 * ⚠️ 判据是 **`origin === "subagent"`**，而不是「带 parentSessionId」。
 * 实测两者不等价：`session.fork` 出来的**普通会话**也带 parentSessionId，
 * 但它用裸 sessionId 打开是**正常**的。按后者判断会误伤可打开的会话。
 */
data class SessionRow(
    val sessionId: String,
    val title: String,
    val preview: String,
    val updatedAt: Long,
    val running: Boolean,
    /** 主机 `session.list` 里 `origin === "subagent"` 的会话（判据只看 origin）。 */
    val isSubagent: Boolean = false,
    /** 子代理会话的所属父会话；fork 出来的普通会话也可能带，**不能当判据**。 */
    val parentSessionId: String? = null,
)

data class HostsUiState(
    val hosts: List<HostRecord> = emptyList(),
    val activeId: String? = null,
    val link: LinkState = LinkState.Disconnected,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
)

/**
 * 应用级状态机：设备列表 → 连接 → 会话。
 *
 * 刻意做得很薄——真正的业务状态机在每个屏幕自己的 ViewModel 里，
 * 这里只负责「当前连的是哪台电脑」和它的连接对象。
 */
class AppViewModel(private val store: HostStore) : ViewModel() {

    private val _state = MutableStateFlow(HostsUiState())
    val state: StateFlow<HostsUiState> = _state.asStateFlow()

    var connection: DshConnection? = null
        private set

    private var connectJob: Job? = null

    fun refresh() {
        _state.update { it.copy(hosts = store.all(), activeId = it.activeId ?: store.all().firstOrNull()?.id) }
    }

    fun activeHost(): HostRecord? = _state.value.activeId?.let { store.find(it) }

    fun select(hostId: String) {
        if (_state.value.activeId == hostId && connection != null) return
        connectJob?.cancel()
        connection?.stop()
        connection = null
        _state.update { it.copy(activeId = hostId, link = LinkState.Connecting(0), error = null) }
        store.touch(hostId)
        refresh()
        startConnection(hostId)
    }

    private fun startConnection(hostId: String) {
        val record = store.find(hostId) ?: return
        val conn = DshConnection(viewModelScope, record.baseUrl, record.token)
        connection = conn
        connectJob = viewModelScope.launch {
            conn.state.collect { s -> _state.update { it.copy(link = s) } }
        }
        conn.start()
    }

    fun reconnect() {
        _state.value.activeId?.let { id ->
            connection?.stop()
            connection = null
            startConnection(id)
        }
    }

    fun forget(hostId: String) {
        store.remove(hostId)
        if (_state.value.activeId == hostId) {
            connection?.stop()
            connection = null
            _state.update { it.copy(activeId = null, link = LinkState.Disconnected) }
        }
        refresh()
    }

    fun rename(hostId: String, label: String) {
        store.rename(hostId, label)
        refresh()
    }

    // ---- 配对 -------------------------------------------------------------

    fun pair(baseUrl: String, code: String, deviceName: String, onDone: (HostRecord) -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null, notice = null) }
        viewModelScope.launch {
            PairingClient.pair(baseUrl, code, deviceName)
                .onSuccess { paired ->
                    val record = HostRecord(
                        label = paired.label,
                        baseUrl = paired.baseUrl,
                        token = paired.token,
                        deviceId = paired.deviceId,
                        instanceName = paired.instanceName,
                    )
                    store.upsert(record)
                    _state.update { it.copy(busy = false, notice = "已配对 ${paired.label}") }
                    refresh()
                    select(record.id)
                    onDone(record)
                }
                .onFailure { error ->
                    _state.update {
                        it.copy(
                            busy = false,
                            error = when (error) {
                                is DshCallException -> error.message
                                else -> error.message ?: "配对失败"
                            },
                        )
                    }
                }
        }
    }

    /**
     * 账号密码登录（首选入口，比配对码好记）。
     *
     * ⚠️ 存盘失败必须当成失败处理：早前 `store.upsert()` 抛异常时，
     * 协程里的异常被吞，UI 却已经跳到会话列表 —— 用户看到的是
     * 「登录成功，但一台电脑都没有」，且没有任何提示。存储层现在会抛
     * HostStoreException，这里显式接住并显示。
     */
    fun login(baseUrl: String, username: String, password: String, deviceName: String) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null, notice = null) }
        viewModelScope.launch {
            PairingClient.login(baseUrl, username, password, deviceName)
                .onSuccess { paired ->
                    val record = HostRecord(
                        label = paired.label,
                        baseUrl = paired.baseUrl,
                        token = paired.token,
                        deviceId = paired.deviceId,
                        instanceName = paired.instanceName,
                    )
                    try {
                        store.upsert(record)
                    } catch (error: HostStoreException) {
                        // 存不下去就别假装成功，否则下次启动又变回空列表。
                        _state.update { it.copy(busy = false, error = error.message) }
                        return@onSuccess
                    }
                    _state.update { it.copy(busy = false, notice = "已登录 ${paired.label}") }
                    refresh()
                    select(record.id)
                }
                .onFailure { error ->
                    _state.update {
                        it.copy(
                            busy = false,
                            error = when (error) {
                                is DshCallException -> error.message
                                else -> error.message ?: "登录失败"
                            },
                        )
                    }
                }
        }
    }

    fun probe(baseUrl: String, onResult: (String?) -> Unit) {
        viewModelScope.launch { onResult(PairingClient.probe(baseUrl)) }
    }

    fun clearMessages() {
        _state.update { it.copy(error = null, notice = null) }
    }

    override fun onCleared() {
        connection?.stop()
        super.onCleared()
    }

    companion object {
        fun deviceName(): String {
            val model = Build.MODEL ?: "Android"
            return model.trim().ifEmpty { "Android" }
        }
    }
}