package com.tokengo.core.whatsapp

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * One-tap: the person taps "Autofill" in the WhatsApp message and WhatsApp opens this invisible activity with the code. It hands the
 * code over, brings the app to the front, and closes itself. It is also what makes zero-tap eligible (WhatsApp requires both).
 */
class WhatsAppOtpActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WhatsAppOtp.accept(this, intent)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            startActivity(launch)
        }
        finish()
    }
}
