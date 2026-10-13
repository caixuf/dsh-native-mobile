package io.github.dshmobile.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.dshmobile.app.net.LinkState
import io.github.dshmobile.app.ui.AppViewModel
import io.github.dshmobile.app.ui.ChatViewModel
import io.github.dshmobile.app.ui.DshMobileTheme
import io.github.dshmobile.app.ui.SessionRow
import io.github.dshmobile.app.ui.SessionsViewModel
import io.github.dshmobile.app.ui.components.AppDrawer
import io.github.dshmobile.app.ui.screens.ChatScreen
import io.github.dshmobile.app.ui.screens.HostsScreen
import io.github.dshmobile.app.ui.screens.PairScreen
import io.github.dshmobile.app.ui.screens.SessionsScreen
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            DshMobileTheme {
                val app = application as DshMobileApp
                AppRoot(app)
            }
        }
    }
}

private enum class Route { Hosts, Pair, Sessions, Chat }

@Composable
private fun AppRoot(app: DshMobileApp) {
    val appVm: AppViewModel = viewModel(
        factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel(app.hosts) as T
        },
    )
    val state by appVm.state.collectAsStateWithLifecycle()
    var route by remember { mutableStateOf(Route.Hosts) }
    var session by remember { mutableStateOf<SessionRow?>(null) }

    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    val sessionsVm: SessionsViewModel = viewModel(
        key = "sessions-${state.activeId}",
        factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                SessionsViewModel { appVm.connection } as T
        },
    )
    val sessionsState by sessionsVm.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { appVm.refresh() }

    // 登录/配对成功后自动进入会话列表。
    LaunchedEffect(state.notice) {
        if (route == Route.Pair && state.notice != null) route = Route.Sessions
    }

    val isDrawerEnabled = (route == Route.Sessions || route == Route.Chat)

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = isDrawerEnabled,
        drawerContent = {
            if (isDrawerEnabled) {
                val readyHostName = (state.link as? LinkState.Ready)?.hostName?.takeIf { it.isNotBlank() }
                val currentHostName = readyHostName
                    ?: state.hosts.firstOrNull { it.id == state.activeId }?.label
                AppDrawer(
                    activeHostName = currentHostName,
                    isHostOnline = state.link is LinkState.Ready,
                    sessions = sessionsState.rows,
                    currentSessionId = session?.sessionId,
                    onSelectSession = { row ->
                        session = row
                        route = Route.Chat
                        scope.launch { drawerState.close() }
                    },
                    onNewSession = {
                        val currentWs = session?.workspace
                            ?: sessionsState.rows.firstOrNull()?.workspace
                        sessionsVm.create(currentWs) { row ->
                            session = row
                            route = Route.Chat
                        }
                        scope.launch { drawerState.close() }
                    },
                    onManageHosts = {
                        route = Route.Hosts
                        scope.launch { drawerState.close() }
                    },
                    onClose = {
                        scope.launch { drawerState.close() }
                    },
                )
            }
        },
    ) {
        when (route) {
            Route.Hosts -> HostsScreen(
                state = state,
                onOpen = { id -> appVm.select(id); route = Route.Sessions },
                onForget = { appVm.forget(it) },
                onReconnect = { appVm.reconnect() },
                onAdd = { route = Route.Pair },
            )

            Route.Pair -> PairScreen(
                busy = state.busy,
                error = state.error,
                onBack = if (state.hosts.isNotEmpty()) { { route = Route.Hosts } } else null,
                onLogin = { base, user, pass, name -> appVm.login(base, user, pass, name) },
                onPair = { base, code, name ->
                    appVm.pair(base, code, name) { route = Route.Sessions }
                },
                deviceName = AppViewModel.deviceName(),
            )

            Route.Sessions -> {
                SessionsScreen(
                    linkState = state.link,
                    onOpen = { row -> session = row; route = Route.Chat },
                    vm = sessionsVm,
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                )
            }

            Route.Chat -> {
                val current = session
                val chatVm: ChatViewModel = viewModel(
                    key = "chat-${current?.sessionId}",
                    factory = object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            ChatViewModel { appVm.connection } as T
                    },
                )
                LaunchedEffect(current?.sessionId) {
                    if (current != null) chatVm.open(current.sessionId, current.title)
                }
                ChatScreen(
                    title = current?.title.orEmpty(),
                    onBack = {
                        sessionsVm.load()
                        route = Route.Sessions
                    },
                    vm = chatVm,
                    hostName = (state.link as? LinkState.Ready)?.hostName?.takeIf { it.isNotBlank() },
                    workspace = current?.workspace,
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                )
            }
        }
    }
}