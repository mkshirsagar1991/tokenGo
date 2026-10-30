import 'package:flutter/foundation.dart';

import 'json_helpers.dart';
import 'money.dart';

/// A business the signed-in person owns on TokenGo, and whether it has been approved to take bookings.
@immutable
class ProviderAccount {
  const ProviderAccount({
    required this.id,
    required this.displayName,
    required this.status,
    this.decisionReason,
    this.description,
    this.submittedAt,
    this.decidedAt,
    this.version,
  });

  factory ProviderAccount.fromJson(Map<String, dynamic> j) => ProviderAccount(
    id: j.s('id'),
    displayName: j.s('display_name'),
    status: j.s('status'),
    decisionReason: j.sn('decision_reason'),
    description: j.sn('description'),
    submittedAt: j.dtn('submitted_at'),
    decidedAt: j.dtn('decided_at'),
    version: j.inn('version'),
  );

  static const draft = 'DRAFT';
  static const submitted = 'SUBMITTED';
  static const underReview = 'UNDER_REVIEW';
  static const approved = 'APPROVED';
  static const rejected = 'REJECTED';
  static const suspended = 'SUSPENDED';

  final String id;
  final String displayName;
  final String status;

  /// Why TokenGo rejected or suspended it, shown to the owner so they can fix it.
  final String? decisionReason;

  /// What the owner wrote about the business (shown to customers).
  final String? description;
  final DateTime? submittedAt;
  final DateTime? decidedAt;
  final int? version;

  bool get isApproved => status == approved;
  bool get isDraft => status == draft;
  bool get isSuspended => status == suspended;
  bool get isRejected => status == rejected;
  bool get isInReview => status == submitted || status == underReview;

  /// The server only moves DRAFT and REJECTED to "submitted" (a suspended business cannot be resubmitted).
  bool get canSubmit => status == draft || status == rejected;

  /// A suspended business cannot be edited at all; the server refuses, so the app does not offer it.
  bool get canEdit => status != suspended;

  String get statusLabel => switch (status) {
    draft => 'Not submitted yet',
    submitted || underReview => 'Waiting for TokenGo review',
    approved => 'Approved',
    rejected => 'Not approved',
    suspended => 'Suspended',
    _ => status,
  };
}

/// The bank account earnings are paid into. The number only ever arrives masked.
@immutable
class PayoutAccount {
  const PayoutAccount({
    required this.id,
    required this.holderName,
    required this.ifsc,
    required this.accountMasked,
    required this.status,
    this.failureReason,
    this.verifiedAt,
  });

  factory PayoutAccount.fromJson(Map<String, dynamic> j) => PayoutAccount(
    id: j.s('id'),
    holderName: j.s('holder_name'),
    ifsc: j.s('ifsc'),
    accountMasked: j.s('account_number'),
    status: j.s('status'),
    failureReason: j.sn('failure_reason'),
    verifiedAt: j.dtn('verified_at'),
  );

  static const pendingVerification = 'PENDING_VERIFICATION';
  static const verified = 'VERIFIED';
  static const failed = 'VERIFICATION_FAILED';

  final String id;
  final String holderName;
  final String ifsc;
  final String accountMasked;
  final String status;
  final String? failureReason;
  final DateTime? verifiedAt;

  bool get isVerified => status == verified;
  bool get isPending => status == pendingVerification;
  bool get hasFailed => status == failed;
}

/// Why money that is earned is not being paid out yet (the server's own reason code).
abstract final class PayoutBlocker {
  static String? explain(String? code) => switch (code) {
    null => null,
    'PAYOUTS_DISABLED' => 'Bank payouts are not switched on yet.',
    'PAUSED' => 'Payouts are paused for your business. Contact TokenGo support.',
    'PROVIDER_NOT_APPROVED' => 'Payouts start once your business is approved.',
    'NO_VERIFIED_ACCOUNT' => 'Add a bank account and we will verify it before paying out.',
    'ACCOUNT_COOLING_OFF' => 'You changed your bank account recently. Payouts to a new account start after a short safety wait.',
    'PAYOUT_IN_FLIGHT' => 'A bank transfer is already on its way.',
    'BELOW_MINIMUM' => 'Payouts are sent once you have earned the minimum amount.',
    'LEDGER_MISMATCH' => 'Payouts are on hold while we double-check your balance. Contact TokenGo support.',
    _ => 'Payouts are on hold.',
  };
}

/// What the provider has earned and where it stands.
@immutable
class Earnings {
  const Earnings({
    required this.waiting,
    required this.eligible,
    required this.inPayout,
    required this.paidTotal,
    this.nextEligibleAt,
    this.blocker,
    required this.minimumPayout,
    this.account,
  });

  factory Earnings.fromJson(Map<String, dynamic> j) {
    final payout = j.m('payout');
    final account = payout.mn('account');
    return Earnings(
      waiting: Money.fromJson(j.m('waiting')),
      eligible: Money.fromJson(j.m('eligible')),
      inPayout: Money.fromJson(j.m('in_payout')),
      paidTotal: Money.fromJson(j.m('paid_total')),
      nextEligibleAt: j.dtn('next_eligible_at'),
      blocker: payout.sn('blocker'),
      minimumPayout: Money.fromJson(payout.m('minimum')),
      account: account == null ? null : PayoutAccount.fromJson(account),
    );
  }

  /// Earned, but still inside the dispute window.
  final Money waiting;

  /// Ready to be sent to the bank in the next payout run (unless [blocker] says otherwise).
  final Money eligible;

  /// In a bank transfer that has not completed.
  final Money inPayout;
  final Money paidTotal;
  final DateTime? nextEligibleAt;
  final String? blocker;
  final Money minimumPayout;
  final PayoutAccount? account;

  Money get totalEarned => waiting + eligible + inPayout + paidTotal;
}

/// One booking's earnings (after TokenGo's commission).
@immutable
class Payable {
  const Payable({
    required this.id,
    required this.bookingId,
    required this.net,
    required this.commission,
    required this.status,
    required this.eligibleAt,
  });

  factory Payable.fromJson(Map<String, dynamic> j) => Payable(
    id: j.s('id'),
    bookingId: j.s('booking_id'),
    net: Money.fromJson(j.m('net')),
    commission: Money.fromJson(j.m('commission')),
    status: j.s('status'),
    eligibleAt: j.dt('eligible_at'),
  );

  final String id;
  final String bookingId;
  final Money net;
  final Money commission;

  /// ACCRUED | IN_PAYOUT | PAID | CLAWED_BACK
  final String status;
  final DateTime eligibleAt;

  String get statusLabel => switch (status) {
    'ACCRUED' => 'Earned',
    'IN_PAYOUT' => 'On its way to your bank',
    'PAID' => 'Paid',
    'CLAWED_BACK' => 'Reversed',
    _ => status,
  };
}

/// A bank transfer to the provider.
@immutable
class Payout {
  const Payout({
    required this.id,
    required this.amount,
    required this.status,
    this.utr,
    this.failureReason,
    required this.createdAt,
    this.completedAt,
  });

  factory Payout.fromJson(Map<String, dynamic> j) => Payout(
    id: j.s('id'),
    amount: Money.fromJson(j.m('amount')),
    status: j.s('status'),
    utr: j.sn('utr'),
    failureReason: j.sn('failure_reason'),
    createdAt: j.dt('created_at'),
    completedAt: j.dtn('completed_at'),
  );

  final String id;
  final Money amount;
  final String status;

  /// The bank's reference for the transfer, once there is one.
  final String? utr;
  final String? failureReason;
  final DateTime createdAt;
  final DateTime? completedAt;

  bool get isPaid => status == 'PAID';
  bool get isFailed => status == 'FAILED';

  String get statusLabel => switch (status) {
    'PAID' => 'Paid',
    'FAILED' => 'Failed — money returned to your balance',
    'RESERVED' || 'SUBMITTED' => 'On its way',
    _ => status,
  };
}
