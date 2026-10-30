import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_customer/app.dart';
import 'package:tokengo_customer/features/wallet/checkout_launcher.dart';
import 'package:tokengo_core/tokengo_core.dart';

http.Response jsonResponse(int status, Object body) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> intentJson({String id = 'pi_1', String status = 'PENDING', int minor = 50000, String provider = 'razorpay'}) => {
  'data': {
    'id': id,
    'status': status,
    'amount': {'amount_minor': minor, 'currency': 'INR'},
    'provider': provider,
    'checkout': status == 'PENDING' ? {'key_id': 'rzp_test_key', 'order_id': 'order_1'} : null,
    'expires_at': '2026-10-08T10:00:00Z',
    'succeeded_at': status == 'SUCCEEDED' ? '2026-10-07T10:00:00Z' : null,
  },
};

/// Stands in for Razorpay's checkout: reports whatever the test says, and records what it was asked to open.
class FakeCheckout implements CheckoutLauncher {
  FakeCheckout(this.outcome);

  CheckoutOutcome outcome;
  final opened = <({String keyId, String orderId, String description})>[];

  @override
  Future<CheckoutOutcome> open({required String keyId, required String orderId, required String description}) async {
    opened.add((keyId: keyId, orderId: orderId, description: description));
    return outcome;
  }
}

/// A signed-in session whose API is [handler] (no network).
Future<ProviderScope> appScope({
  required MockClientHandler handler,
  required Widget child,
  CheckoutLauncher? checkout,
  bool signedIn = true,
}) async {
  final session = SessionManager(
    MemoryTokenStore(signedIn ? const StoredSession(accessToken: 'access', refreshToken: 'refresh', userId: 'user-1') : null),
  );
  await session.load();
  final api = ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient(handler));
  return ProviderScope(
    overrides: [
      sessionManagerProvider.overrideWithValue(session),
      apiClientProvider.overrideWithValue(api),
      if (checkout != null) checkoutLauncherProvider.overrideWithValue(checkout),
    ],
    child: MaterialApp(theme: TokenGoTheme.light(), home: child),
  );
}

/// The whole customer app (real router and screens) over a fake API, starting signed out.
Future<ProviderScope> routedApp({required MockClientHandler handler}) async {
  final session = SessionManager(MemoryTokenStore());
  await session.load();
  final api = ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient(handler));
  return ProviderScope(
    overrides: [
      sessionManagerProvider.overrideWithValue(session),
      apiClientProvider.overrideWithValue(api),
      // No Android side in a widget test: a native call would never answer.
      whatsAppOtpAutofillProvider.overrideWithValue(WhatsAppOtpAutofill.disabled()),
    ],
    child: const TokenGoApp(),
  );
}
