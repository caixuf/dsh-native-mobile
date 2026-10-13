package io.github.dshmobile.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.dshmobile.app.net.DshConnection
import io.github.dshmobile.app.render.JsonRender
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class SessionsUiState(
    val rows: List<SessionRow> = emptyList(),
    /** 被折叠起来的子代理会话（默认不显示，用户可展开）。 */
    val subagentRows: List<SessionRow> = emptyList(),
    val showSubagents: Boolean = false,
    val loading: Boolean = true,
    val error: String? = null,
    val query: String = "",
)

class SessionsViewModel(private val conn: DshConnection?) : ViewModel() {

    private val _state = MutableStateFlow(SessionsUiState())
    val state: StateFlow<SessionsUiState> = _state.asStateFlow()

    /** 切换「显示子代理会话」。 */
    fun toggleSubagents() {
        _state.update { it.copy(showSubagents = !it.showSubagents) }
    }

    fun load() {
        val c = conn
        if (c == null) {
            _state.update { it.copy(loading = false, error = "尚未连接到任何电脑") }
            return
        }
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            // args 键名是服务端声明的形参 `_request`（**带下划线**，实测确认）。
            // session/list 是唯一用下划线形参的，别照抄成 request。
            c.call("session.list", buildJsonObject { put("_request", buildJsonObject {}) })
                .onSuccess { value ->
                val obj = value.jsonObject
                val items = JsonRender.arr(obj, "items").orEmpty()
                val all = items.mapNotNull { el ->
                    val item = el as? JsonObject ?: return@mapNotNull null
                    val id = JsonRender.str(item, "sessionId", "id") ?: return@mapNotNull null
                    // 标题等元数据在 projections.values 里，不在顶层。
                    val projections = item["projections"] as? JsonObject
                    val values = projections?.get("values") as? JsonObject
                    // 🔴 子代理会话判据：**只认 `origin == "subagent"`**，不能退化成
                    // 「存在 parentSessionId 就算」。见下方注释（这是实测踩到的坑）。
                    val origin = JsonRender.str(item, "origin")
                    val parent = JsonRender.str(item, "parentSessionId")
                    SessionRow(
                        sessionId = id,
                        title = JsonRender.str(values ?: item, "title")
                            ?: JsonRender.str(item, "title")
                            ?: "未命名会话",
                        preview = JsonRender.str(values ?: item, "preview", "lastMessage", "summary") ?: "",
                        updatedAt = JsonRender.long(item, "updatedAt", "createdAt", "time") ?: 0L,
                        running = JsonRender.bool(item, "running") ?: false,
                        // ⚠️ 判据只能用 `origin`，**不能**写成 `origin == "subagent" || parent != null`。
                        //
                        // 实测（2026-10-13 公网，69 条）：`origin == "subagent"` 的 44 条
                        // **全部**带 parentSessionId，且**全部**打不开（回 durable parent 错误）；
                        // 但反向不成立 —— 有 1 条带 `parentSessionId` 却**没有** `origin`，
                        // 它是 `session.fork` 出来的**普通会话**，用裸 sessionId 打开
                        // **正常返回 records**。若按 `parent != null` 也折叠，就会把这条
                        // 本来能正常打开的会话藏进「子代理」里，属于误伤。
                        isSubagent = origin == "subagent",
                        parentSessionId = parent,
                    )
                }
                // 主列表只放普通会话；子代理会话单独收着，默认不显示。
                _state.update {
                    it.copy(
                        rows = all.filterNot { r -> r.isSubagent },
                        subagentRows = all.filter { r -> r.isSubagent },
                        loading = false,
                    )
                }
            }.onFailure { error ->
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    fun search(query: String) {
        _state.update { it.copy(query = query) }
        val q = query.trim()
        if (q.isEmpty()) {
            load()
            return
        }
        val c = conn ?: return
        viewModelScope.launch {
            // 形参名 `request`（实测确认）。
            c.call("session.search", buildJsonObject {
                put("request", buildJsonObject { put("query", q) })
            }).onSuccess { value ->
                val items = JsonRender.arr(value.jsonObject, "items").orEmpty()
                val rows = items.mapNotNull { el ->
                    val item = el as? JsonObject ?: return@mapNotNull null
                    val id = JsonRender.str(item, "sessionId", "id") ?: return@mapNotNull null
                    SessionRow(
                        sessionId = id,
                        title = JsonRender.str(item, "title") ?: "搜索结果",
                        preview = JsonRender.str(item, "snippet", "preview") ?: "",
                        updatedAt = JsonRender.long(item, "updatedAt") ?: 0L,
                        running = false,
                    )
                }
                _state.update { it.copy(rows = rows, loading = false) }
            }.onFailure { error -> _state.update { it.copy(error = error.message) } }
        }
    }

    fun create(onCreated: (SessionRow) -> Unit) {
        val c = conn ?: return
        viewModelScope.launch {
            // session/create 的 args 形参名是 `request`（实测确认）。
            // 传空对象让主机用默认值建会话。
            c.call("session.create", buildJsonObject { put("request", buildJsonObject {}) })
                .onSuccess { value ->
                val id = JsonRender.str(value.jsonObject, "sessionId") ?: return@onSuccess
                val row = SessionRow(id, "新会话", "", System.currentTimeMillis(), false)
                _state.update { it.copy(rows = listOf(row) + it.rows) }
                onCreated(row)
            }.onFailure { error -> _state.update { it.copy(error = error.message) } }
        }
    }
}