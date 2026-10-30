import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'support/harness.dart';

/// Regression: signing in left people stuck on the code screen. The server accepted the code and the session was stored,
/// but the app never navigated, because a router `redirect` is not re-run for screens opened with `push`.
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('after a correct code the app leaves the sign-in screens and shows the signed-in account', (tester) async {
    final calls = <String>[];
    Future<http.Response> api(http.Request r) async {
      calls.add('${r.method} ${r.url.path}');
      if (r.url.path.endsWith('/auth/otp/request')) return jsonResponse(200, {'status': 'sent'});
      if (r.url.path.endsWith('/auth/otp/verify')) {
        return jsonResponse(200, {
          'access_token': 'access-1',
          'refresh_token': 'refresh-1',
          'user': {'id': 'user-1'},
        });
      }
      if (r.url.path.endsWith('/users/me')) {
        return jsonResponse(200, {
          'data': {'id': 'user-1', 'phone_masked': '+91 ••••• ••021', 'permissions': <String>[]},
        });
      }
      return jsonResponse(200, {
        'data': <Object>[],
        'meta': {'next_cursor': null},
      }); // discovery, categories, …
    }

    await tester.pumpWidget(await routedApp(handler: api));
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('Profile'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Sign in with your phone'), findsOneWidget);

    await tester.tap(find.text('Sign in with your phone'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.enterText(find.byType(TextField), '9000000021');
    await tester.pump();
    await tester.tap(find.text('Send code'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Enter the code'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '123456'); // submits by itself at the sixth digit
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(calls, contains('POST /api/v1/auth/otp/verify'));
    expect(find.text('Enter the code'), findsNothing, reason: 'the code screen must be gone once signed in');
    expect(find.text('Sign in with your phone'), findsNothing);
    expect(find.text('Customer account'), findsOneWidget, reason: 'back on Profile, now showing the signed-in account');
  });

  testWidgets('a wrong code keeps the person on the code screen with a clear message', (tester) async {
    Future<http.Response> api(http.Request r) async {
      if (r.url.path.endsWith('/auth/otp/request')) return jsonResponse(200, {'status': 'sent'});
      if (r.url.path.endsWith('/auth/otp/verify')) {
        return jsonResponse(401, {'type': 'about:blank', 'title': 'Unauthorized', 'status': 401, 'code': 'INVALID_OTP'});
      }
      return jsonResponse(200, {
        'data': <Object>[],
        'meta': {'next_cursor': null},
      });
    }

    await tester.pumpWidget(await routedApp(handler: api));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Profile'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Sign in with your phone'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.enterText(find.byType(TextField), '9000000021');
    await tester.pump();
    await tester.tap(find.text('Send code'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.enterText(find.byType(TextField), '000000');
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.text('Enter the code'), findsOneWidget);
    expect(find.textContaining('not right or has expired'), findsOneWidget);
  });
}
