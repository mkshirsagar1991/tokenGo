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
import 'package:tokengo_customer/core/router.dart';
import 'package:tokengo_customer/features/booking/booking_flow_screen.dart';

import 'support/harness.dart';

/// Booking several services in one visit: a haircut + shaving + a facial, a car wash + a tyre change.
/// The salon is a real recorded profile (ABC Salon: Facial ₹300, Hair Coloring ₹500, Haircut ₹200, Shaving ₹100).
const _fixtures = '../packages/tokengo_core/test/fixtures/live';
const _loc = '01a114b7-67bf-77a3-8397-24ae0a6ae8e5';
const _facial = '01a114b7-6896-79a8-ad72-082541d7f426';
const _haircut = '01a114b7-682e-7a20-a5bc-98c0f24e64b0';
const _shaving = '01a114b7-6851-76e5-af06-4e951ca22b88';

Map<String, dynamic> _fixture(String name) => (jsonDecode(File('$_fixtures/$name.json').readAsStringSync()) as Map<String, dynamic>)['body'] as Map<String, dynamic>;

/// A fake server: the salon profile, slots for WHATEVER services are asked for (priced and timed from the profile), the wallet, and
/// bookings. Records every request so the tests can check exactly what the app sent.
class _FakeServer {
  _FakeServer({this.walletRupees = 1000});

  final int walletRupees;
  final requests = <http.Request>[];
  late final Map<String, dynamic> profile = _fixture('location_profile');
  List<Map<String, dynamic>> get _services => ((profile['data'] as Map<String, dynamic>)['services'] as List).cast<Map<String, dynamic>>();

  Future<http.Response> handle(http.Request r) async {
    requests.add(r);
    final path = r.url.path.replaceFirst('/api/v1', '');
    if (path == '/locations/$_loc') return jsonResponse(200, profile);
    if (path == '/availability/slots') {
      final ids = r.url.queryParameters['service_ids']!.split(',');
      final chosen = _services.where((s) => ids.contains(s['id'])).toList();
      final minutes = chosen.fold<int>(0, (m, s) => m + (s['duration_min'] as int));
      final price = chosen.fold<int>(0, (m, s) => m + ((s['price'] as Map)['amount_minor'] as int));
      return jsonResponse(200, {
        'data': {
          'location_id': _loc,
          'timezone': 'Asia/Kolkata',
          'service': {'id': ids.first, 'name': chosen.map((s) => s['name']).join(' + '), 'duration_min': minutes},
          'services': [
            for (final s in chosen) {'id': s['id'], 'name': s['name'], 'duration_min': s['duration_min'], 'price': s['price']},
          ],
          'total': {'duration_min': minutes, 'price': {'amount_minor': price, 'currency': 'INR'}},
          'slots': [
            {
              'start_at': '2026-10-13T04:30:00.000Z',
              'end_at': '2026-10-13T05:45:00.000Z',
              'local_start': '2026-10-13T10:00',
              'resources': [
                {'id': 'res-1', 'display_name': 'Riya'},
              ],
            },
          ],
        },
        'meta': {'advisory': true},
      });
    }
    if (path == '/wallet') {
      return jsonResponse(200, {
        'data': {
          'available': {'amount_minor': walletRupees * 100, 'currency': 'INR'},
          'held': {'amount_minor': 0, 'currency': 'INR'},
        },
      });
    }
    if (path == '/appointments' && r.method == 'POST') return jsonResponse(201, _fixture('appointment'));
    if (path == '/auth/otp/request') return jsonResponse(200, {'status': 'sent'});
    if (path == '/auth/otp/verify') {
      return jsonResponse(200, {
        'access_token': 'access-1',
        'refresh_token': 'refresh-1',
        'user': {'id': 'user-1'},
      });
    }
    return jsonResponse(200, {
      'data': <Object>[],
      'meta': {'next_cursor': null},
    });
  }

  http.Request? last(String path) => requests.where((r) => r.url.path.endsWith(path)).lastOrNull;
}

/// The booking screen on its own, signed in, with just enough routing to follow a finished booking.
Future<Widget> _flowApp(_FakeServer server, List<String> initial) async {
  final session = SessionManager(MemoryTokenStore(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'user-1')));
  await session.load();
  final api = ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient(server.handle));
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => BookingFlowScreen(locationId: _loc, initialServiceIds: initial)),
      GoRoute(path: '/bookings/:id', builder: (_, s) => Scaffold(body: Center(child: Text('booked ${s.pathParameters['id']}')))),
      GoRoute(path: '/add-money', builder: (_, _) => const Scaffold(body: Center(child: Text('add money')))),
    ],
  );
  return ProviderScope(
    overrides: [sessionManagerProvider.overrideWithValue(session), apiClientProvider.overrideWithValue(api)],
    child: MaterialApp.router(theme: TokenGoTheme.light(), routerConfig: router),
  );
}

/// A tall phone, so the whole page is built (lists build lazily, only what is on screen).
void tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(800, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the salon page: tick one or more services', () {
    testWidgets('each tick adds to the running total and the button says how many; untick takes it away', (tester) async {
      tallSurface(tester);
      final server = _FakeServer();
      await tester.pumpWidget(await routedApp(handler: server.handle));
      await tester.pump(const Duration(milliseconds: 300));
      ProviderScope.containerOf(tester.element(find.byType(MaterialApp))).read(routerProvider).go('/provider/$_loc');
      await settle(tester);

      expect(find.text('Book an appointment'), findsOneWidget, reason: 'nothing ticked yet');
      expect(find.text('Tick one or more. They are done together in one visit.'), findsOneWidget);

      await tester.tap(find.text('Haircut'));
      await tester.pump();
      expect(find.text('Book Haircut'), findsOneWidget);

      await tester.tap(find.text('Hair Coloring'));
      await tester.pump();
      expect(find.text('Book 2 services'), findsOneWidget);
      expect(find.text('2 selected · about 1 h 30 min'), findsOneWidget);
      expect(find.text('₹700'), findsOneWidget, reason: '₹200 + ₹500');

      await tester.tap(find.text('Hair Coloring'));
      await tester.pump();
      expect(find.text('Book Haircut'), findsOneWidget);
    });

    testWidgets('the button opens the booking screen with exactly those services ticked, and asks for slots for the whole visit', (tester) async {
      tallSurface(tester);
      final server = _FakeServer();
      await tester.pumpWidget(await routedApp(handler: server.handle));
      await tester.pump(const Duration(milliseconds: 300));
      ProviderScope.containerOf(tester.element(find.byType(MaterialApp))).read(routerProvider).go('/provider/$_loc');
      await settle(tester);

      await tester.tap(find.text('Haircut'));
      await tester.tap(find.text('Shaving'));
      await tester.pump();
      await tester.tap(find.text('Book 2 services'));
      await settle(tester);

      expect(find.text('1 · Choose services'), findsOneWidget);
      expect(find.byIcon(Icons.check_box_rounded), findsNWidgets(2));
      final ask = server.last('/availability/slots')!;
      expect(ask.url.queryParameters['service_ids']!.split(',').toSet(), {_haircut, _shaving});
    });
  });

  group('the booking screen: several services, one visit', () {
    testWidgets('shows the total price and time, books ALL of them in the order ticked, and follows the new booking', (tester) async {
      tallSurface(tester);
      final server = _FakeServer();
      await tester.pumpWidget(await _flowApp(server, [_shaving, _haircut, _facial]));
      await settle(tester);

      expect(find.byIcon(Icons.check_box_rounded), findsNWidgets(3));
      expect(find.textContaining('3 services · 1 h 35 min'), findsOneWidget, reason: '20 + 30 + 45 minutes, as the server worked it out');
      expect(find.text('₹600'), findsWidgets, reason: '₹100 + ₹200 + ₹300');

      await tester.tap(find.text('13'));
      await tester.pump();
      await tester.tap(find.textContaining('10:00'));
      await tester.pump();
      expect(find.textContaining('Shaving + Haircut + Facial'), findsOneWidget);
      expect(find.textContaining('₹600 is held from your wallet'), findsOneWidget);

      await tester.tap(find.text('Request booking'));
      await settle(tester);

      final post = server.last('/appointments')!;
      final body = jsonDecode(post.body) as Map<String, dynamic>;
      expect(body['service_ids'], [_shaving, _haircut, _facial]);
      expect(body.keys, isNot(contains('service_id')), reason: 'the old single-service field is gone');
      expect(body.keys.toSet().intersection({'price', 'total', 'amount', 'status'}), isEmpty, reason: 'the app never sends money or status');
      expect(find.textContaining('booked'), findsOneWidget);
    });

    testWidgets('ticking and unticking changes the visit (slots are asked again), and nothing is booked until a time is chosen', (tester) async {
      tallSurface(tester);
      final server = _FakeServer();
      await tester.pumpWidget(await _flowApp(server, [_haircut]));
      await settle(tester);
      expect(server.last('/availability/slots')!.url.queryParameters['service_ids'], _haircut);

      await tester.tap(find.text('Shaving'));
      await settle(tester);
      expect(server.last('/availability/slots')!.url.queryParameters['service_ids']!.split(',').toSet(), {_haircut, _shaving});
      expect(find.text('Request booking'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byType(FilledButton).last).onPressed, isNull, reason: 'no time chosen yet');
    });

    testWidgets('not enough money for the TOTAL (not just one service) offers to add money and says how much more', (tester) async {
      tallSurface(tester);
      final server = _FakeServer(walletRupees: 450); // enough for the facial (₹300) alone, not for facial + haircut + shaving (₹600)
      await tester.pumpWidget(await _flowApp(server, [_facial, _haircut, _shaving]));
      await settle(tester);
      await tester.tap(find.text('13'));
      await tester.pump();
      await tester.tap(find.textContaining('10:00'));
      await tester.pump();

      expect(find.textContaining('you need ₹150 more'), findsOneWidget);
      expect(find.text('Add money to your wallet'), findsOneWidget);
    });
  });

  group('signing in in the middle of a booking', () {
    testWidgets('keeps the services, day, time and note the person had already chosen', (tester) async {
      tallSurface(tester);
      final server = _FakeServer();
      await tester.pumpWidget(await routedApp(handler: server.handle)); // signed OUT
      await tester.pump(const Duration(milliseconds: 300));
      ProviderScope.containerOf(tester.element(find.byType(MaterialApp))).read(routerProvider).go('/provider/$_loc');
      await settle(tester);

      await tester.tap(find.text('Haircut'));
      await tester.tap(find.text('Shaving'));
      await tester.pump();
      await tester.tap(find.text('Book 2 services'));
      await settle(tester);
      await tester.tap(find.text('13'));
      await tester.pump();
      await tester.tap(find.textContaining('10:00'));
      await tester.pump();
      await tester.enterText(find.widgetWithText(TextField, 'Note for the salon (optional)'), 'Please use a clean towel');
      await tester.pump();
      final slotCalls = server.requests.where((r) => r.url.path.endsWith('/availability/slots')).length;

      // Confirming needs an account: sign in through the real code screens.
      await tester.tap(find.text('Sign in to book'));
      await settle(tester);
      await tester.enterText(find.byType(TextField), '9000000021');
      await tester.pump();
      await tester.tap(find.text('Send code'));
      await settle(tester);
      expect(find.text('Enter the code'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '123456');
      await settle(tester);

      expect(find.text('Enter the code'), findsNothing);
      expect(find.text('1 · Choose services'), findsOneWidget, reason: 'back on the booking screen, not sent home or to the salon page');
      expect(find.byIcon(Icons.check_box_rounded), findsNWidgets(2), reason: 'both services are still ticked');
      expect(find.text('Please use a clean towel'), findsOneWidget, reason: 'the note is still there');
      expect(find.textContaining('Haircut + Shaving'), findsOneWidget, reason: 'the summary still names the chosen time');
      expect(find.text('Request booking'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Request booking')).onPressed, isNotNull, reason: 'one tap books it');
      expect(
        server.requests.where((r) => r.url.path.endsWith('/availability/slots')).length,
        slotCalls,
        reason: 'the screen was not rebuilt, so the slots were not asked for again',
      );
      expect(server.requests.where((r) => r.url.path.endsWith('/appointments')), isEmpty, reason: 'signing in alone books nothing');
    });
  });
}
