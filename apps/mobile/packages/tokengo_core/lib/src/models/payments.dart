import 'package:flutter/foundation.dart';

import 'json_helpers.dart';
import 'money.dart';

/// A request to add money to the wallet. Creating one credits NOTHING: the wallet is credited only when the SERVER has
/// asked the payment provider and it confirms the money was captured.
@immutable
class PaymentIntent {
  const PaymentIntent({
    required this.id,
    required this.status,
    required this.amount,
    required this.provider,
    this.checkout,
    required this.expiresAt,
    this.succeededAt,
  });

  factory PaymentIntent.fromJson(Map<String, dynamic> j) => PaymentIntent(
    id: j.s('id'),
    status: j.s('status'),
    amount: Money.fromJson(j.m('amount')),
    provider: j.s('provider'),
    checkout: j.mn('checkout'),
    expiresAt: j.dt('expires_at'),
    succeededAt: j.dtn('succeeded_at'),
  );

  static const pending = 'PENDING';
  static const succeeded = 'SUCCEEDED';
  static const expired = 'EXPIRED';
  static const cancelled = 'CANCELLED';

  final String id;
  final String status;
  final Money amount;

  /// `razorpay` or `sandbox`.
  final String provider;

  /// What the provider's checkout needs (e.g. `key_id`, `order_id`). Present only while the request can still be paid.
  final Map<String, dynamic>? checkout;
  final DateTime expiresAt;
  final DateTime? succeededAt;

  bool get isSucceeded => status == succeeded;
  bool get isPending => status == pending;
  bool get isFinalFailure => status == expired || status == cancelled;

  String? get razorpayKeyId => provider == 'razorpay' ? (checkout?['key_id'] as String?) : null;
  String? get razorpayOrderId => provider == 'razorpay' ? (checkout?['order_id'] as String?) : null;
}
