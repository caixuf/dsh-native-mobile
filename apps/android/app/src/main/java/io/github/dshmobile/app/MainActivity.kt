package io.github.dshmobile.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.dshmobile.app.ui.AppViewModel
import io.github.dshmobile.app.ui.ChatViewModel
import io.github.dshmobile.app.ui.DshMobileTheme
import io.github.dshmobile.app.ui.SessionRow
import io.github.dshmobile.app.ui.SessionsViewModel
import io.github.dshmobile.app.ui.screens.ChatScreen
import io.github.dshmobile.app.ui.screens.HostsScreen
import io.github.dshmobile.app.ui.screens.PairScreen
import io.github.dshmobile.app.ui.screens.SessionsScreen

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

    LaunchedEffect(Unit) { appVm.refresh() }

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
            onPair = { base, code, name ->
                appVm.pair(base, code, name) { route = Route.Sessions }
            },
            deviceName = AppViewModel.deviceName(),
        )

        Route.Sessions -> {
            val sessionsVm: SessionsViewModel = viewModel(
                factory = object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>): T =
                        SessionsViewModel(appVm.connection) as T
                },
            )
            SessionsScreen(
                linkState = state.link,
                onOpen = { row -> session = row; route = Route.Chat },
                vm = sessionsVm,
            )
        }

        Route.Chat -> {
            val current = session
            val chatVm: ChatViewModel = viewModel(
                key = "chat-${current?.sessionId}",
                factory = object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>): T =
                        ChatViewModel(appVm.connection) as T
                },
            )
            LaunchedEffect(current?.sessionId) {
                if (current != null) chatVm.open(current.sessionId, current.title)
            }
            ChatScreen(
                title = current?.title.orEmpty(),
                onBack = { route = Route.Sessions },
                vm = chatVm,
            )
        }
    }
}