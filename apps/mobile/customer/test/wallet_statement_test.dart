import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:tokengo_customer/features/wallet/wallet_state.dart';

WalletEntry entry(
  String id,
  String type,
  String account,
  String direction, {
  int minor = 30000,
  String? booking = 'b1',
  String at = '2026-10-07T06:37:00.000Z',
}) => WalletEntry.fromJson({
  'id': id,
  'type': type,
  'label': type,
  'account': account,
  'direction': direction,
  'amount': {'amount_minor': minor, 'currency': 'INR'},
  'balance_after': {'amount_minor': 170000, 'currency': 'INR'},
  'booking_id': booking,
  'posted_at': at,
});

void main() {
  test('a hold is shown once (the available-side line), not as -300 and +300', () {
    final all = [
      entry('2', 'HOLD_CREATE', 'HELD', 'CREDIT'),
      entry('1', 'HOLD_CREATE', 'AVAILABLE', 'DEBIT'),
      entry('0', 'DEV_TEST_CREDIT', 'AVAILABLE', 'CREDIT', minor: 200000, booking: null, at: '2026-10-07T04:55:00.000Z'),
    ];
    final shown = collapseMirrorLegs(all);
    expect(shown.map((e) => e.id), ['1', '0']);
  });

  test('a held amount settled to the salon has no available-side partner, so it is kept', () {
    final all = [entry('9', 'HOLD_SETTLE', 'HELD', 'DEBIT')];
    expect(collapseMirrorLegs(all).map((e) => e.id), ['9']);
  });

  test('two different holds of the same size at different moments are not merged', () {
    final all = [
      entry('4', 'HOLD_CREATE', 'HELD', 'CREDIT', at: '2026-10-07T07:00:00.000Z'),
      entry('3', 'HOLD_CREATE', 'AVAILABLE', 'DEBIT', at: '2026-10-07T07:00:00.000Z'),
      entry('2', 'HOLD_CREATE', 'HELD', 'CREDIT', at: '2026-10-07T06:00:00.000Z'),
      entry('1', 'HOLD_CREATE', 'AVAILABLE', 'DEBIT', at: '2026-10-07T06:00:00.000Z'),
    ];
    expect(collapseMirrorLegs(all).map((e) => e.id), ['3', '1']);
  });
}
