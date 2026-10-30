import 'dart:ui' show PlatformDispatcher;

import '../net/api_client.dart';
import '../ui/brand.dart';
import 'push_service.dart';

/// Tells the server which phone to send this person's notifications to (POST /devices), and takes it back on sign-out.
/// The server keeps the address encrypted and only ever uses it for that person's own notifications.
class DeviceRegistration {
  DeviceRegistration({required this._api, required this._push, required this._app});

  final ApiClient _api;
  final PushService _push;
  final BrandApp _app;
  String? _registered;

  /// Sends this phone's current push address. Quietly does nothing if there is none. Safe to call again at any time.
  Future<void> register() async {
    final token = await _push.token();
    if (token == null || token.isEmpty) return;
    await _api.post(
      '/devices',
      body: {
        'app': _app == BrandApp.business ? 'PROVIDER' : 'CUSTOMER',
        'platform': 'ANDROID',
        'token': token,
        'locale': _locale(),
      },
    );
    _registered = token;
  }

  /// Takes this phone off the signed-in person's account (the next person to sign in here must not receive their notifications).
  /// Never throws: signing out must always work.
  Future<void> unregister() async {
    try {
      final token = _registered ?? await _push.token();
      if (token != null && token.isNotEmpty) await _api.post('/devices/unregister', body: {'token': token});
    } catch (_) {
      // the server drops a dead address by itself the first time it fails to deliver
    }
    _registered = null;
    await _push.deleteToken();
  }

  static String _locale() {
    final tag = PlatformDispatcher.instance.locale.toLanguageTag();
    return tag.length <= 20 ? tag : tag.substring(0, 20);
  }
}
