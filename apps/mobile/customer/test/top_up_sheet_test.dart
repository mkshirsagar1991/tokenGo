import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:tokengo_customer/features/wallet/checkout_launcher.dart';
import 'package:tokengo_customer/features/wallet/top_up_sheet.dart';

import 'support/harness.dart';

/// The money-critical screen: the app must NEVER say "added" unless the SERVER confirmed it, must never double-create a
/// payment request on retry, and must be honest ("not confirmed yet") when it cannot tell.
class _Api {
  _Api({this.verifyStatuses = const ['SUCCEEDED'], this.createFails = false, this.verifyFails = false});

  final List<String> verifyStatuses;
  final bool createFails;
  final bool verifyFails;
  final created = <http.Request>[];
  var verifyCalls = 0;

  Future<http.Response> handle(http.Request r) async {
    if (r.method == 'POST' && r.url.path == '/api/v1/payments/intents') {
      created.add(r);
      if (createFails) throw http.ClientException('offline');
      return jsonResponse(201, intentJson());
    }
    if (r.method == 'POST' && r.url.path == '/api/v1/payments/intents/pi_1/verify') {
      final i = verifyCalls++;
      if (verifyFails) throw http.ClientException('offline');
      final status = verifyStatuses[i < verifyStatuses.length ? i : verifyStatuses.length - 1];
      return jsonResponse(200, intentJson(status: status));
    }
    // The wallet providers refresh after a top-up; their answers do not matter to these tests.
    return jsonResponse(200, {
      'data': {
        'available': {'amount_minor': 0, 'currency': 'INR'},
        'held': {'amount_minor': 0, 'currency': 'INR'},
      },
      'meta': {'next_cursor': null},
    });
  }
}

Future<void> _openSheet(WidgetTester tester, _Api api, FakeCheckout checkout, {int suggestedMinor = 0}) async {
  await tester.pumpWidget(
    await appScope(
      handler: api.handle,
      checkout: checkout,
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: FilledButton(
              onPressed: () => TopUpSheet.show(context, suggestedMinor: suggestedMinor),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> _tapAdd(WidgetTester tester, String label) async {
  await tester.tap(find.widgetWithText(FilledButton, label));
  await tester.pump(); // creating
  await tester.pump(const Duration(milliseconds: 50)); // intent created -> checkout -> verify
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('credits only after the server confirms: sends paise + an Idempotency-Key, opens checkout for the server order', (
    tester,
  ) async {
    final api = _Api();
    final checkout = FakeCheckout(const CheckoutCompleted());
    await _openSheet(tester, api, checkout);

    await _tapAdd(tester, 'Add ₹500');
    await tester.pumpAndSettle();

    expect(api.created, hasLength(1));
    expect(jsonDecode(api.created.single.body), {'amount_minor': 50000}, reason: 'the amount is sent in paise, never as rupees');
    expect(api.created.single.headers['Idempotency-Key'], isNotEmpty);
    expect(checkout.opened.single.orderId, 'order_1', reason: 'checkout is opened for the SERVER-created order');
    expect(api.verifyCalls, 1);
    expect(find.text('₹500 added'), findsOneWidget);
  });

  testWidgets('checkout says paid but the server has not confirmed: shows "waiting", never "added"', (tester) async {
    final api = _Api(verifyStatuses: ['PENDING']);
    await _openSheet(tester, api, FakeCheckout(const CheckoutCompleted()));

    await _tapAdd(tester, 'Add ₹500');
    // 8 polls, 2.5 s apart.
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(seconds: 3));
    }
    await tester.pumpAndSettle();

    expect(api.verifyCalls, 8);
    expect(find.text('Waiting for confirmation'), findsOneWidget);
    expect(find.textContaining('added'), findsNothing);
    expect(find.text('Payment not completed'), findsNothing, reason: 'we do not know it failed, so we must not say so');
  });

  testWidgets('cancelling the checkout asks the server once and returns to the amount picker without a scary error', (tester) async {
    final api = _Api(verifyStatuses: ['PENDING']);
    await _openSheet(tester, api, FakeCheckout(const CheckoutCancelled()));

    await _tapAdd(tester, 'Add ₹500');
    await tester.pumpAndSettle();

    expect(api.verifyCalls, 1);
    expect(find.text('Payment cancelled. You have not been charged.'), findsOneWidget);
    expect(find.text('Add ₹500'), findsOneWidget);
  });

  testWidgets('the server says the request expired: failed, with a way to retry', (tester) async {
    final api = _Api(verifyStatuses: ['EXPIRED']);
    await _openSheet(tester, api, FakeCheckout(const CheckoutCompleted()));

    await _tapAdd(tester, 'Add ₹500');
    await tester.pumpAndSettle();

    expect(find.text('Payment not completed'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('cannot reach the server after paying: honest "not confirmed yet", not failure', (tester) async {
    final api = _Api(verifyFails: true);
    await _openSheet(tester, api, FakeCheckout(const CheckoutCompleted()));

    await _tapAdd(tester, 'Add ₹500');
    await tester.pumpAndSettle();

    expect(find.text('Waiting for confirmation'), findsOneWidget);
    expect(find.textContaining('could not reach the server'), findsOneWidget);
    expect(find.text('Payment not completed'), findsNothing);
  });

  testWidgets('a retry after a lost connection re-sends the SAME Idempotency-Key (no second payment request)', (tester) async {
    final api = _Api(createFails: true);
    await _openSheet(tester, api, FakeCheckout(const CheckoutCompleted()));

    await _tapAdd(tester, 'Add ₹500');
    await tester.pumpAndSettle();
    expect(find.text('Payment not completed'), findsOneWidget);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    await _tapAdd(tester, 'Add ₹500');
    await tester.pumpAndSettle();

    expect(api.created, hasLength(2));
    expect(api.created[1].headers['Idempotency-Key'], api.created[0].headers['Idempotency-Key']);
  });

  testWidgets('a booking shortfall pre-fills the amount, rounded UP to a whole ₹100', (tester) async {
    final api = _Api();
    await _openSheet(tester, api, FakeCheckout(const CheckoutCompleted()), suggestedMinor: 25000); // ₹250 short

    expect(find.text('Add ₹300'), findsOneWidget);
  });

  testWidgets('amounts outside the allowed range cannot be submitted', (tester) async {
    final api = _Api();
    await _openSheet(tester, api, FakeCheckout(const CheckoutCompleted()));

    await tester.enterText(find.byType(TextField), '5');
    await tester.pump();
    final button = tester.widget<FilledButton>(find.byType(FilledButton).last);
    expect(button.onPressed, isNull);

    await tester.enterText(find.byType(TextField), '60000');
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byType(FilledButton).last).onPressed, isNull);

    await tester.enterText(find.byType(TextField), '750');
    await tester.pump();
    expect(find.text('Add ₹750'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byType(FilledButton).last).onPressed, isNotNull);
  });
}
