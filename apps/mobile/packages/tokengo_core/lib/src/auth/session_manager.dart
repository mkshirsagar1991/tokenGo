import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The signed-in state: the short-lived access token, the rotating refresh token and who we are.
@immutable
class StoredSession {
  const StoredSession({required this.accessToken, required this.refreshToken, required this.userId});

  final String accessToken;
  final String refreshToken;
  final String userId;

  StoredSession copyWith({String? accessToken, String? refreshToken}) =>
      StoredSession(accessToken: accessToken ?? this.accessToken, refreshToken: refreshToken ?? this.refreshToken, userId: userId);
}

/// Where the session is kept between app launches.
abstract class TokenStore {
  Future<StoredSession?> read();
  Future<void> write(StoredSession session);
  Future<void> clear();
}

/// Tokens live in the platform keystore (Android Keystore / iOS Keychain), never in plain preferences.
class SecureTokenStore implements TokenStore {
  SecureTokenStore({FlutterSecureStorage? storage}) : _s = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _s;
  static const _access = 'tokengo.access';
  static const _refresh = 'tokengo.refresh';
  static const _user = 'tokengo.user';

  @override
  Future<StoredSession?> read() async {
    final a = await _s.read(key: _access);
    final r = await _s.read(key: _refresh);
    final u = await _s.read(key: _user);
    if (a == null || r == null || u == null) return null;
    return StoredSession(accessToken: a, refreshToken: r, userId: u);
  }

  @override
  Future<void> write(StoredSession s) async {
    await _s.write(key: _access, value: s.accessToken);
    await _s.write(key: _refresh, value: s.refreshToken);
    await _s.write(key: _user, value: s.userId);
  }

  @override
  Future<void> clear() async {
    await _s.delete(key: _access);
    await _s.delete(key: _refresh);
    await _s.delete(key: _user);
  }
}

/// For tests and previews.
class MemoryTokenStore implements TokenStore {
  MemoryTokenStore([this._session]);
  StoredSession? _session;

  @override
  Future<StoredSession?> read() async => _session;
  @override
  Future<void> write(StoredSession session) async => _session = session;
  @override
  Future<void> clear() async => _session = null;
}

/// Owns the current session. Notifies listeners when the user signs in or out (the router listens to this).
///
/// Refresh tokens ROTATE and the server treats re-use as theft, so two requests that both find the access token
/// expired must not both refresh: [refreshOnce] makes concurrent callers share ONE refresh.
class SessionManager extends ChangeNotifier {
  SessionManager(this._store);

  final TokenStore _store;
  StoredSession? _current;
  bool _loaded = false;
  Future<bool>? _refreshing;

  StoredSession? get current => _current;
  bool get isSignedIn => _current != null;
  bool get isLoaded => _loaded;
  String? get accessToken => _current?.accessToken;
  String? get userId => _current?.userId;

  /// Reads the stored session at app start.
  Future<void> load() async {
    _current = await _store.read();
    _loaded = true;
    notifyListeners();
  }

  Future<void> signIn(StoredSession session) async {
    _current = session;
    await _store.write(session);
    notifyListeners();
  }

  Future<void> signOut() async {
    _current = null;
    await _store.clear();
    notifyListeners();
  }

  /// Runs [doRefresh] (which exchanges the refresh token for a new pair) at most once at a time.
  /// Returns true when a fresh session is now in place; false (and signs out) when it is not.
  Future<bool> refreshOnce(Future<StoredSession?> Function(String refreshToken) doRefresh) {
    final inFlight = _refreshing;
    if (inFlight != null) return inFlight;
    final started = _refreshing = () async {
      final refreshToken = _current?.refreshToken;
      if (refreshToken == null) return false;
      try {
        final next = await doRefresh(refreshToken);
        if (next == null) {
          await signOut();
          return false;
        }
        await signIn(next);
        return true;
      } catch (_) {
        // A network failure is not proof the session is bad: keep it, let the caller report the error.
        return false;
      }
    }();
    started.whenComplete(() => _refreshing = null);
    return started;
  }
}
