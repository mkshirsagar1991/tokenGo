import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';

// Shapes copied from REAL responses of the running TokenGo API (search, location profile, slots, bookings, wallet).
const searchRow = <String, dynamic>{
  'location_id': '01a114b7-67bf-77a3-8397-24ae0a6ae8e5',
  'provider_id': '01a114b7-6790-7aa1-8fd9-cd9d0960563d',
  'name': 'ABC Salon',
  'location_name': 'ABC Salon — Koregaon Park',
  'address': {'line1': '12 North Main Road', 'line2': null, 'city': 'Pune', 'state': 'Maharashtra', 'postal_code': '411001'},
  'latitude': 18.5362,
  'longitude': 73.8938,
  'distance_m': 4675,
  'timezone': 'Asia/Kolkata',
  'rating': {'average': null, 'count': 0},
  'price_from': {'amount_minor': 10000, 'currency': 'INR'},
  'matching_services': 4,
  'open_now': true,
};

const bookingJson = <String, dynamic>{
  'id': 'b1',
  'reference': 'TG-Z8DV4N99',
  'status': 'CONFIRMED',
  'funds_status': 'HELD',
  'settlement_status': 'NOT_DUE',
  'customer_id': 'c1',
  'provider_id': 'p1',
  'location_id': 'l1',
  'location_name': 'XYZ Salon',
  'staff_resource_id': 'r1',
  'service': {'id': 's1', 'name': 'Shaving', 'duration_min': 20, 'buffer_min': 5, 'version': 1},
  'price': {'amount_minor': 10000, 'currency': 'INR'},
  'schedule': {
    'start_at': '2026-10-08T04:30:00.000Z',
    'end_at': '2026-10-08T04:50:00.000Z',
    'local_start': '2026-10-08T10:00',
    'timezone': 'Asia/Kolkata',
  },
  'response_deadline_at': null,
  'timeline': {
    'requested_at': '2026-10-07T04:00:00.000Z',
    'confirmed_at': '2026-10-07T04:10:00.000Z',
    'arrived_at': null,
    'started_at': null,
    'completed_at': null,
    'closed_at': null,
  },
  'settle_after': null,
  'status_reason': null,
  'note': null,
  'cancellation': {
    'policy': 'Standard',
    'refund_if_cancelled_now': {
      'bps': 10000,
      'amount': {'amount_minor': 10000, 'currency': 'INR'},
    },
  },
};

void main() {
  group('Money', () {
    test('formats rupees with Indian grouping and only shows paise when there are some', () {
      expect(const Money(20000).format(), '₹200');
      expect(const Money(125050).format(), '₹1,250.50');
      expect(const Money(0).format(), '₹0');
      expect(const Money(12345600).format(), '₹1,23,456');
      expect(const Money(99).format(), '₹0.99');
    });

    test('is integer arithmetic and value-equal', () {
      expect(const Money(100) + const Money(250), const Money(350));
      expect(const Money(100) - const Money(250), const Money(-150));
      expect(const Money(100) == const Money(100, 'INR'), isTrue);
      expect(const Money(100) == const Money(100, 'USD'), isFalse);
    });

    test('parses and round-trips the server format', () {
      final m = Money.fromJson({'amount_minor': 20000, 'currency': 'INR'});
      expect(m.minor, 20000);
      expect(m.toJson(), {'amount_minor': 20000, 'currency': 'INR'});
    });

    test('refuses a non-integer amount instead of rounding it', () {
      expect(() => Money.fromJson({'amount_minor': 20000.5, 'currency': 'INR'}), throwsFormatException);
      expect(() => Money.fromJson({'amount_minor': '20000', 'currency': 'INR'}), throwsFormatException);
    });
  });

  group('discovery models', () {
    test('a search row parses, with a friendly distance', () {
      final c = ProviderCard.fromJson(searchRow);
      expect(c.name, 'ABC Salon');
      expect(c.priceFrom, const Money(10000));
      expect(c.distanceLabel, '4.7 km');
      expect(c.rating.hasRatings, isFalse);
      expect(c.address.oneLine, '12 North Main Road, Pune');
      expect(c.openNow, isTrue);
    });

    test('distance under a kilometre is shown in metres', () {
      expect(ProviderCard.fromJson({...searchRow, 'distance_m': 850}).distanceLabel, '850 m');
    });

    test('a location profile parses services, staff, hours and rules', () {
      final p = LocationProfile.fromJson({
        'location_id': 'l1',
        'provider_id': 'p1',
        'name': 'ABC Salon',
        'location_name': 'ABC Salon',
        'description': 'Neighbourhood salon',
        'address': {'line1': '12 North Main Road', 'line2': null, 'city': 'Pune', 'state': 'MH', 'postal_code': '411001', 'country': 'IN'},
        'latitude': 18.5,
        'longitude': 73.8,
        'timezone': 'Asia/Kolkata',
        'rating': {'average': 4.5, 'count': 12},
        'open_now': false,
        'hours': [
          {
            'weekday': 1,
            'windows': [
              {'start': '09:00', 'end': '20:00'},
            ],
            'breaks': [
              {'start': '13:30', 'end': '14:15'},
            ],
          },
          {'weekday': 7, 'windows': [], 'breaks': []},
        ],
        'services': [
          {
            'id': 's1',
            'name': 'Facial',
            'description': null,
            'category': 'salon',
            'service_type': 'facial',
            'price': {'amount_minor': 30000, 'currency': 'INR'},
            'duration_min': 45,
          },
        ],
        'staff': [
          {
            'id': 'st1',
            'display_name': 'Amit',
            'service_ids': ['s1'],
          },
          {'id': 'st2', 'display_name': 'Kabir', 'service_ids': null},
        ],
        'booking_rules': {'min_lead_minutes': 60},
      });
      expect(p.services.single.price.format(), '₹300');
      expect(p.staff[1].serviceIds, isNull); // null = does everything
      expect(p.hours.last.closed, isTrue);
      expect(p.hours.first.breaks.single.toString(), '13:30–14:15');
      expect(p.rating.hasRatings, isTrue);
    });

    test('a map pin parses', () {
      final pin = MapPin.fromJson({
        'location_id': 'l1',
        'name': 'ABC',
        'latitude': 18.5,
        'longitude': 73.8,
        'price_from': {'amount_minor': 10000, 'currency': 'INR'},
      });
      expect(pin.priceFrom!.format(), '₹100');
    });

    test('a missing required field fails loudly, naming the field', () {
      final broken = Map<String, dynamic>.from(searchRow)..remove('name');
      expect(() => ProviderCard.fromJson(broken), throwsA(isA<FormatException>().having((e) => e.message, 'message', contains('name'))));
    });
  });

  group('availability', () {
    final slots = SlotsResult.fromJson({
      'timezone': 'Asia/Kolkata',
      'service': {'id': 's1', 'name': 'Facial', 'duration_min': 45},
      'slots': [
        {
          'start_at': '2026-10-08T03:30:00.000Z',
          'end_at': '2026-10-08T04:15:00.000Z',
          'local_start': '2026-10-08T09:00',
          'resources': [
            {'id': 'r1', 'display_name': 'Riya'},
          ],
        },
        {
          'start_at': '2026-10-08T04:30:00.000Z',
          'end_at': '2026-10-08T05:15:00.000Z',
          'local_start': '2026-10-08T10:00',
          'resources': [
            {'id': 'r1', 'display_name': 'Riya'},
            {'id': 'r2', 'display_name': 'Amit'},
          ],
        },
        {
          'start_at': '2026-10-09T03:30:00.000Z',
          'end_at': '2026-10-09T04:15:00.000Z',
          'local_start': '2026-10-09T09:00',
          'resources': [
            {'id': 'r2', 'display_name': 'Amit'},
          ],
        },
      ],
    });

    test('slots keep the instant AND the location wall-clock time', () {
      final s = slots.slots.first;
      expect(s.startAt, DateTime.utc(2026, 10, 8, 3, 30));
      expect(s.localTime, '09:00');
      expect(s.localDate, '2026-10-08');
    });

    test('slots group by local day in order', () {
      expect(slots.byDay.keys, ['2026-10-08', '2026-10-09']);
      expect(slots.byDay['2026-10-08'], hasLength(2));
      expect(slots.slots[1].resources.map((r) => r.displayName), ['Riya', 'Amit']);
    });
  });

  group('Booking', () {
    test('parses the full server view', () {
      final b = Booking.fromJson(bookingJson);
      expect(b.reference, 'TG-Z8DV4N99');
      expect(b.price.format(), '₹100');
      expect(b.localTime, '10:00');
      expect(b.cancellation.refundBps, 10000);
      expect(b.cancellation.refundIfCancelledNow, const Money(10000));
      expect(b.canCancel, isTrue);
      expect(b.showsArrivalCode, isTrue);
      expect(b.isActive, isTrue);
      expect(b.confirmedAt, DateTime.utc(2026, 10, 7, 4, 10));
    });

    test('once it can no longer be cancelled there is no refund preview', () {
      final b = Booking.fromJson({
        ...bookingJson,
        'status': 'CLOSED',
        'cancellation': {'policy': 'Standard', 'refund_if_cancelled_now': null},
      });
      expect(b.canCancel, isFalse);
      expect(b.cancellation.refundIfCancelledNow, isNull);
      expect(b.isActive, isFalse);
    });

    test('a completed service asks the customer to confirm', () {
      expect(Booking.fromJson({...bookingJson, 'status': 'SERVICE_COMPLETED'}).needsCompletionConfirmation, isTrue);
    });

    test('every status has a plain-language label', () {
      for (final s in [
        'REQUESTED',
        'CONFIRMED',
        'PROVIDER_REJECTED',
        'EXPIRED',
        'CUSTOMER_CANCELLED',
        'PROVIDER_CANCELLED',
        'NO_SHOW',
        'CUSTOMER_ARRIVED',
        'SERVICE_STARTED',
        'SERVICE_COMPLETED',
        'DISPUTED',
        'CLOSED',
      ]) {
        expect(BookingStatus.label(s), isNot(s), reason: s);
      }
    });

    test('the arrival code parses', () {
      final c = ArrivalCode.fromJson({
        'booking_id': 'b1',
        'reference': 'TG-1',
        'pin': '482913',
        'qr': {'token': 'v1.abc', 'expires_at': '2026-10-08T04:00:00.000Z'},
      });
      expect(c.pin, '482913');
      expect(c.qrExpiresAt, DateTime.utc(2026, 10, 8, 4));
    });
  });

  group('wallet and payments', () {
    test('balance separates available from held', () {
      final w = WalletBalance.fromJson({
        'available': {'amount_minor': 180000, 'currency': 'INR'},
        'held': {'amount_minor': 20000, 'currency': 'INR'},
      });
      expect(w.available.format(), '₹1,800');
      expect(w.held.format(), '₹200');
      expect(w.total.format(), '₹2,000');
    });

    test('a statement line knows which balance it moved', () {
      final e = WalletEntry.fromJson({
        'id': 'e1',
        'type': 'HOLD_CREATE',
        'label': 'Reserved for a booking',
        'account': 'HELD',
        'direction': 'CREDIT',
        'amount': {'amount_minor': 20000, 'currency': 'INR'},
        'balance_after': {'amount_minor': 20000, 'currency': 'INR'},
        'booking_id': 'b1',
        'posted_at': '2026-10-07T04:00:00.000Z',
      });
      expect(e.touchesHeld, isTrue);
      expect(e.isCredit, isTrue);
      expect(e.bookingId, 'b1');
    });

    test('a Razorpay payment request exposes only the public checkout values', () {
      final p = PaymentIntent.fromJson({
        'id': 'i1',
        'status': 'PENDING',
        'purpose': 'WALLET_TOPUP',
        'amount': {'amount_minor': 50000, 'currency': 'INR'},
        'provider': 'razorpay',
        'checkout': {'provider': 'razorpay', 'key_id': 'rzp_test_abc', 'order_id': 'order_123', 'test_mode': true},
        'expires_at': '2026-10-07T05:00:00.000Z',
        'succeeded_at': null,
        'created_at': '2026-10-07T04:30:00.000Z',
      });
      expect(p.razorpayKeyId, 'rzp_test_abc');
      expect(p.razorpayOrderId, 'order_123');
      expect(p.isPending, isTrue);
      expect(p.isSucceeded, isFalse);
    });

    test('a finished request has no checkout details', () {
      final p = PaymentIntent.fromJson({
        'id': 'i1',
        'status': 'SUCCEEDED',
        'amount': {'amount_minor': 50000, 'currency': 'INR'},
        'provider': 'razorpay',
        'checkout': null,
        'expires_at': '2026-10-07T05:00:00.000Z',
        'succeeded_at': '2026-10-07T04:35:00.000Z',
      });
      expect(p.razorpayOrderId, isNull);
      expect(p.isSucceeded, isTrue);
    });
  });

  group('formatting', () {
    final today = DateTime(2026, 10, 7);
    test('dates are relative near today and absolute further out', () {
      expect(formatLocalDate('2026-10-07', today: today), 'Today');
      expect(formatLocalDate('2026-10-08', today: today), 'Tomorrow');
      expect(formatLocalDate('2026-10-12', today: today), 'Mon, 12 Oct');
    });

    test('times are the LOCATION wall clock, not converted', () {
      expect(formatLocalTime('09:00'), '9:00 AM');
      expect(formatLocalTime('17:30'), '5:30 PM');
      expect(formatLocalTime('00:05'), '12:05 AM');
      expect(formatLocalDateTime('2026-10-08T10:00', today: today), 'Tomorrow · 10:00 AM');
    });

    test('durations and countdowns read naturally', () {
      expect(formatDuration(45), '45 min');
      expect(formatDuration(60), '1 h');
      expect(formatDuration(90), '1 h 30 min');
      final now = DateTime(2026, 10, 7, 12);
      expect(formatCountdown(now.add(const Duration(minutes: 12)), now: now), 'in 12 min');
      expect(formatCountdown(now.add(const Duration(hours: 3)), now: now), 'in 3 h');
      expect(formatCountdown(now.subtract(const Duration(minutes: 1)), now: now), 'now');
    });

    test('todayIso zero-pads', () {
      expect(todayIso(DateTime(2026, 3, 5)), '2026-03-05');
    });
  });
}
