import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:tokengo_provider/features/bookings/bookings_state.dart';

import 'support/harness.dart';

Booking _b(String id, String status, {String start = '2026-10-08T04:30:00.000Z', String? deadline}) {
  final j = bookingJson(id: id, status: status);
  (j['schedule'] as Map<String, dynamic>)['start_at'] = start;
  j['response_deadline_at'] = deadline;
  return Booking.fromJson(j);
}

void main() {
  test('requests are separated from the schedule, most urgent first; finished bookings are not on the schedule', () {
    final s = buildSchedule([
      _b('late', BookingStatus.requested, deadline: '2026-10-07T18:00:00.000Z'),
      _b('urgent', BookingStatus.requested, deadline: '2026-10-07T12:00:00.000Z'),
      _b('later', BookingStatus.confirmed, start: '2026-10-09T04:30:00.000Z'),
      _b('sooner', BookingStatus.confirmed, start: '2026-10-08T04:30:00.000Z'),
      _b('mid', BookingStatus.serviceStarted, start: '2026-10-08T08:00:00.000Z'),
      _b('done', BookingStatus.closed),
      _b('cancelled', BookingStatus.customerCancelled),
    ]);
    expect(s.requests.map((b) => b.id), ['urgent', 'late']);
    expect(s.active.map((b) => b.id), ['sooner', 'mid', 'later']);
    expect(s.isEmpty, isFalse);
    expect(buildSchedule([_b('x', BookingStatus.closed)]).isEmpty, isTrue);
  });

  test('payout blockers are explained in plain words, and unknown codes still say something', () {
    expect(PayoutBlocker.explain(null), isNull);
    expect(PayoutBlocker.explain('NO_VERIFIED_ACCOUNT'), contains('bank account'));
    expect(PayoutBlocker.explain('SOMETHING_NEW'), isNotEmpty);
  });
}
