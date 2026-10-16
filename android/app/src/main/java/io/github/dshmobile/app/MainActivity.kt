package io.github.dshmobile.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import io.github.dshmobile.app.relay.ApprovalRelayService
import io.github.dshmobile.app.relay.NativeBridge
import io.github.dshmobile.app.relay.NativeDeepLink
import io.github.dshmobile.app.relay.PendingDeepLink
import io.github.dshmobile.app.relay.RelayStore
import io.github.dshmobile.app.relay.ShellBackAction
import io.github.dshmobile.app.relay.ShellBackPolicy
import io.github.dshmobile.app.relay.ShellBackState
import io.github.dshmobile.app.relay.WebRouteTracker

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge

    /** 页面是否已经加载完（没加载完就别急着推深链）。 */
    private var webReady = false

    /** BACK 正在等网页回话：期间的重复按键忽略，避免并发判定。 */
    private var backInFlight = false

    /** 上次"再按一次退出"的时刻；0 = 没有待确认的退出。 */
    private var lastExitConfirmAt = 0L

    /** 网页端文件选择器回调（拍照/选图）。 */
    private var uploadMessage: ValueCallback<Array<Uri>>? = null

    /** 网页端相机/录音权限请求暂存。 */
    private var pendingWebPermissionRequest: PermissionRequest? = null

    /** 页面就绪后的补推用（深链回调注册晚于 load 事件）。 */
    private val handler = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // debug 构建开 WebView 远程调试。**这不是开发便利，是验收基础设施**：
        // WebView 的 DOM 不对 uiautomator 暴露（dump 出来是空树），
        // 只能靠坐标点击截图比对 —— 那样的"端到端验收"天天误报。
        // 打开后可以 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
        // 用 CDP 精确驱动与断言（见 scripts/e2e-app-ui.mjs）。
        // release 构建不开，避免把调试端口暴露给外部工具。
        if (isDebuggable()) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // 沉浸式透明状态栏与导航栏
        window.statusBarColor = Color.parseColor("#090A0F")
        window.navigationBarColor = Color.parseColor("#090A0F")
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)

        // 仅 debug 构建：允许用 `am start` 的 extra 预置中继凭据，供自动化端到端验证使用。
        // release 构建**忽略**这些 extra —— 否则任何应用都能把中继指向自己的服务器。
        if (isDebuggable()) {
            seedRelayFromIntent(intent)
        }

        // 审批提醒需要通知权限（Android 13+）。**必须由用户授权**：
        // 没有它，审批到达手机也不会显示，而且不报错 —— 是本产品最危险的静默失败。
        requestNotificationPermissionIfNeeded()

        // 已配对过就直接把中继拉起来，用户不必先打开页面：
        // App 被系统回收后重进，通道应当自动恢复。
        val store = RelayStore(this)
        if (store.isConfigured()) {
            ApprovalRelayService.start(this)
        }

        // 桥必须在 WebView 之前建好：BACK 判定要读它持有的路由/深链状态。
        bridge = NativeBridge(this)
        // 从通知点进来（冷启动）：先把会话 id 接住，页面就绪后再交给网页。
        readDeepLink(intent)

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#090A0F"))
            overScrollMode = View.OVER_SCROLL_NEVER

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
                displayZoomControls = false
                setSupportZoom(false)
            }

            // 网页端连接成功时把凭据交给原生，由中继服务持续守着审批通道。
            addJavascriptInterface(bridge, "DSHNative")

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    val requestedResources = request.resources
                    val needsCamera = requestedResources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    val needsAudio = requestedResources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)

                    val missing = mutableListOf<String>()
                    if (needsCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        missing.add(Manifest.permission.CAMERA)
                    }
                    if (needsAudio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        missing.add(Manifest.permission.RECORD_AUDIO)
                    }

                    if (missing.isNotEmpty()) {
                        pendingWebPermissionRequest = request
                        requestPermissions(missing.toTypedArray(), REQUEST_WEB_PERMISSIONS)
                    } else {
                        request.grant(requestedResources)
                    }
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    uploadMessage?.onReceiveValue(null)
                    uploadMessage = filePathCallback
                    val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "image/*"
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }
                    try {
                        startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE)
                    } catch (e: Exception) {
                        uploadMessage = null
                        filePathCallback?.onReceiveValue(null)
                        return false
                    }
                    return true
                }
            }

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    webReady = true
                    // 网页可能刚注册好 window.dshNativeOnDeepLink —— 现在推才推得到。
                    deliverPendingDeepLink()
                    // React 首帧晚于 load 事件是常态（此刻回调还没注册）：补两次推送，
                    // 否则用户点了通知却停在列表页。pending 被消费后这些补推都是空操作。
                    handler.postDelayed({ deliverPendingDeepLink() }, 1_200L)
                    handler.postDelayed({ deliverPendingDeepLink() }, 3_000L)
                }
            }

            setDownloadListener { downloadUrl, _, _, _, _ ->
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl))
                    startActivity(intent)
                } catch (_: Exception) {}
            }
        }

        setContentView(webView)

        webView.loadUrl("file:///android_asset/web/index.html")
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    private fun isDebuggable(): Boolean =
        (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    /** 见 [EXTRA_RELAY_BASE_URL] 注释：仅 debug 构建可用。 */
    private fun seedRelayFromIntent(intent: Intent?) {
        val baseUrl = intent?.getStringExtra(EXTRA_RELAY_BASE_URL) ?: return
        val token = intent.getStringExtra(EXTRA_RELAY_TOKEN) ?: return
        val label = intent.getStringExtra(EXTRA_RELAY_LABEL) ?: "relay-e2e"
        RelayStore(this).saveConnection(baseUrl, token, label)
        Log.i(TAG, "已用 intent extra 预置中继凭据：$baseUrl（debug 构建专属）")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // ⚠️ 深链必须**在 debug 分支之外**处理：release 构建里点通知同样要跳会话。
        readDeepLink(intent)
        if (isDebuggable()) {
            seedRelayFromIntent(intent)
            if (RelayStore(this).isConfigured()) ApprovalRelayService.start(this)
        }
        // App 已经在前台时点通知走这里（RelayNotifications 带了 SINGLE_TOP）。
        deliverPendingDeepLink()
    }

    // ── 通知深链（点通知 → 跳到出事的那个会话）───────────────────────────────

    /** 把 intent 里的 `sessionId` 接住，等网页能接的时候再投递。 */
    private fun readDeepLink(intent: Intent?) {
        if (intent == null) return
        bridge.deepLinks().offer(
            intent.getStringExtra(NativeDeepLink.EXTRA_EVENT_ID),
            intent.getStringExtra(NativeDeepLink.EXTRA_SESSION_ID),
        )
    }

    /**
     * 把待投递的深链推给网页。
     *
     * **只有网页返回 `'handled'` 才消费** —— 回调还没注册（`'missing'`）就留在本地，
     * 由网页自己调 `DSHNative.takePendingDeepLink()` 取走。这样既不丢，也不会跳两次。
     */
    private fun deliverPendingDeepLink() {
        if (!::webView.isInitialized || !webReady) return
        val link = bridge.deepLinks().peek() ?: return
        webView.evaluateJavascript(PendingDeepLink.pushScript(link)) { result ->
            if (PendingDeepLink.pushAccepted(result)) bridge.deepLinks().take()
        }
    }

    // ── BACK：绝不误退出 ─────────────────────────────────────────────────────

    /**
     * 🔴 关键修复：旧实现 `if (webView.canGoBack()) goBack() else super.onBackPressed()`。
     *
     * 网页是 SPA，路由切换不产生 WebView 历史 → `canGoBack()` 恒为 false →
     * 在会话列表按一下 BACK 就**退出 App**。现在判定交给可测的纯函数
     * [ShellBackPolicy]：只有"确认在根页面（sessions）、无历史、2 秒内按第二次"才退出。
     */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!::webView.isInitialized) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
            return
        }
        if (backInFlight) return
        val now = System.currentTimeMillis()
        when (val action = ShellBackPolicy.decide(backState(), now, lastExitConfirmAtOrNull())) {
            ShellBackAction.DELEGATE_TO_WEB -> delegateBackToWeb()
            else -> performBackAction(action, now)
        }
    }

    private fun backState(): ShellBackState =
        ShellBackState(route = bridge.route(), webViewCanGoBack = webView.canGoBack())

    /** 0 表示"没有待确认的退出"，不能让 0 落进二次确认窗口。 */
    private fun lastExitConfirmAtOrNull(): Long? = lastExitConfirmAt.takeIf { it > 0L }

    private fun delegateBackToWeb() {
        backInFlight = true
        webView.evaluateJavascript(ShellBackPolicy.webBackScript()) { result ->
            backInFlight = false
            if (ShellBackPolicy.webHandled(result)) {
                lastExitConfirmAt = 0L
                return@evaluateJavascript
            }
            // 网页没处理（回调没接线）：走原生兜底。再次读取状态 —— 这期间页面可能已变。
            val now = System.currentTimeMillis()
            performBackAction(
                ShellBackPolicy.nativeFallback(backState(), now, lastExitConfirmAtOrNull()),
                now,
            )
        }
    }

    private fun performBackAction(action: ShellBackAction, now: Long) {
        when (action) {
            ShellBackAction.WEB_HISTORY_BACK -> {
                lastExitConfirmAt = 0L
                webView.goBack()
            }

            ShellBackAction.CONFIRM_EXIT -> {
                lastExitConfirmAt = now
                Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show()
            }

            ShellBackAction.EXIT_APP -> {
                lastExitConfirmAt = 0L
                finish()
            }

            // 网页没接线 + 用户在深页：什么都不做，也绝不退出。
            ShellBackAction.DELEGATE_TO_WEB, ShellBackAction.IGNORE -> Unit
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
        // 页面已就绪但深链还没被接住（回调注册晚/上一次推失败）时补一次。
        deliverPendingDeepLink()
    }

    override fun onPause() {
        super.onPause()
        if (::webView.isInitialized) webView.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            val result = if (resultCode == Activity.RESULT_OK && data != null) {
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            } else null
            uploadMessage?.onReceiveValue(result)
            uploadMessage = null
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_WEB_PERMISSIONS) {
            val pending = pendingWebPermissionRequest
            pendingWebPermissionRequest = null
            if (pending != null) {
                val granted = mutableListOf<String>()
                for (resource in pending.resources) {
                    when (resource) {
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                            val idx = permissions.indexOf(Manifest.permission.CAMERA)
                            if (idx >= 0 && grantResults.getOrNull(idx) == PackageManager.PERMISSION_GRANTED) {
                                granted.add(resource)
                            }
                        }
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                            val idx = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
                            if (idx >= 0 && grantResults.getOrNull(idx) == PackageManager.PERMISSION_GRANTED) {
                                granted.add(resource)
                            }
                        }
                        else -> granted.add(resource)
                    }
                }
                if (granted.isNotEmpty()) {
                    pending.grant(granted.toTypedArray())
                } else {
                    pending.deny()
                }
            }
        }
    }

    private companion object {
        const val REQUEST_NOTIFICATIONS = 0x4453
        const val FILE_CHOOSER_REQUEST_CODE = 0x4454
        const val REQUEST_WEB_PERMISSIONS = 0x4455
        const val TAG = "DshMobile"

        /**
         * 端到端验证入口（**仅 debug 构建**）：
         *
         * ```
         * adb shell am start -n io.github.dshmobile.app/.MainActivity \
         *   --es dsh_relay_base_url http://127.0.0.1:19400 \
         *   --es dsh_relay_token e2e-token-1
         * ```
         *
         * 有了它，验证「审批到达 → 通知出现 → 点按钮 → 回执主机」这条链路
         * 不需要先跑通完整的配对 UI。release 构建会忽略这些 extra。
         */
        const val EXTRA_RELAY_BASE_URL = "dsh_relay_base_url"
        const val EXTRA_RELAY_TOKEN = "dsh_relay_token"
        const val EXTRA_RELAY_LABEL = "dsh_relay_label"
    }
}
