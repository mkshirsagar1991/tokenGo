package com.tokengo.tokengo_provider

import android.os.Bundle
import com.tokengo.core.push.PushChannel
import com.tokengo.core.whatsapp.WhatsAppOtpChannel
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PushChannel.ensure(this)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        WhatsAppOtpChannel.register(flutterEngine, this)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        WhatsAppOtpChannel.unregister(flutterEngine)
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
