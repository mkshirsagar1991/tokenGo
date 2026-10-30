import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';

http.Response json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Future<(ApiClient, SessionManager)> clientWith(MockClientHandler handler, {StoredSession? session}) async {
  final sessions = SessionManager(MemoryTokenStore(session));
  await sessions.load();
  return (ApiClient(baseUrl: 'http://api.test/api/v1', sessions: sessions, httpClient: MockClient(handler)), sessions);
}

const signedIn = StoredSession(accessToken: 'old-access', refreshToken: 'old-refresh', userId: 'u1');

void main() {
  group('requests', () {
    test('builds the URL with the version prefix and drops null query parameters', () async {
      late Uri seen;
      final (api, _) = await clientWith((req) async {
        seen = req.url;
        return json(200, {'data': []});
      });
      await api.get('/search/providers', auth: false, query: {'lat': 18.5, 'lng': 73.8, 'category': null, 'open_now': true});
      expect(seen.path, '/api/v1/search/providers');
      expect(seen.queryParameters, {'lat': '18.5', 'lng': '73.8', 'open_now': 'true'});
    });

    test('sends the bearer token, JSON body and Idempotency-Key where given', () async {
      late http.Request seen;
      final (api, _) = await clientWith((req) async {
        seen = req;
        return json(201, {'data': {}});
      }, session: signedIn);
      await api.post('/appointments', body: {'a': 1}, idempotencyKey: 'key-12345678');
      expect(seen.headers['Authorization'], 'Bearer old-access');
      expect(seen.headers['Idempotency-Key'], 'key-12345678');
      expect(seen.headers['Content-Type'], contains('application/json'));
      expect(jsonDecode(seen.body), {'a': 1});
    });

    test('public calls carry no Authorization header even when signed in', () async {
      late http.Request seen;
      final (api, _) = await clientWith((req) async {
        seen = req;
        return json(200, {});
      }, session: signedIn);
      await api.get('/categories', auth: false);
      expect(seen.headers.containsKey('Authorization'), isFalse);
    });

    test('a 204 with no body is an empty object, not an error', () async {
      final (api, _) = await clientWith((req) async => http.Response('', 204), session: signedIn);
      expect(await api.post('/auth/logout'), isEmpty);
    });
  });

  group('errors', () {
    test('problem+json becomes an ApiException with the stable code, message and field errors', () async {
      final (api, _) = await clientWith(
        (req) async => json(422, {
          'type': 'urn:tokengo:problem:validation_failed',
          'title': 'Request validation failed',
          'status': 422,
          'code': 'VALIDATION_FAILED',
          'errors': {
            'fields': {
              'phone': ['must be a valid number'],
            },
          },
          'request_id': 'req-1',
        }),
      );
      await expectLater(
        api.post('/auth/otp/request', auth: false, body: {'phone': 'x'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 422)
              .having((e) => e.code, 'code', 'VALIDATION_FAILED')
              .having((e) => e.fields['phone'], 'phone', ['must be a valid number'])
              .having((e) => e.requestId, 'request id', 'req-1')
              .having((e) => e.isValidation, 'isValidation', true),
        ),
      );
    });

    test('details such as an INSUFFICIENT_FUNDS shortfall are preserved for the UI', () async {
      final (api, _) = await clientWith(
        (req) async => json(409, {
          'code': 'INSUFFICIENT_FUNDS',
          'title': 'Your available wallet balance is not enough for this booking',
          'status': 409,
          'errors': {
            'shortfall': {'amount_minor': 5000, 'currency': 'INR'},
          },
        }),
        session: signedIn,
      );
      try {
        await api.post('/appointments', body: {}, idempotencyKey: 'k-12345678');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.code, 'INSUFFICIENT_FUNDS');
        expect(Money.fromJson(e.details['shortfall'] as Map<String, dynamic>), const Money(5000));
      }
    });

    test('a non-JSON error body still yields a usable exception', () async {
      final (api, _) = await clientWith((req) async => http.Response('<html>Bad gateway</html>', 502));
      await expectLater(
        api.get('/x', auth: false),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 502)
              .having((e) => e.isServerError, 'server', true)
              .having((e) => e.userMessage, 'message', isNot(contains('<html>'))),
        ),
      );
    });

    test('a 200 with a malformed body is a bad response, not a crash', () async {
      final (api, _) = await clientWith((req) async => http.Response('not json', 200));
      await expectLater(
        api.get('/x', auth: false),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', ApiException.badResponseCode)),
      );
    });

    test('network failures and timeouts are reported as such (and never include a URL)', () async {
      final (offline, _) = await clientWith((req) async => throw http.ClientException('Connection refused', req.url));
      await expectLater(
        offline.get('/x', auth: false),
        throwsA(
          isA<ApiException>().having((e) => e.isNetwork, 'network', true).having((e) => e.userMessage, 'msg', isNot(contains('api.test'))),
        ),
      );

      final sessions = SessionManager(MemoryTokenStore());
      final slow = ApiClient(
        baseUrl: 'http://api.test/api/v1',
        sessions: sessions,
        timeout: const Duration(milliseconds: 50),
        httpClient: MockClient((req) => Completer<http.Response>().future),
      );
      await expectLater(slow.get('/x', auth: false), throwsA(isA<ApiException>().having((e) => e.code, 'code', ApiException.timeoutCode)));
    });
  });

  group('token refresh', () {
    test('an expired token is refreshed once and the SAME request is retried with the new token', () async {
      var refreshCalls = 0;
      final authHeaders = <String?>[];
      final (api, sessions) = await clientWith((req) async {
        if (req.url.path.endsWith('/auth/token/refresh')) {
          refreshCalls++;
          expect(jsonDecode(req.body), {'refresh_token': 'old-refresh'});
          return json(200, {'access_token': 'new-access', 'refresh_token': 'new-refresh'});
        }
        authHeaders.add(req.headers['Authorization']);
        return req.headers['Authorization'] == 'Bearer new-access'
            ? json(200, {
                'data': {'ok': true},
              })
            : json(401, {'code': 'UNAUTHENTICATED', 'status': 401});
      }, session: signedIn);

      final result = await api.get('/wallet');
      expect(result['data'], {'ok': true});
      expect(refreshCalls, 1);
      expect(authHeaders, ['Bearer old-access', 'Bearer new-access']);
      expect(sessions.current?.refreshToken, 'new-refresh'); // rotated and stored
      expect(sessions.userId, 'u1'); // identity kept
    });

    test(
      'several simultaneous requests that all find the token expired trigger exactly ONE refresh (tokens rotate; re-use is theft)',
      () async {
        var refreshCalls = 0;
        final (api, _) = await clientWith((req) async {
          if (req.url.path.endsWith('/auth/token/refresh')) {
            refreshCalls++;
            await Future<void>.delayed(const Duration(milliseconds: 30));
            return json(200, {'access_token': 'new-access', 'refresh_token': 'new-refresh'});
          }
          return req.headers['Authorization'] == 'Bearer new-access'
              ? json(200, {'data': {}})
              : json(401, {'code': 'UNAUTHENTICATED', 'status': 401});
        }, session: signedIn);

        final results = await Future.wait([
          api.get('/wallet'),
          api.get('/appointments'),
          api.get('/users/me'),
          api.get('/wallet/transactions'),
        ]);
        expect(results, hasLength(4));
        expect(refreshCalls, 1);
      },
    );

    test('a request that only receives its 401 AFTER another request refreshed just retries with the new token', () async {
      var refreshCalls = 0;
      final (api, sessions) = await clientWith((req) async {
        if (req.url.path.endsWith('/auth/token/refresh')) {
          refreshCalls++;
          return json(200, {'access_token': 'new-access', 'refresh_token': 'new-refresh'});
        }
        if (req.url.path.endsWith('/slow')) {
          await Future<void>.delayed(const Duration(milliseconds: 80));
          return req.headers['Authorization'] == 'Bearer new-access' ? json(200, {'data': {}}) : json(401, {'status': 401});
        }
        return req.headers['Authorization'] == 'Bearer new-access' ? json(200, {'data': {}}) : json(401, {'status': 401});
      }, session: signedIn);

      final slow = api.get('/slow'); // already on the wire with the OLD token
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await api.get('/fast'); // refreshes
      await slow; // gets its 401 later; must not refresh again
      expect(refreshCalls, 1);
      expect(sessions.current?.accessToken, 'new-access');
    });

    test('when the refresh token is rejected the session ends (signed out) and the caller sees 401', () async {
      final (api, sessions) = await clientWith((req) async {
        if (req.url.path.endsWith('/auth/token/refresh')) return json(401, {'code': 'REFRESH_TOKEN_INVALID', 'status': 401});
        return json(401, {'code': 'UNAUTHENTICATED', 'status': 401});
      }, session: signedIn);

      await expectLater(api.get('/wallet'), throwsA(isA<ApiException>().having((e) => e.isUnauthenticated, '401', true)));
      expect(sessions.isSignedIn, isFalse);
    });

    test('a network failure DURING refresh does not sign the person out', () async {
      final (api, sessions) = await clientWith((req) async {
        if (req.url.path.endsWith('/auth/token/refresh')) throw http.ClientException('offline', req.url);
        return json(401, {'status': 401});
      }, session: signedIn);

      await expectLater(api.get('/wallet'), throwsA(isA<ApiException>()));
      expect(sessions.isSignedIn, isTrue);
    });

    test('public endpoints never trigger a refresh', () async {
      var refreshCalls = 0;
      final (api, _) = await clientWith((req) async {
        if (req.url.path.endsWith('/auth/token/refresh')) refreshCalls++;
        return json(401, {'status': 401});
      }, session: signedIn);
      await expectLater(api.post('/auth/otp/verify', auth: false, body: {}), throwsA(isA<ApiException>()));
      expect(refreshCalls, 0);
    });
  });

  group('SessionManager', () {
    test('signIn persists and notifies; signOut clears', () async {
      final store = MemoryTokenStore();
      final sessions = SessionManager(store);
      var notified = 0;
      sessions.addListener(() => notified++);
      await sessions.signIn(signedIn);
      expect(await store.read(), isNotNull);
      await sessions.signOut();
      expect(await store.read(), isNull);
      expect(sessions.isSignedIn, isFalse);
      expect(notified, 2);
    });

    test('load restores a stored session', () async {
      final sessions = SessionManager(MemoryTokenStore(signedIn));
      expect(sessions.isLoaded, isFalse);
      await sessions.load();
      expect(sessions.isLoaded, isTrue);
      expect(sessions.accessToken, 'old-access');
    });
  });
}
