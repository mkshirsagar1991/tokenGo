import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';

/// A stand-in for Firebase: the test decides what arrives and when.
class FakePush implements PushService {
  FakePush({this.available = true, this.currentToken = 'tok-1', this.initial});

  bool available;
  String? currentToken;
  PushMessage? initial;
  int starts = 0;
  bool tokenDeleted = false;
  final _foreground = StreamController<PushMessage>.broadcast();
  final _opened = StreamController<PushMessage>.broadcast();
  final _tokens = StreamController<String>.broadcast();

  void arrive(PushMessage m) => _foreground.add(m);
  void tap(PushMessage m) => _opened.add(m);
  void refreshToken(String t) {
    currentToken = t;
    _tokens.add(t);
  }

  @override
  Future<bool> start() async {
    starts++;
    return available;
  }

  @override
  Future<String?> token() async => available ? currentToken : null;
  @override
  Stream<String> get tokenRefreshed => _tokens.stream;
  @override
  Stream<PushMessage> get foreground => _foreground.stream;
  @override
  Stream<PushMessage> get opened => _opened.stream;
  @override
  Future<PushMessage?> initialMessage() async {
    final m = initial;
    initial = null; // handed out once, like the real thing
    return m;
  }

  @override
  Future<void> deleteToken() async => tokenDeleted = true;
}

const _booking = PushMessage(
  title: 'Booking confirmed',
  body: 'Haircut · Thu, 8 Oct · 10:00 AM',
  data: {'booking_id': 'b-1', 'kind': 'BOOKING_CONFIRMED', 'notification_id': 'n-1'},
);

class _Harness {
  _Harness({required this.push, this.app = BrandApp.customer, this.signedIn = true});

  final FakePush push;
  final BrandApp app;
  final bool signedIn;
  final calls = <({String method, String path, Map<String, dynamic>? body})>[];
  final refreshed = <PushMessage?>[];
  final opened = <PushMessage>[];
  late final SessionManager session;
  late final ProviderContainer container;

  Future<Widget> build() async {
    session = SessionManager(MemoryTokenStore(signedIn ? const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'user-1') : null));
    await session.load();
    final api = ApiClient(
      baseUrl: 'http://api.test/api/v1',
      sessions: session,
      httpClient: MockClient((r) async {
        calls.add((method: r.method, path: r.url.path.replaceFirst('/api/v1', ''), body: r.body.isEmpty ? null : jsonDecode(r.body) as Map<String, dynamic>));
        return http.Response(jsonEncode({'data': {}}), 200, headers: {'content-type': 'application/json'});
      }),
    );
    return ProviderScope(
      overrides: [
        sessionManagerProvider.overrideWithValue(session),
        apiClientProvider.overrideWithValue(api),
        pushServiceProvider.overrideWithValue(push),
        brandAppProvider.overrideWithValue(app),
      ],
      child: MaterialApp(
        builder: (context, child) => PushListener(
          onRefresh: (ref, m) => refreshed.add(m),
          onOpen: (ref, m) => opened.add(m),
          child: child!,
        ),
        home: const Scaffold(body: Center(child: Text('home'))),
      ),
    );
  }

  List<String> get paths => [for (final c in calls) '${c.method} ${c.path}'];
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  group('registering this phone', () {
    testWidgets('a signed-in customer app sends its push address to the server', (tester) async {
      final h = _Harness(push: FakePush());
      await tester.pumpWidget(await h.build());
      await settle(tester);

      expect(h.paths, ['POST /devices']);
      expect(h.calls.single.body, containsPair('app', 'CUSTOMER'));
      expect(h.calls.single.body, containsPair('platform', 'ANDROID'));
      expect(h.calls.single.body, containsPair('token', 'tok-1'));
    });

    testWidgets('the business app registers as PROVIDER', (tester) async {
      final h = _Harness(push: FakePush(), app: BrandApp.business);
      await tester.pumpWidget(await h.build());
      await settle(tester);
      expect(h.calls.single.body, containsPair('app', 'PROVIDER'));
    });

    testWidgets('nobody signed in: nothing is registered and nothing is started', (tester) async {
      final h = _Harness(push: FakePush(), signedIn: false);
      await tester.pumpWidget(await h.build());
      await settle(tester);
      expect(h.calls, isEmpty);
      expect(h.push.starts, 0);
    });

    testWidgets('signing in on a phone that is already open registers it then', (tester) async {
      final h = _Harness(push: FakePush(), signedIn: false);
      await tester.pumpWidget(await h.build());
      await settle(tester);
      expect(h.calls, isEmpty);

      await h.session.signIn(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'user-2'));
      await settle(tester);
      expect(h.paths, ['POST /devices']);
    });

    testWidgets('a refreshed push address is sent again', (tester) async {
      final h = _Harness(push: FakePush());
      await tester.pumpWidget(await h.build());
      await settle(tester);
      h.push.refreshToken('tok-2');
      await settle(tester);

      expect(h.calls.map((c) => c.body?['token']), ['tok-1', 'tok-2']);
    });

    testWidgets('a phone with no push (no Firebase, no permission) just works without it', (tester) async {
      final h = _Harness(push: FakePush(available: false));
      await tester.pumpWidget(await h.build());
      await settle(tester);

      expect(h.calls, isEmpty);
      expect(find.text('home'), findsOneWidget);
    });
  });

  group('auto-refresh', () {
    testWidgets('a notification while the app is open refreshes the screen and shows a banner with View', (tester) async {
      final h = _Harness(push: FakePush());
      await tester.pumpWidget(await h.build());
      await settle(tester);

      h.push.arrive(_booking);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1000)); // the banner slides in

      expect(h.refreshed, [_booking], reason: 'the screen is refreshed without the person doing anything');
      expect(find.text('Booking confirmed'), findsOneWidget);
      expect(find.text('View'), findsOneWidget);

      tester.widget<SnackBarAction>(find.byType(SnackBarAction)).onPressed(); // what pressing View does
      await tester.pump();
      expect(h.opened, [_booking]);
    });

    testWidgets('tapping a notification in the tray refreshes and opens its screen', (tester) async {
      final h = _Harness(push: FakePush());
      await tester.pumpWidget(await h.build());
      await settle(tester);

      h.push.tap(_booking);
      await tester.pump();

      expect(h.refreshed, [_booking]);
      expect(h.opened, [_booking]);
    });

    testWidgets('the notification that started the app from closed is opened once', (tester) async {
      final h = _Harness(push: FakePush(initial: _booking));
      await tester.pumpWidget(await h.build());
      await settle(tester);

      expect(h.opened, [_booking]);
      expect(h.refreshed, [_booking]);
    });

    testWidgets('coming back to the app refreshes it (a notification may have been missed)', (tester) async {
      final h = _Harness(push: FakePush());
      await tester.pumpWidget(await h.build());
      await settle(tester);
      h.refreshed.clear();

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      expect(h.refreshed, [null]);
    });

    testWidgets('a notification for someone who is signed out is ignored', (tester) async {
      final h = _Harness(push: FakePush(), signedIn: false);
      await tester.pumpWidget(await h.build());
      await settle(tester);

      h.push.arrive(_booking);
      await tester.pump();
      expect(h.refreshed, isEmpty);
      expect(find.text('Booking confirmed'), findsNothing);
    });
  });

  group('signing out', () {
    test('takes this phone off the account BEFORE the session ends, and forgets the push address', () async {
      final h = _Harness(push: FakePush());
      await h.build();
      final container = ProviderContainer(
        overrides: [
          sessionManagerProvider.overrideWithValue(h.session),
          apiClientProvider.overrideWithValue(
            ApiClient(
              baseUrl: 'http://api.test/api/v1',
              sessions: h.session,
              httpClient: MockClient((r) async {
                h.calls.add((method: r.method, path: r.url.path.replaceFirst('/api/v1', ''), body: r.body.isEmpty ? null : jsonDecode(r.body) as Map<String, dynamic>));
                return http.Response(jsonEncode({'data': {}}), 200, headers: {'content-type': 'application/json'});
              }),
            ),
          ),
          pushServiceProvider.overrideWithValue(h.push),
        ],
      );
      addTearDown(container.dispose);

      await container.read(authRepositoryProvider).signOut();

      expect(h.paths, ['POST /devices/unregister', 'POST /auth/logout']);
      expect(h.calls.first.body, {'token': 'tok-1'});
      expect(h.push.tokenDeleted, isTrue);
      expect(h.session.userId, isNull);
    });

    test('still signs out when the server cannot be told about the phone', () async {
      final push = FakePush();
      final session = SessionManager(MemoryTokenStore(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'user-1')));
      await session.load();
      final container = ProviderContainer(
        overrides: [
          sessionManagerProvider.overrideWithValue(session),
          apiClientProvider.overrideWithValue(
            ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient((r) async => throw http.ClientException('offline'))),
          ),
          pushServiceProvider.overrideWithValue(push),
        ],
      );
      addTearDown(container.dispose);

      await container.read(authRepositoryProvider).signOut();
      expect(session.userId, isNull);
    });
  });
}
