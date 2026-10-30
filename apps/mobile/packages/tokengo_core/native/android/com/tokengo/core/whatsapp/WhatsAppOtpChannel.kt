package com.tokengo.core.whatsapp

import android.content.Context
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The bridge to Dart (see tokengo_core `WhatsAppOtpAutofill`). Each app's MainActivity calls [register] / [unregister].
 *
 *   Dart -> native  startHandshake    -> Boolean  (true if WhatsApp was told we are waiting for a code)
 *   Dart -> native  takePendingCode   -> String?  (the 6-digit code that arrived, once; null if none)
 *   native -> Dart  codeAvailable                 (no payload: Dart then claims the code with takePendingCode, so it is used once)
 */
object WhatsAppOtpChannel {
    const val NAME = "tokengo/whatsapp_otp"

    private var channel: MethodChannel? = null
    private var registeredEngine: FlutterEngine? = null

    fun register(engine: FlutterEngine, context: Context) {
        val app = context.applicationContext
        val ch = MethodChannel(engine.dartExecutor.binaryMessenger, NAME)
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "startHandshake" -> result.success(WhatsAppOtp.startHandshake(app))
                "takePendingCode" -> result.success(WhatsAppOtp.takePendingCode())
                else -> result.notImplemented()
            }
        }
        channel?.setMethodCallHandler(null) // a newer engine takes over from an older one
        channel = ch
        registeredEngine = engine
        WhatsAppOtp.onCodeAvailable = {
            try {
                ch.invokeMethod("codeAvailable", null)
            } catch (_: Exception) {
                // the engine is going away; the code stays pending and is claimed when the screen asks again
            }
        }
    }

    /**
     * Called when [engine] is being cleaned up. If a NEWER engine has registered in the meantime (the activity was recreated: the
     * new one is configured before the old one is cleaned up), its channel must stay plugged in: unplugging it would make every
     * later "a code has arrived" notification vanish, which looks exactly like "autofill worked once and then stopped".
     */
    fun unregister(engine: FlutterEngine? = null) {
        if (engine != null && engine !== registeredEngine) return
        WhatsAppOtp.onCodeAvailable = null
        channel?.setMethodCallHandler(null)
        channel = null
        registeredEngine = null
    }
}
