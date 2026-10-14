package io.github.dshmobile.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import io.github.dshmobile.app.relay.ApprovalRelayService
import io.github.dshmobile.app.relay.NativeBridge
import io.github.dshmobile.app.relay.RelayStore

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
            addJavascriptInterface(NativeBridge(this@MainActivity), "DSHNative")

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    request.grant(request.resources)
                }
            }

            webViewClient = object : WebViewClient() {}
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
        if (!isDebuggable()) return
        seedRelayFromIntent(intent)
        if (RelayStore(this).isConfigured()) ApprovalRelayService.start(this)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        if (::webView.isInitialized) webView.onPause()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    private companion object {
        const val REQUEST_NOTIFICATIONS = 0x4453
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
