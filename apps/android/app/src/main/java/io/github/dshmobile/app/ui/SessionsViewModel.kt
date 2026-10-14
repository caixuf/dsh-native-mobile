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
    /** 聚合后的工作区组列表（按运行态与活跃时间排序）。 */
    val workspaceGroups: List<WorkspaceGroup> = emptyList(),
    /** 当前处于展开状态的工作区 cwd 集合。 */
    val expandedWorkspaces: Set<String?> = emptySet(),
    val showSubagents: Boolean = false,
    val loading: Boolean = true,
    val error: String? = null,
    val query: String = "",
)

class SessionsViewModel(private val connProvider: () -> DshConnection?) : ViewModel() {

    constructor(conn: DshConnection?) : this({ conn })

    private val conn: DshConnection? get() = connProvider()

    private val _state = MutableStateFlow(SessionsUiState())
    val state: StateFlow<SessionsUiState> = _state.asStateFlow()

    /** 切换「显示子代理会话」。 */
    fun toggleSubagents() {
        _state.update { it.copy(showSubagents = !it.showSubagents) }
    }

    /** 展开或折叠特定工作区。 */
    fun toggleWorkspace(cwd: String?) {
        _state.update { current ->
            val next = current.expandedWorkspaces.toMutableSet()
            if (next.contains(cwd)) {
                next.remove(cwd)
            } else {
                next.add(cwd)
            }
            current.copy(expandedWorkspaces = next)
        }
    }

    fun load() {
        val c = conn
        if (c == null) {
            _state.update { it.copy(loading = false) }
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
                        isSubagent = origin == "subagent",
                        parentSessionId = parent,
                        // 工作区：主机 `session.list` 的 `cwd` 字段（实测存在）。
                        workspace = JsonRender.str(item, "cwd")
                            ?: JsonRender.str(values ?: item, "cwd"),
                    )
                }
                val normalRows = all.filterNot { r -> r.isSubagent }
                val saRows = all.filter { r -> r.isSubagent }
                val groups = WorkspaceFormatter.groupSessions(normalRows, saRows)

                _state.update { current ->
                    // 默认展开：有运行中会话的组优先展开；若都空闲，默认展开最新的第一组
                    val initialExpanded = if (current.expandedWorkspaces.isEmpty()) {
                        val runningCwds = groups.filter { it.runningCount > 0 }.map { it.cwd }.toSet()
                        if (runningCwds.isNotEmpty()) runningCwds else setOf(groups.firstOrNull()?.cwd)
                    } else {
                        current.expandedWorkspaces
                    }

                    current.copy(
                        rows = normalRows,
                        subagentRows = saRows,
                        workspaceGroups = groups,
                        expandedWorkspaces = initialExpanded,
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
                        workspace = JsonRender.str(item, "cwd"),
                    )
                }
                val groups = WorkspaceFormatter.groupSessions(rows, emptyList())
                _state.update { current ->
                    // 搜索态下自动展开所有包含命中项的工作区（Task 10）
                    val searchExpanded = groups.map { it.cwd }.toSet()
                    current.copy(
                        rows = rows,
                        workspaceGroups = groups,
                        expandedWorkspaces = searchExpanded,
                        loading = false,
                    )
                }
            }.onFailure { error -> _state.update { it.copy(error = error.message) } }
        }
    }

    fun create(cwd: String? = null, onCreated: (SessionRow) -> Unit) {
        fun addRow(row: SessionRow) {
            _state.update { current ->
                val nextRows = listOf(row) + current.rows
                val nextGroups = WorkspaceFormatter.groupSessions(nextRows, current.subagentRows)
                current.copy(
                    rows = nextRows,
                    workspaceGroups = nextGroups,
                    expandedWorkspaces = current.expandedWorkspaces + setOf(cwd),
                )
            }
            onCreated(row)
        }

        val c = conn
        if (c == null) {
            val row = SessionRow("local-${System.currentTimeMillis()}", "随身遥控会话", "按住说话测试", System.currentTimeMillis(), false, workspace = cwd)
            addRow(row)
            return
        }
        viewModelScope.launch {
            // session/create 的 args 形参名是 `request`（实测确认）。
            // 支持传入 cwd 绑定已有电脑工作区。
            c.call(
                "session.create",
                buildJsonObject {
                    put(
                        "request",
                        buildJsonObject {
                            if (!cwd.isNullOrBlank()) {
                                put("cwd", cwd)
                            }
                        },
                    )
                },
            ).onSuccess { value ->
                val id = JsonRender.str(value.jsonObject, "sessionId")
                    ?: "session-${System.currentTimeMillis()}"
                val row = SessionRow(id, "新会话", "", System.currentTimeMillis(), false, workspace = cwd)
                addRow(row)
            }.onFailure { error ->
                _state.update { it.copy(error = error.message) }
                val row = SessionRow("local-${System.currentTimeMillis()}", "随身遥控会话", "按住说话测试", System.currentTimeMillis(), false, workspace = cwd)
                addRow(row)
            }
        }
    }
}