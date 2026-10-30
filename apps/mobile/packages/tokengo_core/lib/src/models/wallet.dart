import 'package:flutter/foundation.dart';

import 'json_helpers.dart';
import 'money.dart';

/// "Available" can be spent; "held" is reserved for bookings that are not finished yet (requirements §12).
@immutable
class WalletBalance {
  const WalletBalance({required this.available, required this.held});

  factory WalletBalance.fromJson(Map<String, dynamic> j) =>
      WalletBalance(available: Money.fromJson(j.m('available')), held: Money.fromJson(j.m('held')));

  static const empty = WalletBalance(available: Money.zero, held: Money.zero);

  final Money available;
  final Money held;
  Money get total => available + held;
}

@immutable
class WalletEntry {
  const WalletEntry({
    required this.id,
    required this.type,
    required this.label,
    required this.account,
    required this.direction,
    required this.amount,
    required this.balanceAfter,
    this.bookingId,
    required this.postedAt,
  });

  factory WalletEntry.fromJson(Map<String, dynamic> j) => WalletEntry(
    id: j.s('id'),
    type: j.s('type'),
    label: j.s('label'),
    account: j.s('account'),
    direction: j.s('direction'),
    amount: Money.fromJson(j.m('amount')),
    balanceAfter: Money.fromJson(j.m('balance_after')),
    bookingId: j.sn('booking_id'),
    postedAt: j.dt('posted_at'),
  );

  final String id;
  final String type;

  /// Already customer-friendly ("Added to wallet", "Reserved for a booking", …).
  final String label;

  /// `AVAILABLE` or `HELD` — which of the two balances this line moved (the server's own values).
  final String account;
  final String direction;
  final Money amount;
  final Money balanceAfter;
  final String? bookingId;
  final DateTime postedAt;

  bool get isCredit => direction == 'CREDIT';
  bool get touchesHeld => account == 'HELD';
}
