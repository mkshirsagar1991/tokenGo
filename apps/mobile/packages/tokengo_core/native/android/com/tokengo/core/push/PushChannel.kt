package com.tokengo.core.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * The notification channel every TokenGo push message is delivered on (the server names it `tokengo_default` in each message).
 * Android 8+ needs the channel to exist; creating it here makes the messages appear as a banner with sound instead of silently
 * in the shade. Creating a channel that already exists changes nothing, so this is safe on every start.
 */
object PushChannel {
    const val ID = "tokengo_default"

    fun ensure(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(ID) != null) return
        val channel = NotificationChannel(ID, "Bookings and updates", NotificationManager.IMPORTANCE_HIGH)
        channel.description = "New and changed bookings, wallet and payout updates"
        manager.createNotificationChannel(channel)
    }
}
