package io.github.dshmobile.app

import android.app.Application
import io.github.dshmobile.app.data.HostStore

class DshMobileApp : Application() {
    lateinit var hosts: HostStore
        private set

    override fun onCreate() {
        super.onCreate()
        hosts = HostStore(this)
    }
}