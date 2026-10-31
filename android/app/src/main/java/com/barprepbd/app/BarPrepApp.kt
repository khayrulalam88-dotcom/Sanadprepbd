package com.barprepbd.app

import android.app.Application

class BarPrepApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: BarPrepApp
            private set
    }
}
