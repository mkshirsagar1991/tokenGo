import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'push_service.dart';

/// Push through Firebase Cloud Messaging (Android). It needs the app's `google-services.json` at build time; without it
/// Firebase cannot start, [start] answers false, and the app works exactly as it does without push.
class FirebasePushService implements PushService {
  bool _started = false;
  final _foreground = StreamController<PushMessage>.broadcast();
  final _opened = StreamController<PushMessage>.broadcast();
  final _tokens = StreamController<String>.broadcast();

  static bool get _supported => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  static PushMessage _from(RemoteMessage m) => PushMessage(
    title: m.notification?.title,
    body: m.notification?.body,
    data: {for (final e in m.data.entries) e.key: '${e.value}'},
  );

  @override
  Future<bool> start() async {
    if (_started) return true;
    if (!_supported) return false;
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp();
    } catch (e) {
      debugPrint('Push is off: Firebase could not start (${e.runtimeType}). Is google-services.json in the app?');
      return false;
    }
    final messaging = FirebaseMessaging.instance;
    try {
      await messaging.requestPermission(); // the Android 13+ "allow notifications" question; a refusal only means the system shows none
    } catch (_) {}
    FirebaseMessaging.onMessage.listen((m) => _foreground.add(_from(m)));
    FirebaseMessaging.onMessageOpenedApp.listen((m) => _opened.add(_from(m)));
    messaging.onTokenRefresh.listen(_tokens.add);
    _started = true;
    return true;
  }

  @override
  Future<String?> token() async {
    if (!_started) return null;
    try {
      return await FirebaseMessaging.instance.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get tokenRefreshed => _tokens.stream;

  @override
  Stream<PushMessage> get foreground => _foreground.stream;

  @override
  Stream<PushMessage> get opened => _opened.stream;

  @override
  Future<PushMessage?> initialMessage() async {
    if (!_started) return null;
    try {
      final m = await FirebaseMessaging.instance.getInitialMessage();
      return m == null ? null : _from(m);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> deleteToken() async {
    if (!_started) return;
    try {
      await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }
}
