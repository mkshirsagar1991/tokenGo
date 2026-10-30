import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Fills in the login code by itself when it arrives on WhatsApp (Meta's one-tap / zero-tap autofill). Android only: everywhere else,
/// and on a phone without WhatsApp, every call quietly does nothing and the person types or pastes the code as before.
///
/// Usage: call [startHandshake] just BEFORE asking the server to send a code (WhatsApp ignores a code that arrives before the
/// handshake), then on the code screen listen to [codeAvailable] and claim the code with [takePendingCode]. The native side
/// (tokengo_core/native/android) keeps the code in memory for at most 10 minutes and hands it out once.
class WhatsAppOtpAutofill {
  WhatsAppOtpAutofill({MethodChannel? channel, this._timeout = const Duration(seconds: 3)})
    : _channel = channel ?? const MethodChannel(channelName) {
    _channel!.setMethodCallHandler((call) async {
      if (call.method == 'codeAvailable') _available.add(null);
      return null;
    });
  }

  /// Does nothing at all (no native calls, never a code). For widget tests of screens that have nothing to do with autofill:
  /// without the Android side registered, a native call in a widget test never answers.
  WhatsAppOtpAutofill.disabled() : _channel = null, _timeout = Duration.zero;

  static const channelName = 'tokengo/whatsapp_otp';

  final MethodChannel? _channel;

  /// A stuck native call must never hold up signing in: autofill is a convenience.
  final Duration _timeout;
  final _available = StreamController<void>.broadcast();

  bool get _supported => _channel != null && !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// Fires when the native side has a code waiting. Claim it with [takePendingCode].
  Stream<void> get codeAvailable => _available.stream;

  /// Tells WhatsApp this app is about to wait for a code. Never throws; false means "no autofill this time" (not Android,
  /// WhatsApp missing or too old, or the native side is absent or slow).
  Future<bool> startHandshake() async {
    if (!_supported) return false;
    try {
      return await _channel!.invokeMethod<bool>('startHandshake').timeout(_timeout) ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    } on TimeoutException {
      return false;
    }
  }

  /// The 6-digit code that arrived from WhatsApp, once; null if there is none (or it is not exactly 6 digits).
  Future<String?> takePendingCode() async {
    if (!_supported) return null;
    try {
      final code = await _channel!.invokeMethod<String>('takePendingCode').timeout(_timeout);
      return code != null && RegExp(r'^\d{6}$').hasMatch(code) ? code : null;
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    } on TimeoutException {
      return null;
    }
  }

  void dispose() {
    _channel?.setMethodCallHandler(null);
    _available.close();
  }
}

final whatsAppOtpAutofillProvider = Provider<WhatsAppOtpAutofill>((ref) {
  final service = WhatsAppOtpAutofill();
  ref.onDispose(service.dispose);
  return service;
});
