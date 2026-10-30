import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:tokengo_customer/features/booking/booking_detail_screen.dart';

import 'support/harness.dart';

/// "Show arrival code": the server only issues a code from shortly before the appointment until it ends. The person must always be
/// told what is going on: here is the code, or it opens at HH:MM, or the appointment time has passed, or the phone cannot reach the server.
const _fixtures = '../packages/tokengo_core/test/fixtures/live';

Map<String, dynamic> _fixture(String name) => (jsonDecode(File('$_fixtures/$name.json').readAsStringSync()) as Map<String, dynamic>)['body'] as Map<String, dynamic>;

String _wallClock(DateTime utc) => utc.add(const Duration(hours: 5, minutes: 30)).toIso8601String().substring(0, 16); // IST, as the booking shows it

/// A CONFIRMED booking that starts at [start] (UTC).
Map<String, dynamic> _booking(DateTime start) {
  final body = jsonDecode(jsonEncode(_fixture('appointment'))) as Map<String, dynamic>;
  final b = body['data'] as Map<String, dynamic>;
  b['status'] = 'CONFIRMED';
  b['schedule'] = {
    'start_at': start.toIso8601String(),
    'end_at': start.add(const Duration(minutes: 45)).toIso8601String(),
    'local_start': _wallClock(start),
    'timezone': 'Asia/Kolkata',
  };
  return body;
}

Future<Widget> _app(Future<http.Response> Function(http.Request r, Map<String, dynamic> booking) handler, Map<String, dynamic> booking) async {
  final session = SessionManager(MemoryTokenStore(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'user-1')));
  await session.load();
  final id = (booking['data'] as Map<String, dynamic>)['id'] as String;
  final api = ApiClient(
    baseUrl: 'http://api.test/api/v1',
    sessions: session,
    httpClient: MockClient((r) async {
      final path = r.url.path.replaceFirst('/api/v1', '');
      if (path == '/appointments/$id') return jsonResponse(200, booking);
      if (path == '/appointments/$id/events') return jsonResponse(200, _fixture('appointment_events'));
      if (path == '/appointments/$id/arrival-code') return handler(r, booking);
      return jsonResponse(200, {
        'data': <Object>[],
        'meta': {'next_cursor': null},
      });
    }),
  );
  final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, _) => BookingDetailScreen(bookingId: id))]);
  return ProviderScope(
    retry: providerRetry, // exactly as the real app is set up
    overrides: [sessionManagerProvider.overrideWithValue(session), apiClientProvider.overrideWithValue(api)],
    child: MaterialApp.router(theme: TokenGoTheme.light(), routerConfig: router),
  );
}

Future<void> _openCode(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(800, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.tap(find.text('Show arrival code'));
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<http.Response> _problem(int status, String code, String detail, [Map<String, Object?> errors = const {}]) async =>
    jsonResponse(status, {'type': 'about:blank', 'title': 'ConflictError', 'status': status, 'code': code, 'detail': detail, 'errors': errors});

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('inside the check-in window the QR code and the PIN are shown', (tester) async {
    final start = DateTime.now().toUtc().add(const Duration(minutes: 10));
    final app = await _app((r, b) async {
      return jsonResponse(200, {
        'data': {
          'booking_id': (b['data'] as Map)['id'],
          'reference': 'TG-TEST1234',
          'pin': '481516',
          'qr': {'token': 'v1.payload.signature', 'expires_at': start.toIso8601String()},
        },
      });
    }, _booking(start));
    await _openCode(tester, app);

    expect(find.text('Show this at the salon'), findsOneWidget);
    expect(find.text('481516'), findsOneWidget);
    expect(find.textContaining('TG-TEST1234'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('too early: says WHEN the code opens, in the booking\'s own clock, not just "come back later"', (tester) async {
    final start = DateTime.now().toUtc().add(const Duration(days: 1, hours: 2)); // tomorrow
    final opens = start.subtract(const Duration(minutes: 30));
    final app = await _app((r, b) => _problem(409, 'OUTSIDE_CHECK_IN_WINDOW', 'Arrival can only be recorded shortly before and during the appointment', {'opens_at': opens.toIso8601String()}), _booking(start));
    await _openCode(tester, app);

    expect(find.text('Your code is not open yet'), findsOneWidget);
    expect(find.textContaining('30 min before it, at'), findsOneWidget);
    expect(find.textContaining(formatLocalTime(_wallClock(opens).substring(11, 16))), findsOneWidget, reason: 'the opening time, as a clock time');
    expect(find.text('This appointment time has passed'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an appointment that is already over says so (it must not tell people to "come back" to something that has ended)', (tester) async {
    final start = DateTime.now().toUtc().subtract(const Duration(days: 2));
    final opens = start.subtract(const Duration(minutes: 30));
    final app = await _app((r, b) => _problem(409, 'OUTSIDE_CHECK_IN_WINDOW', 'Arrival can only be recorded shortly before and during the appointment', {'opens_at': opens.toIso8601String()}), _booking(start));
    await _openCode(tester, app);

    expect(find.text('This appointment time has passed'), findsOneWidget);
    expect(find.text('Your code is not open yet'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('when the phone cannot reach the server it says so and offers to try again', (tester) async {
    final start = DateTime.now().toUtc().add(const Duration(minutes: 10));
    final app = await _app((r, b) async => throw http.ClientException('connection refused'), _booking(start));
    await _openCode(tester, app);
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 100)); // the two quick retries (0.4 s + 0.8 s) happen first, then the error and its button
    }

    expect(find.text('Try again'), findsOneWidget);
    expect(find.text('Your code is not open yet'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
