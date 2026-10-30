package com.tokengo.core.whatsapp

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.whatsapp.otp.android.sdk.WhatsAppOtpHandler
import com.whatsapp.otp.android.sdk.WhatsAppOtpIncomingIntentHandler
import java.util.function.BiConsumer
import java.util.function.Consumer

/**
 * The Android half of "fill the login code in by itself when it arrives on WhatsApp" (Meta's one-tap / zero-tap autofill).
 *
 * The flow, using Meta's OTP Android SDK:
 *  1. Just BEFORE the server is asked to send a code, the app calls [startHandshake]. That tells WhatsApp "this app is waiting
 *     for a code" and returns a random id that only WhatsApp and this app know.
 *  2. WhatsApp then receives the authentication template message. If everything matches (package name + signature hash of the
 *     template, handshake made within 10 minutes) it hands the code back to us: silently to [WhatsAppOtpReceiver] (zero-tap) or
 *     when the person taps "Autofill" to [WhatsAppOtpActivity] (one-tap). Otherwise WhatsApp shows its normal "Copy code" button.
 *  3. [accept] lets the SDK check that the intent really comes from WhatsApp and carries OUR handshake id, and keeps the code
 *     for [takePendingCode]; Flutter is told that a code is waiting and claims it.
 *
 * The code is held in memory only, for at most [MAX_AGE_MS], and is never logged. A handshake id is single-use.
 */
object WhatsAppOtp {
    private const val TAG = "TokenGoWhatsAppOtp"
    private const val PREFS = "tokengo_whatsapp_otp"
    private const val KEY_HANDSHAKE_ID = "handshake_id"
    private const val KEY_HANDSHAKE_AT = "handshake_at"

    const val ACTION_ERROR = "com.whatsapp.otp.OTP_ERROR"

    /** WhatsApp only hands a code to an app that started its handshake within 10 minutes; we apply the same limit. */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    private val SIX_DIGITS = Regex("^\\d{6}$")
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    private var pendingCode: String? = null
    private var pendingAt = 0L

    /** Set by [WhatsAppOtpChannel] while a Flutter engine is attached; called on the main thread. */
    @Volatile
    var onCodeAvailable: (() -> Unit)? = null

    /** True if a handshake was sent (WhatsApp is installed and new enough). False is normal: the person then types or pastes the code. */
    fun startHandshake(context: Context): Boolean {
        val app = context.applicationContext
        repeat(2) { attempt ->
            try {
                val handler = WhatsAppOtpHandler()
                if (!handler.isWhatsAppOtpHandshakeSupported(app)) {
                    Log.i(TAG, "WhatsApp handshake skipped: WhatsApp is missing or too old")
                    return false
                }
                val id = handler.sendOtpIntentToWhatsApp(app)
                // commit(), not apply(): the receiver may run the instant WhatsApp answers and must already see this id.
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_HANDSHAKE_ID, id.toString())
                    .putLong(KEY_HANDSHAKE_AT, System.currentTimeMillis())
                    .commit()
                synchronized(lock) { pendingCode = null } // a code from an earlier request must never be used for this one
                Log.i(TAG, "WhatsApp handshake sent")
                return true
            } catch (e: Exception) {
                Log.w(TAG, "WhatsApp handshake failed (attempt ${attempt + 1}): ${e.javaClass.simpleName}")
            }
        }
        return false
    }

    /** Called by the receiver / activity with the intent WhatsApp sent. Anything not from WhatsApp or not for our handshake is ignored. */
    fun accept(context: Context, intent: Intent) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val expectedId = prefs.getString(KEY_HANDSHAKE_ID, null)
        val startedAt = prefs.getLong(KEY_HANDSHAKE_AT, 0L)
        if (expectedId == null || System.currentTimeMillis() - startedAt > MAX_AGE_MS) {
            Log.i(TAG, "WhatsApp code ignored: no recent handshake")
            return
        }
        WhatsAppOtpIncomingIntentHandler().processOtpCode(
            intent,
            expectedId,
            Consumer { code ->
                if (!SIX_DIGITS.matches(code)) {
                    Log.w(TAG, "WhatsApp code ignored: not 6 digits")
                    return@Consumer
                }
                prefs.edit().remove(KEY_HANDSHAKE_ID).remove(KEY_HANDSHAKE_AT).commit() // single use
                Log.i(TAG, "WhatsApp code accepted")
                synchronized(lock) {
                    pendingCode = code
                    pendingAt = System.currentTimeMillis()
                }
                main.post { onCodeAvailable?.invoke() }
            },
            BiConsumer { error, _ -> Log.w(TAG, "WhatsApp code rejected: $error") },
        )
    }

    /**
     * WhatsApp says WHY it did not hand a code over (wrong signature hash, no handshake, notifications off for WhatsApp…) with a
     * debug signal. Only the reason is logged, so a phone that does not autofill can be diagnosed with
     * `adb logcat -s TokenGoWhatsAppOtp` instead of guessing.
     */
    fun logDebugSignal(intent: Intent) {
        try {
            WhatsAppOtpIncomingIntentHandler().processOtpDebugSignals(
                intent,
                Consumer { signal -> Log.w(TAG, "WhatsApp did not autofill: ${signal.otpErrorIdentifier} ${signal.otpErrorMessage}") },
                BiConsumer { error, _ -> Log.w(TAG, "WhatsApp debug signal unreadable: $error") },
            )
        } catch (e: Exception) {
            Log.w(TAG, "WhatsApp debug signal failed: ${e.javaClass.simpleName}")
        }
    }

    /** Returns the waiting code (once) if it is still fresh, else null. */
    fun takePendingCode(): String? = synchronized(lock) {
        val code = pendingCode
        pendingCode = null
        if (code != null && System.currentTimeMillis() - pendingAt <= MAX_AGE_MS) code else null
    }
}
