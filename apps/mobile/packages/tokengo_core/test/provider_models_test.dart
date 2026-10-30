import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';

Map<String, dynamic> money(int minor) => {'amount_minor': minor, 'currency': 'INR'};

void main() {
  group('earnings (shape of the server\'s EarningsView)', () {
    final json = {
      'waiting': money(30000),
      'eligible': money(120000),
      'in_payout': money(0),
      'paid_total': money(500000),
      'next_eligible_at': '2026-10-09T10:00:00.000Z',
      'payout': {
        'blocker': 'NO_VERIFIED_ACCOUNT',
        'minimum': money(10000),
        'account': {
          'id': 'a1',
          'provider_id': 'p1',
          'holder_name': 'ABC Salon',
          'ifsc': 'HDFC0001234',
          'account_number': '••••6789',
          'status': 'PENDING_VERIFICATION',
          'failure_reason': null,
          'verified_at': null,
          'created_at': '2026-10-07T04:00:00.000Z',
        },
      },
    };

    test('parses every money field as integer minor units and totals them', () {
      final e = Earnings.fromJson(json);
      expect(e.eligible.minor, 120000);
      expect(e.totalEarned.minor, 650000);
      expect(e.minimumPayout.minor, 10000);
      expect(e.nextEligibleAt, DateTime.utc(2026, 10, 9, 10));
      expect(e.blocker, 'NO_VERIFIED_ACCOUNT');
      expect(e.account!.accountMasked, '••••6789');
      expect(e.account!.isPending, isTrue);
    });

    test('a provider with no bank account yet has a null account (not a crash)', () {
      final e = Earnings.fromJson({
        ...json,
        'payout': {'blocker': 'NO_VERIFIED_ACCOUNT', 'minimum': money(10000), 'account': null},
      });
      expect(e.account, isNull);
    });

    test('a changed server contract fails loudly instead of showing wrong money', () {
      final broken = Map<String, dynamic>.of(json)..['eligible'] = {'amount_minor': '1200', 'currency': 'INR'};
      expect(() => Earnings.fromJson(broken), throwsFormatException);
    });
  });

  test('payables and payouts parse, with plain-language statuses', () {
    final payable = Payable.fromJson({
      'id': 'pa1',
      'provider_id': 'p1',
      'booking_id': 'b1',
      'net': money(27000),
      'commission': money(3000),
      'status': 'IN_PAYOUT',
      'eligible_at': '2026-10-09T10:00:00.000Z',
      'payout_id': 'po1',
      'created_at': '2026-10-08T10:00:00.000Z',
    });
    expect(payable.net.minor + payable.commission.minor, 30000);
    expect(payable.statusLabel, 'On its way to your bank');

    final failed = Payout.fromJson({
      'id': 'po1',
      'amount': money(27000),
      'status': 'FAILED',
      'utr': null,
      'failure_reason': 'Account closed',
      'created_at': '2026-10-09T10:00:00.000Z',
      'submitted_at': null,
      'completed_at': null,
    });
    expect(failed.isFailed, isTrue);
    expect(failed.statusLabel, contains('returned to your balance'));
    expect(failed.failureReason, 'Account closed');
  });

  group('ProviderRepository sends what the server expects', () {
    late List<http.Request> seen;
    late ProviderRepository repo;

    setUp(() async {
      seen = [];
      final sessions = SessionManager(MemoryTokenStore(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'u')));
      await sessions.load();
      final api = ApiClient(
        baseUrl: 'http://api.test/api/v1',
        sessions: sessions,
        httpClient: MockClient((r) async {
          seen.add(r);
          return http.Response(
            jsonEncode({
              'data': {
                'id': 'a1',
                'provider_id': 'p1',
                'holder_name': 'ABC Salon',
                'ifsc': 'HDFC0001234',
                'account_number': '••••6789',
                'status': 'PENDING_VERIFICATION',
                'failure_reason': null,
                'verified_at': null,
                'created_at': '2026-10-07T04:00:00.000Z',
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      repo = ProviderRepository(api);
    });

    test('bank details: trimmed, IFSC upper-cased, PUT to the payout-account route', () async {
      await repo.setPayoutAccount('p1', holderName: '  ABC Salon ', accountNumber: ' 123456789 ', ifsc: 'hdfc0001234');
      expect(seen.single.method, 'PUT');
      expect(seen.single.url.path, '/api/v1/providers/p1/payout-account');
      expect(jsonDecode(seen.single.body), {'holder_name': 'ABC Salon', 'account_number': '123456789', 'ifsc': 'HDFC0001234'});
    });

    test('arrival is verified with the PIN only (never a client-chosen status)', () async {
      try {
        await repo.verifyArrival('b1', pin: '123456');
      } catch (_) {
        // The canned response is not a booking; only the request matters here.
      }
      expect(seen.single.url.path, '/api/v1/appointments/b1/verify-arrival');
      expect(jsonDecode(seen.single.body), {'pin': '123456'});
    });

    test('decline carries the reason code, and a blank note is not sent', () async {
      try {
        await repo.reject('b1', reasonCode: ProviderReason.overbooked, note: '   ');
      } catch (_) {}
      expect(jsonDecode(seen.single.body), {'reason_code': 'OVERBOOKED'});
    });
  });
}
