package com.tokengo.core.whatsapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Zero-tap: WhatsApp broadcasts the code (action com.whatsapp.otp.OTP_RETRIEVED) and the app fills it in with no tap.
 * The same receiver hears WhatsApp's debug signal (com.whatsapp.otp.OTP_ERROR) and logs why a code was not handed over.
 */
class WhatsAppOtpReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == WhatsAppOtp.ACTION_ERROR) WhatsAppOtp.logDebugSignal(intent) else WhatsAppOtp.accept(context, intent)
    }
}
