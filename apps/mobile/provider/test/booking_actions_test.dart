import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:tokengo_provider/core/providers.dart';
import 'package:tokengo_provider/features/bookings/booking_detail_screen.dart';
import 'package:tokengo_provider/features/bookings/qr_scan_screen.dart';

import 'support/harness.dart';

/// A fake API for one booking whose status the tests drive. Records every write the app makes.
class _Api {
  _Api(this.status, {this.refuse});

  String status;

  /// When set, every action is refused with this problem+json `detail` (HTTP 409).
  final String? refuse;
  final writes = <({String path, Map<String, dynamic> body})>[];

  Future<http.Response> handle(http.Request r) async {
    final path = r.url.path.replaceFirst('/api/v1', '');
    if (r.method == 'POST') {
      writes.add((path: path, body: r.body.isEmpty ? <String, dynamic>{} : jsonDecode(r.body) as Map<String, dynamic>));
      if (refuse != null) return jsonResponse(409, {'title': 'Conflict', 'detail': refuse, 'status': 409, 'code': 'INVALID_STATE'});
      status = switch (path.split('/').last) {
        'approve' => 'CONFIRMED',
        'reject' => 'PROVIDER_REJECTED',
        'verify-arrival' => 'CUSTOMER_ARRIVED',
        'start' => 'SERVICE_STARTED',
        'complete' => 'SERVICE_COMPLETED',
        'provider-cancel' => 'PROVIDER_CANCELLED',
        _ => status,
      };
      return jsonResponse(200, {'data': bookingJson(status: status)});
    }
    if (path.endsWith('/events')) return jsonResponse(200, {'data': <Object>[]});
    return jsonResponse(200, {'data': bookingJson(status: status)});
  }
}

Future<void> _open(WidgetTester tester, _Api api) async {
  await tester.pumpWidget(
    await providerScope(
      handler: api.handle,
      home: const BookingDetailScreen(bookingId: 'b1'),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a new request offers Accept and Decline, and Accept confirms it (then offers the next step)', (tester) async {
    final api = _Api('REQUESTED');
    await _open(tester, api);
    expect(find.text('Accept booking'), findsOneWidget);
    expect(find.text('Decline'), findsOneWidget);
    expect(find.text('New request'), findsOneWidget);

    await tester.tap(find.text('Accept booking'));
    await tester.pumpAndSettle();

    expect(api.writes.map((w) => w.path), ['/appointments/b1/approve']);
    // The screen reloaded from the server and now shows what is possible next.
    expect(find.text('Scan customer QR'), findsOneWidget);
    expect(find.text('Accept booking'), findsNothing);
  });

  testWidgets('declining needs a reason, and sends the servers reason code', (tester) async {
    final api = _Api('REQUESTED');
    await _open(tester, api);

    await tester.tap(find.text('Decline'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Decline booking')).onPressed, isNull, reason: 'no reason yet');

    await tester.tap(find.text('Fully booked'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Decline booking'));
    await tester.pumpAndSettle();

    expect(api.writes.single.path, '/appointments/b1/reject');
    expect(api.writes.single.body, {'reason_code': 'OVERBOOKED'});
    expect(find.text('Declined'), findsWidgets);
  });

  testWidgets('arrival is verified with the 6-digit code the customer shows (not skipped)', (tester) async {
    final api = _Api('CONFIRMED');
    await _open(tester, api);
    expect(find.text('Start service'), findsNothing, reason: 'cannot start before the customer has been verified');

    await tester.tap(find.text('Enter 6-digit code'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '123');
    await tester.pump();
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Verify')).onPressed, isNull, reason: 'only 3 digits');

    await tester.enterText(find.byType(TextField), '123456');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    expect(api.writes.single.path, '/appointments/b1/verify-arrival');
    expect(api.writes.single.body, {'pin': '123456'});
    expect(find.text('Start service'), findsOneWidget);
  });

  group('arrival by QR code', () {
    Future<_Api> openWith(
      WidgetTester tester,
      Future<String?> Function(BuildContext) scan, {
      String status = 'CONFIRMED',
      String? refuse,
    }) async {
      final api = _Api(status, refuse: refuse);
      await tester.pumpWidget(
        await providerScope(
          handler: api.handle,
          home: const BookingDetailScreen(bookingId: 'b1'),
          overrides: [qrScanLauncherProvider.overrideWithValue(scan)],
        ),
      );
      await tester.pumpAndSettle();
      return api;
    }

    testWidgets('scanning sends the token as read (the server checks it), then the booking is re-read', (tester) async {
      final api = await openWith(tester, (_) async => '  signed-token.abc123  ');
      expect(find.text('Scan customer QR'), findsOneWidget);
      await tester.tap(find.text('Scan customer QR'));
      await tester.pumpAndSettle();
      expect(api.writes.single.path, '/appointments/b1/verify-arrival');
      expect(api.writes.single.body, {'qr_token': 'signed-token.abc123'}, reason: 'only the token: no PIN, no status');
      expect(find.text('Start service'), findsOneWidget);
    });

    testWidgets('backing out of the scanner changes nothing and sends nothing', (tester) async {
      final api = await openWith(tester, (_) async => null);
      await tester.tap(find.text('Scan customer QR'));
      await tester.pumpAndSettle();
      expect(api.writes, isEmpty);
      expect(find.text('Scan customer QR'), findsOneWidget);
    });

    testWidgets('something that cannot be an arrival token is not sent', (tester) async {
      final api = await openWith(tester, (_) async => 'x' * 301);
      await tester.tap(find.text('Scan customer QR'));
      await tester.pumpAndSettle();
      expect(api.writes, isEmpty);
      expect(find.textContaining('not a TokenGo arrival code'), findsOneWidget);
    });

    testWidgets('an expired or wrong QR is refused by the server: its reason is shown and the booking is re-read', (tester) async {
      final api = await openWith(tester, (_) async => 'stale-token', refuse: 'This QR code has expired');
      await tester.tap(find.text('Scan customer QR'));
      await tester.pumpAndSettle();
      expect(api.writes.single.body, {'qr_token': 'stale-token'});
      expect(find.text('This QR code has expired'), findsOneWidget);
      expect(find.text('Scan customer QR'), findsOneWidget, reason: 'still confirmed: nothing changed');
      expect(find.text('Start service'), findsNothing);
    });

    test('arrivalTokenFrom keeps a sane token and drops the rest', () {
      expect(arrivalTokenFrom(' abc '), 'abc');
      expect(arrivalTokenFrom(null), isNull);
      expect(arrivalTokenFrom('   '), isNull);
      expect(arrivalTokenFrom('y' * 300), isNotNull);
      expect(arrivalTokenFrom('y' * 301), isNull);
    });
  });

  testWidgets('when the server refuses an action, its reason is shown and the booking is re-read (no silent success)', (tester) async {
    final api = _Api('CONFIRMED', refuse: 'The customer has not arrived yet');
    await _open(tester, api);

    await tester.tap(find.text('Enter 6-digit code'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '000000');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    expect(find.text('The customer has not arrived yet'), findsOneWidget);
    expect(find.text('Enter 6-digit code'), findsOneWidget, reason: 'still confirmed: nothing changed');
    expect(find.text('Start service'), findsNothing);
  });

  testWidgets('in progress offers only "complete"; finished bookings offer no actions', (tester) async {
    final started = _Api('SERVICE_STARTED');
    await _open(tester, started);
    expect(find.text('Mark service complete'), findsOneWidget);
    await tester.tap(find.text('Mark service complete'));
    await tester.pumpAndSettle();
    expect(started.writes.single.path, '/appointments/b1/complete');
    expect(find.text('Mark service complete'), findsNothing);
    expect(find.text('Done — awaiting customer'), findsWidgets);

    final closed = _Api('CLOSED');
    await _open(tester, closed);
    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(OutlinedButton), findsNothing);
  });
}
