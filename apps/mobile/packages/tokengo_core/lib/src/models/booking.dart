import 'package:flutter/foundation.dart';

import 'json_helpers.dart';
import 'money.dart';

// ===== availability ==================================================================================================

/// A stylist (schedulable resource) who can take a given slot. NOTE: this is the RESOURCE id, which is what a booking
/// request takes as `resource_id` (a staff member's own id is a different thing).
@immutable
class SlotResource {
  const SlotResource({required this.id, required this.displayName});
  factory SlotResource.fromJson(Map<String, dynamic> j) => SlotResource(id: j.s('id'), displayName: j.s('display_name'));
  final String id;
  final String displayName;
}

@immutable
class Slot {
  const Slot({required this.startAt, required this.endAt, required this.localStart, required this.resources});

  factory Slot.fromJson(Map<String, dynamic> j) => Slot(
    startAt: j.dt('start_at'),
    endAt: j.dt('end_at'),
    localStart: j.s('local_start'),
    resources: j.l('resources').map(SlotResource.fromJson).toList(),
  );

  /// The instant (UTC). Send this back unchanged when booking.
  final DateTime startAt;
  final DateTime endAt;

  /// The wall-clock time AT THE LOCATION ("2026-10-08T09:00"), which is what a person expects to see regardless of
  /// the phone's own time zone.
  final String localStart;
  final List<SlotResource> resources;

  String get localDate => localStart.substring(0, 10);
  String get localTime => localStart.substring(11, 16);
}

/// One service of a visit: what it is and what it costs. A booking holds one or more (a haircut + a facial; a car wash + a tyre change).
@immutable
class ServiceLine {
  const ServiceLine({required this.id, required this.name, required this.price, required this.durationMin});
  factory ServiceLine.fromJson(Map<String, dynamic> j) =>
      ServiceLine(id: j.s('id'), name: j.s('name'), price: Money.fromJson(j.m('price')), durationMin: j.i('duration_min'));

  final String id;
  final String name;
  final Money price;
  final int durationMin;

  /// The server's list of services, or empty when it did not send one (an older server).
  static List<ServiceLine> listFrom(Map<String, dynamic> j, String key) {
    final raw = j[key];
    return raw is List ? raw.whereType<Map<String, dynamic>>().map(ServiceLine.fromJson).toList() : const [];
  }
}

@immutable
class SlotsResult {
  const SlotsResult({
    required this.timezone,
    required this.serviceName,
    required this.durationMin,
    required this.slots,
    this.services = const [],
    this.totalPrice,
  });

  factory SlotsResult.fromJson(Map<String, dynamic> j) {
    final service = j.m('service');
    final total = j.mn('total');
    return SlotsResult(
      timezone: j.s('timezone'),
      serviceName: service.s('name'),
      durationMin: service.i('duration_min'),
      slots: j.l('slots').map(Slot.fromJson).toList(),
      services: ServiceLine.listFrom(j, 'services'),
      totalPrice: total == null ? null : Money.fromJson(total.m('price')),
    );
  }

  /// The visit's name: one service, or all of them joined ("Haircut + Facial").
  final String serviceName;

  /// How long the whole visit takes.
  final int durationMin;

  /// The chosen services, one by one, and what they cost together.
  final List<ServiceLine> services;
  final Money? totalPrice;

  final String timezone;
  final List<Slot> slots;

  /// Slots grouped by local calendar day, in order.
  Map<String, List<Slot>> get byDay {
    final out = <String, List<Slot>>{};
    for (final s in slots) {
      (out[s.localDate] ??= []).add(s);
    }
    return out;
  }
}

// ===== bookings ======================================================================================================

/// The booking lifecycle as the server names it. Status is only ever changed by the server; the app displays it.
abstract final class BookingStatus {
  static const requested = 'REQUESTED';
  static const confirmed = 'CONFIRMED';
  static const providerRejected = 'PROVIDER_REJECTED';
  static const expired = 'EXPIRED';
  static const customerCancelled = 'CUSTOMER_CANCELLED';
  static const providerCancelled = 'PROVIDER_CANCELLED';
  static const noShow = 'NO_SHOW';
  static const customerArrived = 'CUSTOMER_ARRIVED';
  static const serviceStarted = 'SERVICE_STARTED';
  static const serviceCompleted = 'SERVICE_COMPLETED';
  static const disputed = 'DISPUTED';
  static const closed = 'CLOSED';

  /// Still going: shown under "Upcoming".
  static const active = {requested, confirmed, customerArrived, serviceStarted, serviceCompleted, disputed};

  static String label(String status) => switch (status) {
    requested => 'Waiting for the salon',
    confirmed => 'Confirmed',
    providerRejected => 'Declined by the salon',
    expired => 'Expired — no response',
    customerCancelled => 'Cancelled by you',
    providerCancelled => 'Cancelled by the salon',
    noShow => 'Marked as no-show',
    customerArrived => 'You arrived',
    serviceStarted => 'In progress',
    serviceCompleted => 'Completed — please confirm',
    disputed => 'Under review',
    closed => 'Completed',
    _ => status,
  };
}

@immutable
class Cancellation {
  const Cancellation({required this.policy, this.refundBps, this.refundIfCancelledNow});

  factory Cancellation.fromJson(Map<String, dynamic> j) {
    final r = j.mn('refund_if_cancelled_now');
    return Cancellation(
      policy: j.s('policy'),
      refundBps: r?.i('bps'),
      refundIfCancelledNow: r == null ? null : Money.fromJson(r.m('amount')),
    );
  }

  final String policy;

  /// Basis points (10000 = 100 %). null once the booking can no longer be cancelled.
  final int? refundBps;
  final Money? refundIfCancelledNow;
}

@immutable
class Booking {
  const Booking({
    required this.id,
    required this.reference,
    required this.status,
    required this.fundsStatus,
    required this.providerId,
    required this.locationId,
    this.locationName,
    required this.serviceName,
    required this.durationMin,
    required this.price,
    this.services = const [],
    required this.startAt,
    required this.endAt,
    required this.localStart,
    required this.timezone,
    this.responseDeadlineAt,
    this.statusReason,
    this.note,
    this.staffName,
    required this.cancellation,
    this.confirmedAt,
    this.completedAt,
    this.closedAt,
  });

  factory Booking.fromJson(Map<String, dynamic> j) {
    final service = j.m('service');
    final schedule = j.m('schedule');
    final timeline = j.m('timeline');
    return Booking(
      id: j.s('id'),
      reference: j.s('reference'),
      status: j.s('status'),
      fundsStatus: j.s('funds_status'),
      providerId: j.s('provider_id'),
      locationId: j.s('location_id'),
      locationName: j.sn('location_name'),
      serviceName: service.s('name'),
      durationMin: service.i('duration_min'),
      price: Money.fromJson(j.m('price')),
      services: ServiceLine.listFrom(j, 'services'),
      startAt: DateTime.parse(schedule.s('start_at')),
      endAt: DateTime.parse(schedule.s('end_at')),
      localStart: schedule.s('local_start'),
      timezone: schedule.s('timezone'),
      responseDeadlineAt: j.dtn('response_deadline_at'),
      statusReason: j.sn('status_reason'),
      note: j.sn('note'),
      staffName: j.sn('staff_name'),
      cancellation: Cancellation.fromJson(j.m('cancellation')),
      confirmedAt: timeline.dtn('confirmed_at'),
      completedAt: timeline.dtn('completed_at'),
      closedAt: timeline.dtn('closed_at'),
    );
  }

  final String id;

  /// The short human reference ("TG-Z8DV4N99") to quote to the salon or support.
  final String reference;
  final String status;

  /// NONE | HELD | RELEASED | SETTLED | PARTIAL — what happened to the customer's money.
  final String fundsStatus;
  final String providerId;
  final String locationId;
  final String? locationName;
  /// All the services joined ("Haircut + Facial"): what to call the booking.
  final String serviceName;

  /// How long the whole visit takes.
  final int durationMin;

  /// The total of all the services.
  final Money price;

  /// The services one by one (at least one when the server sent them).
  final List<ServiceLine> services;
  final DateTime startAt;
  final DateTime endAt;
  final String localStart;
  final String timezone;
  final DateTime? responseDeadlineAt;
  final String? statusReason;
  final String? note;

  /// The stylist the visit is with (null if the server could not name them).
  final String? staffName;
  final Cancellation cancellation;
  final DateTime? confirmedAt;
  final DateTime? completedAt;
  final DateTime? closedAt;

  String get localDate => localStart.substring(0, 10);
  String get localTime => localStart.substring(11, 16);
  bool get hasSeveralServices => services.length > 1;

  bool get isActive => BookingStatus.active.contains(status);
  bool get canCancel => status == BookingStatus.requested || status == BookingStatus.confirmed;
  bool get needsCompletionConfirmation => status == BookingStatus.serviceCompleted;
  bool get showsArrivalCode => status == BookingStatus.confirmed;
}

@immutable
class BookingEvent {
  const BookingEvent({
    required this.id,
    required this.type,
    this.fromStatus,
    this.toStatus,
    required this.actorType,
    this.reasonCode,
    required this.occurredAt,
  });

  factory BookingEvent.fromJson(Map<String, dynamic> j) => BookingEvent(
    id: j.s('id'),
    type: j.s('type'),
    fromStatus: j.sn('from_status'),
    toStatus: j.sn('to_status'),
    actorType: j.s('actor_type'),
    reasonCode: j.sn('reason_code'),
    occurredAt: j.dt('occurred_at'),
  );

  final String id;
  final String type;
  final String? fromStatus;
  final String? toStatus;
  final String actorType;
  final String? reasonCode;
  final DateTime occurredAt;
}

/// What the customer shows at the venue: a 6-digit PIN, and a short-lived QR token.
@immutable
class ArrivalCode {
  const ArrivalCode({
    required this.bookingId,
    required this.reference,
    required this.pin,
    required this.qrToken,
    required this.qrExpiresAt,
  });

  factory ArrivalCode.fromJson(Map<String, dynamic> j) {
    final qr = j.m('qr');
    return ArrivalCode(
      bookingId: j.s('booking_id'),
      reference: j.s('reference'),
      pin: j.s('pin'),
      qrToken: qr.s('token'),
      qrExpiresAt: qr.dt('expires_at'),
    );
  }

  final String bookingId;
  final String reference;
  final String pin;
  final String qrToken;
  final DateTime qrExpiresAt;
}
