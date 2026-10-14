package io.github.dshmobile.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log
import io.github.dshmobile.app.data.HostStore
import io.github.dshmobile.app.notify.ConnectionHub

class DshMobileApp : Application() {

    lateinit var hosts: HostStore
        private set

    /**
     * 前台 Activity 计数。
     *
     * 用**计数**而不是布尔：`onActivityStarted`/`onActivityStopped` 在
     * Activity 切换（A 停 → B 起）时会交错触发，布尔量会出现"明明在前台
     * 却判定为后台"的抖动 —— 那会导致**用户正在看 App 时弹出通知**。
     * 计数天然消除这个竞态。
     */
    private var startedActivities = 0

    override fun onCreate() {
        super.onCreate()
        hosts = HostStore(this)

        // 启动时合并历史遗留的重复主机记录。
        //
        // 🔴 修复 upsert 之前，同一台电脑每换一个地址登录就会多存一条。
        // 这里做一次性清理；无重复时 `dedupe()` 不写盘，零副作用。
        // 失败不能影响启动 —— 存储异常时按原有数据继续跑即可。
        runCatching { hosts.dedupe() }
            .onFailure { Log.w("DSH_APP", "主机记录合并失败（不影响启动）", it) }

        // 建立通知渠道 + 进程级连接中心。
        //
        // 放在 Application.onCreate 是**必须**的：通知渠道必须在**发出第一条通知前**
        // 创建，否则 Android 8+ 会直接丢弃（不报错，静默丢弃 —— 很难查）。
        // 而且前台服务可能在 App 没打开时就启动，那时 Application 是唯一的入口。
        runCatching { ConnectionHub.init(this) }
            .onFailure { Log.w("DSH_APP", "通知渠道初始化失败", it) }

        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                startedActivities += 1
                ConnectionHub.appInForeground = true
            }

            override fun onActivityStopped(activity: Activity) {
                startedActivities = (startedActivities - 1).coerceAtLeast(0)
                // 计数归零才认定"退到后台" —— 见上面关于竞态的说明
                if (startedActivities == 0) {
                    ConnectionHub.appInForeground = false
                }
            }

            // 其余回调本功能不需要，留空实现。
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }
}
