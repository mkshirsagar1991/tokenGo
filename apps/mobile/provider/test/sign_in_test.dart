import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:tokengo_provider/main.dart';

import 'support/harness.dart';

/// Signing in must leave the code screen (the same regression the customer app had: a router redirect is not re-run for
/// screens opened with push).
void main() {
  testWidgets('sign in with a code lands on the business home', (tester) async {
    Future<http.Response> api(http.Request r) async {
      if (r.url.path.endsWith('/auth/otp/request')) return jsonResponse(200, {'status': 'sent'});
      if (r.url.path.endsWith('/auth/otp/verify')) {
        return jsonResponse(200, {
          'access_token': 'a',
          'refresh_token': 'r',
          'user': {'id': 'owner-1'},
        });
      }
      if (r.url.path.endsWith('/providers/mine')) return jsonResponse(200, {'data': <Object>[]});
      return jsonResponse(200, {
        'data': <Object>[],
        'meta': {'next_cursor': null},
      });
    }

    final session = SessionManager(MemoryTokenStore());
    await session.load();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sessionManagerProvider.overrideWithValue(session),
          apiClientProvider.overrideWithValue(ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient(api))),
          // No Android side in a widget test: a native call would never answer.
          whatsAppOtpAutofillProvider.overrideWithValue(WhatsAppOtpAutofill.disabled()),
        ],
        child: const TokenGoBusinessApp(),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Send code'), findsOneWidget, reason: 'signed out: the sign-in screen');
    await tester.enterText(find.byType(TextField), '9000000011');
    await tester.pump();
    await tester.tap(find.text('Send code'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Enter the code'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '123456');
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect(find.text('Enter the code'), findsNothing);
    expect(find.text('No business yet'), findsOneWidget, reason: 'signed in, on the Today tab (this fake owner has no business)');
  });
}
