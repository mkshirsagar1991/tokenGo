import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';

const _channel = MethodChannel(WhatsAppOtpAutofill.channelName);

/// Everything that happened, native calls and HTTP calls together, in order.
final _timeline = <String>[];

/// Stands in for the Android code: records the calls, answers as the test says, and can announce a code like the real receiver does.
class _FakeNative {
  final calls = <String>[];
  bool handshake = true;
  String? pending;
  Object? failWith;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, (call) async {
      calls.add(call.method);
      _timeline.add('native:${call.method}');
      if (failWith != null) throw failWith!;
      switch (call.method) {
        case 'startHandshake':
          return handshake;
        case 'takePendingCode':
          final code = pending;
          pending = null; // handed out once, like the real thing
          return code;
      }
      return null;
    });
  }

  void remove() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, null);

  /// What WhatsAppOtpChannel does when a code has arrived.
  Future<void> announceCode() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(
    WhatsAppOtpAutofill.channelName,
    const StandardMethodCodec().encodeMethodCall(const MethodCall('codeAvailable')),
    (_) {},
  );
}

/// The person goes to WhatsApp and comes back (Android reports each step, in this order).
void leaveAndComeBack(WidgetTester tester) {
  for (final state in [
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
    AppLifecycleState.hidden,
    AppLifecycleState.inactive,
    AppLifecycleState.resumed,
  ]) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _FakeNative native;

  setUp(() {
    native = _FakeNative()..install();
    _timeline.clear();
  });
  tearDown(() {
    native.remove();
    debugDefaultTargetPlatformOverride = null;
  });

  group('WhatsAppOtpAutofill', () {
    test('startHandshake reports whether WhatsApp was told we are waiting', () async {
      final service = WhatsAppOtpAutofill();
      addTearDown(service.dispose);
      expect(await service.startHandshake(), isTrue);
      native.handshake = false; // WhatsApp missing or too old
      expect(await service.startHandshake(), isFalse);
      expect(native.calls, ['startHandshake', 'startHandshake']);
    });

    test('never throws: a native failure or a missing native side just means "no autofill"', () async {
      final service = WhatsAppOtpAutofill();
      addTearDown(service.dispose);
      native.failWith = PlatformException(code: 'boom');
      expect(await service.startHandshake(), isFalse);
      expect(await service.takePendingCode(), isNull);

      native.remove(); // no handler at all: MissingPluginException, as in a plain widget test
      expect(await service.startHandshake(), isFalse);
      expect(await service.takePendingCode(), isNull);
    });

    test('a native call that never answers is cut off, so signing in is never held up', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, (_) => Completer<Object?>().future);
      final service = WhatsAppOtpAutofill(timeout: const Duration(milliseconds: 50));
      addTearDown(service.dispose);
      expect(await service.startHandshake(), isFalse);
      expect(await service.takePendingCode(), isNull);
    });

    test('the disabled service never touches the native side', () async {
      final service = WhatsAppOtpAutofill.disabled();
      addTearDown(service.dispose);
      native.pending = '482916';
      expect(await service.startHandshake(), isFalse);
      expect(await service.takePendingCode(), isNull);
      expect(native.calls, isEmpty);
    });

    test('takePendingCode hands a 6-digit code out once and refuses anything else', () async {
      final service = WhatsAppOtpAutofill();
      addTearDown(service.dispose);
      native.pending = '482916';
      expect(await service.takePendingCode(), '482916');
      expect(await service.takePendingCode(), isNull);

      for (final bad in ['12345', '1234567', 'abcdef', '12 456', '']) {
        native.pending = bad;
        expect(await service.takePendingCode(), isNull, reason: '"$bad" is not a login code');
      }
    });

    test('codeAvailable fires when the native side announces a code', () async {
      final service = WhatsAppOtpAutofill();
      addTearDown(service.dispose);
      var fired = 0;
      final sub = service.codeAvailable.listen((_) => fired++);
      addTearDown(sub.cancel);
      await native.announceCode();
      await Future<void>.delayed(Duration.zero);
      expect(fired, 1);
    });

    test('off Android nothing is called at all (iPhone has no WhatsApp autofill)', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final service = WhatsAppOtpAutofill();
      addTearDown(service.dispose);
      native.pending = '482916';
      expect(await service.startHandshake(), isFalse);
      expect(await service.takePendingCode(), isNull);
      expect(native.calls, isEmpty);
    });
  });

  group('OtpScreen with WhatsApp autofill', () {
    late List<String> calls;
    late List<Map<String, dynamic>> verifyBodies;
    late bool signedIn;

    Future<Widget> screen() async {
      calls = [];
      verifyBodies = [];
      signedIn = false;
      final session = SessionManager(MemoryTokenStore());
      await session.load();
      final api = ApiClient(
        baseUrl: 'http://api.test/api/v1',
        sessions: session,
        httpClient: MockClient((r) async {
          calls.add('${r.method} ${r.url.path}');
          _timeline.add('http:${r.url.path}');
          if (r.url.path.endsWith('/auth/otp/verify')) {
            verifyBodies.add(jsonDecode(r.body) as Map<String, dynamic>);
            return http.Response(
              jsonEncode({'access_token': 'a', 'refresh_token': 'r', 'user': {'id': 'user-1'}}),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(jsonEncode({'status': 'sent'}), 200, headers: {'content-type': 'application/json'});
        }),
      );
      return ProviderScope(
        overrides: [sessionManagerProvider.overrideWithValue(session), apiClientProvider.overrideWithValue(api)],
        child: MaterialApp(
          theme: TokenGoTheme.light(),
          home: OtpScreen(phone: '9000000021', onChangeNumber: () {}, onSignedIn: () => signedIn = true),
        ),
      );
    }

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('a code that arrives while the screen is open fills the field and signs in with no tap', (tester) async {
      await tester.pumpWidget(await screen());
      await settle(tester);
      expect(verifyBodies, isEmpty, reason: 'nothing arrived yet');

      native.pending = '654321';
      await native.announceCode();
      await settle(tester);

      expect(verifyBodies, [
        {'phone': '9000000021', 'code': '654321'},
      ]);
      expect(signedIn, isTrue);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '654321');
      await tester.pumpWidget(const SizedBox()); // dispose the screen's timer
    });

    testWidgets('a code already waiting when the screen opens (one-tap brought the app to the front) signs in too', (tester) async {
      native.pending = '123456';
      await tester.pumpWidget(await screen());
      await settle(tester);

      expect(verifyBodies.map((b) => b['code']), ['123456']);
      expect(signedIn, isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the same code is never used twice', (tester) async {
      native.pending = '123456';
      await tester.pumpWidget(await screen());
      await settle(tester);
      await native.announceCode(); // a second announcement finds nothing left to claim
      await settle(tester);

      expect(verifyBodies, hasLength(1));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('with no WhatsApp code the person types as before (and it still submits at the sixth digit)', (tester) async {
      await tester.pumpWidget(await screen());
      await settle(tester);
      await tester.enterText(find.byType(TextField), '111222');
      await settle(tester);

      expect(verifyBodies.map((b) => b['code']), ['111222']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('"Resend code" starts a fresh handshake BEFORE asking the server for the new code', (tester) async {
      await tester.pumpWidget(await screen());
      await tester.pump(const Duration(seconds: 31)); // the resend countdown
      _timeline.clear();

      await tester.tap(find.text('Resend code'));
      await settle(tester);

      expect(_timeline.where((e) => e != 'native:takePendingCode'), ['native:startHandshake', 'http:/api/v1/auth/otp/request']);
      await tester.pumpWidget(const SizedBox());
    });
    testWidgets('autofill works EVERY time: a code that was announced while nothing was listening is still found within a second', (tester) async {
      // The Android side can lose the "a code has arrived" notification (the engine was re-created, the screen was not open yet).
      // The code itself is still waiting there, so the screen must go and ask rather than rely on being told.
      await tester.pumpWidget(await screen());
      await settle(tester);
      expect(verifyBodies, isEmpty);

      native.pending = '246810'; // NO announceCode(): the notification was lost
      await tester.pump(const Duration(milliseconds: 1100));
      await settle(tester);

      expect(verifyBodies.map((b) => b['code']), ['246810']);
      expect(signedIn, isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('two sign-ins in a row (sign out, sign in again) both autofill', (tester) async {
      for (final code in ['111111', '222222']) {
        await tester.pumpWidget(await screen());
        await settle(tester);
        native.pending = code;
        await native.announceCode();
        await settle(tester);
        expect(verifyBodies.map((b) => b['code']), [code], reason: 'sign-in with $code');
        expect(signedIn, isTrue);
        await tester.pumpWidget(const SizedBox());
      }
    });

    group('the clipboard fallback (the "Copy code" button in the WhatsApp message)', () {
      String? clip;

      setUp(() {
        clip = null;
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.getData') return clip == null ? null : {'text': clip};
          return null;
        });
      });
      tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

      testWidgets('coming back to the app with a copied code signs in with no tap', (tester) async {
        await tester.pumpWidget(await screen());
        await settle(tester);

        clip = '135790'; // the person tapped "Copy code" in WhatsApp
        leaveAndComeBack(tester);
        await settle(tester);

        expect(verifyBodies.map((b) => b['code']), ['135790']);
        expect(signedIn, isTrue);
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('anything on the clipboard that is not a lone 6-digit code is left alone', (tester) async {
        await tester.pumpWidget(await screen());
        await settle(tester);

        for (final other in ['hello', '12345', '1234567', 'call 123456 now', 'https://example.com/123456']) {
          clip = other;
          leaveAndComeBack(tester);
          await settle(tester);
        }
        expect(verifyBodies, isEmpty);
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('a code that was already tried is not tried again on every return to the app', (tester) async {
        await tester.pumpWidget(await screen());
        await settle(tester);
        clip = '135790';
        for (var i = 0; i < 3; i++) {
          leaveAndComeBack(tester);
          await settle(tester);
        }
        expect(verifyBodies, hasLength(1));
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('the "Paste code" button uses the clipboard, and says what to do when there is no code on it', (tester) async {
        await tester.pumpWidget(await screen());
        await settle(tester);

        clip = null;
        await tester.tap(find.text('Paste code'));
        await settle(tester);
        expect(find.textContaining('tap "Copy code"'), findsOneWidget);
        expect(verifyBodies, isEmpty);

        clip = '908070';
        await tester.tap(find.text('Paste code'));
        await settle(tester);
        expect(verifyBodies.map((b) => b['code']), ['908070']);
        await tester.pumpWidget(const SizedBox());
      });
    });
  });

  group('loginCodeIn', () {
    test('accepts a lone 6-digit code, with the spaces or dashes people type', () {
      expect(loginCodeIn('482916'), '482916');
      expect(loginCodeIn(' 482916\n'), '482916');
      expect(loginCodeIn('482 916'), '482916');
      expect(loginCodeIn('482-916'), '482916');
    });

    test('refuses everything else', () {
      for (final bad in [null, '', '12345', '1234567', 'abcdef', 'your code is 482916', '48291a']) {
        expect(loginCodeIn(bad), isNull, reason: '"$bad"');
      }
    });
  });
}
