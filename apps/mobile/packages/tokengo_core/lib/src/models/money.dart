import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';

import 'json_helpers.dart';

/// An amount of money in the SMALLEST currency unit (paise for INR). Integers only: floating point never touches money
/// (requirements §11). The server sends and expects `{ "amount_minor": 20000, "currency": "INR" }`.
@immutable
class Money implements Comparable<Money> {
  const Money(this.minor, [this.currency = 'INR']);

  factory Money.fromJson(Map<String, dynamic> j) => Money(j.i('amount_minor'), j.s('currency'));

  static const zero = Money(0);

  final int minor;
  final String currency;

  Map<String, dynamic> toJson() => {'amount_minor': minor, 'currency': currency};

  bool get isZero => minor == 0;
  bool get isPositive => minor > 0;

  Money operator +(Money o) => Money(minor + o.minor, currency);
  Money operator -(Money o) => Money(minor - o.minor, currency);

  bool operator <(Money o) => minor < o.minor;
  bool operator >=(Money o) => minor >= o.minor;

  /// "₹200", "₹1,250.50" — whole rupees without decimals, Indian digit grouping.
  String format() {
    if (currency != 'INR') return '$currency ${(minor / 100).toStringAsFixed(2)}';
    final whole = minor % 100 == 0;
    final f = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: whole ? 0 : 2);
    return f.format(minor / 100);
  }

  @override
  int compareTo(Money other) => minor.compareTo(other.minor);

  @override
  bool operator ==(Object other) => other is Money && other.minor == minor && other.currency == currency;

  @override
  int get hashCode => Object.hash(minor, currency);

  @override
  String toString() => 'Money($minor $currency)';
}
