package io.github.dshmobile.app

import android.app.Application
import android.util.Log
import io.github.dshmobile.app.data.HostStore

class DshMobileApp : Application() {
    lateinit var hosts: HostStore
        private set

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
    }
}
