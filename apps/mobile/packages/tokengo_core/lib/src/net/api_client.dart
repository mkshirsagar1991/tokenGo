import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../auth/session_manager.dart';
import 'api_exception.dart';

typedef Json = Map<String, dynamic>;

/// The one place that talks HTTP to the TokenGo API.
///
///  * adds the bearer token, and on a 401 refreshes it ONCE (shared by concurrent requests) and retries;
///  * turns every failure into an [ApiException] (network, timeout, problem+json, malformed body);
///  * sends `Idempotency-Key` where the caller supplies one (money and booking commands must never run twice).
class ApiClient {
  ApiClient({
    required String baseUrl,
    required this.sessions,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 20),
    this.userAgent = 'TokenGo-Mobile/1.0',
  }) : _base = Uri.parse(baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl),
       _http = httpClient ?? http.Client();

  final SessionManager sessions;
  final Duration timeout;
  final String userAgent;
  final Uri _base;
  final http.Client _http;

  Future<Json> get(String path, {Map<String, Object?>? query, bool auth = true}) => _send('GET', path, query: query, auth: auth);

  Future<Json> post(String path, {Object? body, String? idempotencyKey, bool auth = true}) =>
      _send('POST', path, body: body, idempotencyKey: idempotencyKey, auth: auth);

  Future<Json> put(String path, {Object? body, bool auth = true}) => _send('PUT', path, body: body, auth: auth);

  Future<Json> patch(String path, {Object? body, bool auth = true}) => _send('PATCH', path, body: body, auth: auth);

  Future<Json> delete(String path, {bool auth = true}) => _send('DELETE', path, auth: auth);

  void close() => _http.close();

  Uri _uri(String path, Map<String, Object?>? query) {
    final params = <String, String>{};
    query?.forEach((k, v) {
      if (v != null) params[k] = '$v';
    });
    return _base.replace(path: '${_base.path}$path', queryParameters: params.isEmpty ? null : params);
  }

  Future<Json> _send(
    String method,
    String path, {
    Map<String, Object?>? query,
    Object? body,
    String? idempotencyKey,
    required bool auth,
  }) async {
    final usedToken = sessions.accessToken;
    var response = await _once(method, path, query, body, idempotencyKey, auth);
    if (response.statusCode == 401 && auth && sessions.isSignedIn) {
      // The access token (15 min) probably expired. If another request already refreshed it while this one was in
      // flight, just retry with the new token; otherwise refresh ONCE (shared with concurrent requests) and retry.
      final alreadyRefreshed = sessions.accessToken != null && sessions.accessToken != usedToken;
      final ok = alreadyRefreshed || await sessions.refreshOnce(_exchangeRefreshToken);
      if (ok) response = await _once(method, path, query, body, idempotencyKey, auth);
    }
    return _decode(response);
  }

  Future<http.Response> _once(
    String method,
    String path,
    Map<String, Object?>? query,
    Object? body,
    String? idempotencyKey,
    bool auth,
  ) async {
    final request = http.Request(method, _uri(path, query))
      ..headers['Accept'] = 'application/json'
      ..headers['User-Agent'] = userAgent;
    final token = sessions.accessToken;
    if (auth && token != null) request.headers['Authorization'] = 'Bearer $token';
    if (idempotencyKey != null) request.headers['Idempotency-Key'] = idempotencyKey;
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    try {
      final streamed = await _http.send(request).timeout(timeout);
      return await http.Response.fromStream(streamed).timeout(timeout);
    } on TimeoutException {
      throw ApiException.timeout();
    } on http.ClientException catch (e) {
      throw ApiException.network(e.message);
    } on FormatException {
      throw ApiException.network();
    } catch (e) {
      // SocketException / HandshakeException etc. (dart:io is not imported so the package also works on web).
      throw ApiException.network();
    }
  }

  Json _decode(http.Response r) {
    final text = utf8.decode(r.bodyBytes, allowMalformed: true);
    dynamic decoded;
    if (text.isNotEmpty) {
      try {
        decoded = jsonDecode(text);
      } on FormatException {
        if (r.statusCode >= 200 && r.statusCode < 300) throw ApiException.badResponse(r.statusCode);
      }
    }
    if (r.statusCode >= 200 && r.statusCode < 300) {
      if (decoded == null) return <String, dynamic>{};
      if (decoded is Map<String, dynamic>) return decoded;
      throw ApiException.badResponse(r.statusCode);
    }
    throw ApiException.fromProblem(r.statusCode, decoded is Map<String, dynamic> ? decoded : <String, dynamic>{});
  }

  /// Exchanges a refresh token for a new pair WITHOUT going through the 401-retry path (that would loop).
  Future<StoredSession?> _exchangeRefreshToken(String refreshToken) async {
    final response = await _once('POST', '/auth/token/refresh', null, {'refresh_token': refreshToken}, null, false);
    if (response.statusCode == 401 || response.statusCode == 403) return null; // refresh token revoked/expired: the session is over
    final json = _decode(response);
    final current = sessions.current;
    return StoredSession(
      accessToken: json['access_token'] as String,
      refreshToken: json['refresh_token'] as String,
      userId: current?.userId ?? '',
    );
  }
}
