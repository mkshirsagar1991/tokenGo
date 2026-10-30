import '../auth/session_manager.dart';
import '../models/auth.dart';
import '../models/json_helpers.dart';
import '../net/api_client.dart';
import 'guard.dart';

/// Sign-in with a mobile OTP (requirements §5). The server throttles OTP requests per phone and per IP.
class AuthRepository {
  AuthRepository(this._api, this._sessions, {this._beforeSignOut});

  final ApiClient _api;
  final SessionManager _sessions;

  /// Runs while the person is still signed in, e.g. to take this phone off their push notifications.
  final Future<void> Function()? _beforeSignOut;

  /// Asks the server to send a one-time code. It always answers "sent": it never reveals whether a number is registered.
  Future<void> requestOtp(String phone, {String? deviceId}) async {
    await _api.post('/auth/otp/request', auth: false, body: {'phone': phone, 'device_id': ?deviceId});
  }

  /// Verifies the code and signs in. A new number becomes a new customer account.
  Future<void> verifyOtp(String phone, String code, {String? deviceId}) async {
    final json = await _api.post('/auth/otp/verify', auth: false, body: {'phone': phone, 'code': code, 'device_id': ?deviceId});
    final session = parseResponse(
      () => StoredSession(accessToken: json.s('access_token'), refreshToken: json.s('refresh_token'), userId: json.m('user').s('id')),
    );
    await _sessions.signIn(session);
  }

  Future<UserProfile> me() async {
    final json = await _api.get('/users/me');
    return parseResponse(() => UserProfile.fromJson(json.m('data')));
  }

  /// Ends this device's session on the server, then forgets it locally (even if the server cannot be reached).
  Future<void> signOut() async {
    try {
      await _beforeSignOut?.call();
    } catch (_) {
      // Signing out must always work, whatever happened to the push registration.
    }
    try {
      await _api.post('/auth/logout');
    } catch (_) {
      // The local sign-out below is what matters to the person; the server-side token expires on its own.
    }
    await _sessions.signOut();
  }
}
