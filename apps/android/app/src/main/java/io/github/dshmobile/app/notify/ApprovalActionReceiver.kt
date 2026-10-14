package io.github.dshmobile.app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 通知按钮的应答接收器。
 *
 * ## 为什么用 BroadcastReceiver 而不是 Activity
 *
 * 用户在**锁屏**上点了「允许」，不应该被强迫先解锁进 App ——
 * 那会让"立刻响应"变成"先解锁、再找 App、再点允许"。
 * 用 Receiver 直接在后台把应答发出去，通知自动消失，用户继续做别的事。
 *
 * 对齐 iOS/Android 上成熟远程控制类应用的做法（TeamViewer/向日葵同类交互）。
 */
class ApprovalActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val rpcId = intent.getStringExtra("rpcId") ?: return
        when (intent.action) {
            ACTION_APPROVE -> {
                ConnectionHub.respondApproval(rpcId, approved = true)
            }
            ACTION_REJECT -> {
                ConnectionHub.respondApproval(rpcId, approved = false)
            }
            ACTION_ANSWER -> {
                val answer = intent.getStringExtra("answer") ?: return
                val questionId = intent.getStringExtra("questionId") ?: return
                ConnectionHub.respondQuestion(rpcId, questionId, answer)
            }
        }
    }

    private companion object {
        const val ACTION_APPROVE = "io.github.dshmobile.app.APPROVE"
        const val ACTION_REJECT = "io.github.dshmobile.app.REJECT"
        const val ACTION_ANSWER = "io.github.dshmobile.app.ANSWER"
    }
}
