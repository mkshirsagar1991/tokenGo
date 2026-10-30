import 'package:flutter/foundation.dart';

import '../util/money_input.dart';
import '../util/zones.dart';
import 'json_helpers.dart';
import 'money.dart';

/// What a person is setting up in the business: locations, services, staff, hours, time off and booking rules.
///
/// Rules these models follow (ADR-0014):
///  * every `*Draft` mirrors the server's validation so the form can say what is wrong BEFORE a round trip, but the server
///    stays the authority — its per-field messages are shown as they arrive;
///  * money is integer paise ([MoneyInput]); coordinates are rounded to the 7 decimals the server accepts;
///  * hours, breaks and time off are the LOCATION's wall-clock strings ("09:30", "2026-10-08") and are never converted with
///    the phone's time zone.

/// Field name → what is wrong with it. Keys are the SERVER's field names (`address_line1`, `price_minor`, …) so a local
/// problem and a server `errors.fields` entry are shown in the same place.
typedef FieldProblems = Map<String, String>;

// ===== locations =====================================================================================================

@immutable
class OwnedLocation {
  const OwnedLocation({
    required this.id,
    required this.providerId,
    required this.name,
    required this.addressLine1,
    this.addressLine2,
    required this.city,
    required this.state,
    required this.postalCode,
    required this.country,
    required this.latitude,
    required this.longitude,
    required this.timezone,
    required this.status,
  });

  factory OwnedLocation.fromJson(Map<String, dynamic> j) => OwnedLocation(
    id: j.s('id'),
    providerId: j.s('provider_id'),
    name: j.s('name'),
    addressLine1: j.s('address_line1'),
    addressLine2: j.sn('address_line2'),
    city: j.s('city'),
    state: j.s('state'),
    postalCode: j.s('postal_code'),
    country: j.s('country'),
    latitude: j.d('latitude'),
    longitude: j.d('longitude'),
    timezone: j.s('timezone'),
    status: j.s('status'),
  );

  final String id;
  final String providerId;
  final String name;
  final String addressLine1;
  final String? addressLine2;
  final String city;
  final String state;
  final String postalCode;
  final String country;
  final double latitude;
  final double longitude;

  /// IANA zone ("Asia/Kolkata"). Every time shown for this location is its wall-clock in this zone.
  final String timezone;

  /// ACTIVE | INACTIVE
  final String status;

  bool get isActive => status == 'ACTIVE';

  String get oneLine => [addressLine1, if (addressLine2 != null && addressLine2!.isNotEmpty) addressLine2, city].join(', ');
}

/// The location form's state. [validate] and [toCreateJson]/[changesFrom] are the only place a location's request body is
/// built, so the exact wire format is tested once.
@immutable
class LocationDraft {
  const LocationDraft({
    this.name = '',
    this.addressLine1 = '',
    this.addressLine2 = '',
    this.city = '',
    this.state = '',
    this.postalCode = '',
    this.latitude,
    this.longitude,
    this.timezone = defaultTimezone,
  });

  factory LocationDraft.from(OwnedLocation l) => LocationDraft(
    name: l.name,
    addressLine1: l.addressLine1,
    addressLine2: l.addressLine2 ?? '',
    city: l.city,
    state: l.state,
    postalCode: l.postalCode,
    latitude: l.latitude,
    longitude: l.longitude,
    timezone: l.timezone,
  );

  static const defaultTimezone = 'Asia/Kolkata';
  static const country = 'IN';
  static final _postal = RegExp(r'^[A-Za-z0-9 -]{3,10}$');

  final String name;
  final String addressLine1;
  final String addressLine2;
  final String city;
  final String state;
  final String postalCode;
  final double? latitude;
  final double? longitude;
  final String timezone;

  /// Reads a typed coordinate ("18.5204", "18,5204"). null when it is not a finite number.
  static double? parseCoordinate(String input) {
    final v = double.tryParse(input.trim().replaceAll(',', '.'));
    return v == null || v.isNaN || v.isInfinite ? null : v;
  }

  /// The server accepts at most 7 decimals; a GPS fix has many more, so every coordinate is rounded to 6 (about 10 cm).
  static double roundCoordinate(double v) => double.parse(v.toStringAsFixed(6));

  LocationDraft copyWith({
    String? name,
    String? addressLine1,
    String? addressLine2,
    String? city,
    String? state,
    String? postalCode,
    double? latitude,
    double? longitude,
    String? timezone,
  }) => LocationDraft(
    name: name ?? this.name,
    addressLine1: addressLine1 ?? this.addressLine1,
    addressLine2: addressLine2 ?? this.addressLine2,
    city: city ?? this.city,
    state: state ?? this.state,
    postalCode: postalCode ?? this.postalCode,
    latitude: latitude ?? this.latitude,
    longitude: longitude ?? this.longitude,
    timezone: timezone ?? this.timezone,
  );

  FieldProblems validate() {
    final p = <String, String>{};
    void length(String field, String label, String value, int min, int max) {
      final n = value.trim().length;
      if (n < min) p[field] = 'Enter $label';
      if (n > max) p[field] = '$label is too long (at most $max characters)';
    }

    length('name', 'a name for this location', name, 1, 120);
    length('address_line1', 'the street address', addressLine1, 1, 200);
    if (addressLine2.trim().length > 200) p['address_line2'] = 'Too long (at most 200 characters)';
    length('city', 'the city', city, 1, 100);
    length('state', 'the state', state, 1, 100);
    if (!_postal.hasMatch(postalCode.trim())) p['postal_code'] = 'Enter a valid PIN code';
    final lat = latitude;
    final lng = longitude;
    if (lat == null || lat < -90 || lat > 90) p['latitude'] = 'Enter a latitude between -90 and 90';
    if (lng == null || lng < -180 || lng > 180) p['longitude'] = 'Enter a longitude between -180 and 180';
    if (!isValidTimeZone(timezone.trim())) p['timezone'] = 'Use a time zone name such as Asia/Kolkata';
    return p;
  }

  Map<String, dynamic> toCreateJson() => {
    'name': name.trim(),
    'address_line1': addressLine1.trim(),
    if (addressLine2.trim().isNotEmpty) 'address_line2': addressLine2.trim(),
    'city': city.trim(),
    'state': state.trim(),
    'postal_code': postalCode.trim(),
    'country': country,
    'latitude': roundCoordinate(latitude!),
    'longitude': roundCoordinate(longitude!),
    'timezone': timezone.trim(),
  };

  /// A PATCH body with ONLY what changed (the server also requires latitude and longitude together). Empty = nothing to save.
  Map<String, dynamic> changesFrom(OwnedLocation o) {
    final out = <String, dynamic>{};
    if (name.trim() != o.name) out['name'] = name.trim();
    if (addressLine1.trim() != o.addressLine1) out['address_line1'] = addressLine1.trim();
    if (addressLine2.trim() != (o.addressLine2 ?? '')) out['address_line2'] = addressLine2.trim().isEmpty ? null : addressLine2.trim();
    if (city.trim() != o.city) out['city'] = city.trim();
    if (state.trim() != o.state) out['state'] = state.trim();
    if (postalCode.trim() != o.postalCode) out['postal_code'] = postalCode.trim();
    final lat = roundCoordinate(latitude!);
    final lng = roundCoordinate(longitude!);
    if (lat != roundCoordinate(o.latitude) || lng != roundCoordinate(o.longitude)) {
      out['latitude'] = lat;
      out['longitude'] = lng;
    }
    if (timezone.trim() != o.timezone) out['timezone'] = timezone.trim();
    return out;
  }
}

// ===== services ======================================================================================================

/// One entry of the platform's service catalogue ("Haircut"), which a business's own priced service is built on.
@immutable
class ServiceType {
  const ServiceType({required this.id, required this.code, required this.name, this.description});

  factory ServiceType.fromJson(Map<String, dynamic> j) =>
      ServiceType(id: j.s('id'), code: j.s('code'), name: j.s('name'), description: j.sn('description'));

  final String id;
  final String code;
  final String name;
  final String? description;
}

/// A service this business offers, with the price the SERVER will charge (bookings read it from here, never from the app).
@immutable
class OwnedService {
  const OwnedService({
    required this.id,
    required this.providerId,
    required this.serviceTypeId,
    required this.name,
    this.description,
    required this.price,
    required this.durationMin,
    required this.bufferMin,
    required this.isActive,
    this.version,
  });

  factory OwnedService.fromJson(Map<String, dynamic> j) => OwnedService(
    id: j.s('id'),
    providerId: j.s('provider_id'),
    serviceTypeId: j.s('service_type_id'),
    name: j.s('name'),
    description: j.sn('description'),
    price: Money.fromJson(j.m('price')),
    durationMin: j.i('duration_min'),
    bufferMin: j.i('buffer_min'),
    isActive: j.b('is_active'),
    version: j.inn('version'),
  );

  final String id;
  final String providerId;
  final String serviceTypeId;
  final String name;
  final String? description;
  final Money price;
  final int durationMin;
  final int bufferMin;
  final bool isActive;
  final int? version;
}

@immutable
class ServiceDraft {
  const ServiceDraft({
    this.serviceTypeId,
    this.name = '',
    this.description = '',
    this.priceRupees = '',
    this.durationMin,
    this.bufferMin = 0,
    this.isActive = true,
  });

  factory ServiceDraft.from(OwnedService s) => ServiceDraft(
    serviceTypeId: s.serviceTypeId,
    name: s.name,
    description: s.description ?? '',
    priceRupees: MoneyInput.toRupeesText(s.price.minor),
    durationMin: s.durationMin,
    bufferMin: s.bufferMin,
    isActive: s.isActive,
  );

  final String? serviceTypeId;
  final String name;
  final String description;

  /// Exactly what the person typed ("1,250.50"); converted to paise by [priceMinor] — never through a double.
  final String priceRupees;
  final int? durationMin;
  final int bufferMin;
  final bool isActive;

  int? get priceMinor => MoneyInput.parseRupees(priceRupees);

  ServiceDraft copyWith({
    String? serviceTypeId,
    String? name,
    String? description,
    String? priceRupees,
    int? durationMin,
    int? bufferMin,
    bool? isActive,
  }) => ServiceDraft(
    serviceTypeId: serviceTypeId ?? this.serviceTypeId,
    name: name ?? this.name,
    description: description ?? this.description,
    priceRupees: priceRupees ?? this.priceRupees,
    durationMin: durationMin ?? this.durationMin,
    bufferMin: bufferMin ?? this.bufferMin,
    isActive: isActive ?? this.isActive,
  );

  FieldProblems validate({required bool creating}) {
    final p = <String, String>{};
    if (creating && serviceTypeId == null) p['service_type_id'] = 'Choose what kind of service this is';
    final n = name.trim().length;
    if (n < 1) p['name'] = 'Enter a name for this service';
    if (n > 120) p['name'] = 'Too long (at most 120 characters)';
    if (description.trim().length > 1000) p['description'] = 'Too long (at most 1000 characters)';
    final minor = priceMinor;
    if (priceRupees.trim().isEmpty) {
      p['price_minor'] = 'Enter the price in rupees';
    } else if (minor == null) {
      p['price_minor'] = 'Enter an amount like 250 or 249.50';
    } else if (minor > MoneyInput.maxServiceMinor) {
      p['price_minor'] = 'The price cannot be more than ₹10,00,000';
    }
    final d = durationMin;
    if (d == null || d < 5 || d > 1440) p['duration_min'] = 'Enter a duration between 5 and 1440 minutes';
    if (bufferMin < 0 || bufferMin > 240) p['buffer_min'] = 'The buffer must be between 0 and 240 minutes';
    return p;
  }

  Map<String, dynamic> toCreateJson() => {
    'service_type_id': serviceTypeId,
    'name': name.trim(),
    if (description.trim().isNotEmpty) 'description': description.trim(),
    'price_minor': priceMinor,
    'currency': 'INR',
    'duration_min': durationMin,
    'buffer_min': bufferMin,
  };

  /// A PATCH body with only what changed. Empty = nothing to save.
  Map<String, dynamic> changesFrom(OwnedService o) {
    final out = <String, dynamic>{};
    if (name.trim() != o.name) out['name'] = name.trim();
    if (description.trim() != (o.description ?? '')) out['description'] = description.trim();
    if (priceMinor != o.price.minor) out['price_minor'] = priceMinor;
    if (durationMin != o.durationMin) out['duration_min'] = durationMin;
    if (bufferMin != o.bufferMin) out['buffer_min'] = bufferMin;
    if (isActive != o.isActive) out['is_active'] = isActive;
    return out;
  }
}

// ===== staff =========================================================================================================

abstract final class StaffRole {
  static const manager = 'MANAGER';
  static const staff = 'STAFF';
  static const all = [staff, manager];

  static String label(String role) => role == manager ? 'Manager' : 'Stylist';
}

@immutable
class OwnedStaff {
  const OwnedStaff({
    required this.id,
    required this.providerId,
    required this.locationId,
    required this.displayName,
    required this.staffRole,
    required this.status,
    required this.hasLogin,
    this.resourceId,
  });

  factory OwnedStaff.fromJson(Map<String, dynamic> j) => OwnedStaff(
    id: j.s('id'),
    providerId: j.s('provider_id'),
    locationId: j.s('location_id'),
    displayName: j.s('display_name'),
    staffRole: j.s('staff_role'),
    status: j.s('status'),
    hasLogin: j.b('has_login'),
    resourceId: j.sn('resource_id'),
  );

  final String id;
  final String providerId;
  final String locationId;
  final String displayName;

  /// MANAGER | STAFF
  final String staffRole;

  /// ACTIVE | INVITED | INACTIVE
  final String status;

  /// True once the person has accepted an invitation and can sign in.
  final bool hasLogin;
  final String? resourceId;

  bool get isInvited => status == 'INVITED';
  String get roleLabel => StaffRole.label(staffRole);
}

@immutable
class StaffDraft {
  const StaffDraft({this.locationId, this.displayName = '', this.role = StaffRole.staff, this.phone = ''});

  final String? locationId;
  final String displayName;
  final String role;

  /// 10-digit mobile number of the person to invite; empty = a stylist without a login (the owner schedules them).
  final String phone;

  static final _mobile = RegExp(r'^[6-9]\d{9}$');

  FieldProblems validate() {
    final p = <String, String>{};
    if (locationId == null) p['location_id'] = 'Choose where this person works';
    final n = displayName.trim().length;
    if (n < 1) p['display_name'] = 'Enter their name';
    if (n > 100) p['display_name'] = 'Too long (at most 100 characters)';
    if (phone.trim().isNotEmpty && !_mobile.hasMatch(phone.trim())) p['phone'] = 'Enter a 10-digit mobile number';
    return p;
  }

  Map<String, dynamic> toCreateJson() => {
    'location_id': locationId,
    'display_name': displayName.trim(),
    'staff_role': role,
    if (phone.trim().isNotEmpty) 'phone': phone.trim(),
  };
}

/// An invitation to join a business as staff, addressed to the signed-in person's phone number.
@immutable
class StaffInvitation {
  const StaffInvitation({
    required this.id,
    required this.providerName,
    required this.locationName,
    required this.staffRole,
    required this.invitedAs,
    required this.invitedAt,
  });

  factory StaffInvitation.fromJson(Map<String, dynamic> j) => StaffInvitation(
    id: j.s('id'),
    providerName: j.s('provider_name'),
    locationName: j.s('location_name'),
    staffRole: j.s('staff_role'),
    invitedAs: j.s('invited_as'),
    invitedAt: j.dt('invited_at'),
  );

  final String id;
  final String providerName;
  final String locationName;
  final String staffRole;
  final String invitedAs;
  final DateTime invitedAt;

  String get roleLabel => StaffRole.label(staffRole);
}

@immutable
class InvitationAccepted {
  const InvitationAccepted({required this.id, required this.providerId, required this.locationId, required this.staffRole});

  factory InvitationAccepted.fromJson(Map<String, dynamic> j) =>
      InvitationAccepted(id: j.s('id'), providerId: j.s('provider_id'), locationId: j.s('location_id'), staffRole: j.s('staff_role'));

  final String id;
  final String providerId;
  final String locationId;
  final String staffRole;
}

/// Which of the business's services a staff member performs. Empty = "can do every service".
@immutable
class StaffSkills {
  const StaffSkills({required this.staffId, required this.restricted, required this.serviceIds});

  factory StaffSkills.fromJson(Map<String, dynamic> j) =>
      StaffSkills(staffId: j.s('staff_id'), restricted: j.b('restricted'), serviceIds: j.ls('service_ids'));

  final String staffId;
  final bool restricted;
  final List<String> serviceIds;
}

// ===== hours =========================================================================================================

/// One opening (or break) window on a weekday, in the location's wall-clock. `end` may be "24:00" (midnight).
@immutable
class HoursWindow {
  const HoursWindow(this.weekday, this.start, this.end);

  factory HoursWindow.fromJson(Map<String, dynamic> j) => HoursWindow(j.i('weekday'), j.s('start'), j.s('end'));

  /// 1 = Monday … 7 = Sunday (ISO).
  final int weekday;
  final String start;
  final String end;

  int get startMin => minutesOf(start);
  int get endMin => minutesOf(end);

  Map<String, dynamic> toJson() => {'weekday': weekday, 'start': start, 'end': end};

  /// "09:30" → 570, "24:00" → 1440.
  static int minutesOf(String hhmm) {
    final p = hhmm.split(':');
    return int.parse(p[0]) * 60 + int.parse(p[1]);
  }

  /// 570 → "09:30", 1440 → "24:00".
  static String hhmmOf(int minutes) =>
      minutes >= 1440 ? '24:00' : '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';

  @override
  bool operator ==(Object other) => other is HoursWindow && other.weekday == weekday && other.start == start && other.end == end;

  @override
  int get hashCode => Object.hash(weekday, start, end);

  @override
  String toString() => 'HoursWindow($weekday $start-$end)';
}

/// A weekly pattern: opening windows and breaks per weekday. Editing returns a new value; nothing here talks to the server.
@immutable
class WeeklyHours {
  const WeeklyHours({this.working = const [], this.breaks = const []});

  factory WeeklyHours.fromJson(Map<String, dynamic> j) =>
      WeeklyHours(working: j.l('working').map(HoursWindow.fromJson).toList(), breaks: j.l('breaks').map(HoursWindow.fromJson).toList());

  /// The same hours on each of [weekdays] (ISO numbers), e.g. Monday to Saturday 09:00–19:00.
  factory WeeklyHours.uniform({required Iterable<int> weekdays, required String start, required String end}) =>
      WeeklyHours(working: [for (final d in weekdays) HoursWindow(d, start, end)]);

  static const maxWindows = 28;

  final List<HoursWindow> working;
  final List<HoursWindow> breaks;

  bool get isEmpty => working.isEmpty && breaks.isEmpty;

  List<HoursWindow> workingOn(int weekday) => (working.where((w) => w.weekday == weekday).toList()..sort(_byStart));
  List<HoursWindow> breaksOn(int weekday) => (breaks.where((w) => w.weekday == weekday).toList()..sort(_byStart));
  bool isOpenOn(int weekday) => working.any((w) => w.weekday == weekday);

  static int _byStart(HoursWindow a, HoursWindow b) => a.startMin.compareTo(b.startMin);

  WeeklyHours add(HoursWindow w, {required bool isBreak}) =>
      isBreak ? WeeklyHours(working: working, breaks: [...breaks, w]) : WeeklyHours(working: [...working, w], breaks: breaks);

  WeeklyHours remove(HoursWindow w, {required bool isBreak}) => isBreak
      ? WeeklyHours(working: working, breaks: breaks.where((x) => x != w).toList())
      : WeeklyHours(working: working.where((x) => x != w).toList(), breaks: breaks);

  WeeklyHours replace(HoursWindow old, HoursWindow updated, {required bool isBreak}) =>
      remove(old, isBreak: isBreak).add(updated, isBreak: isBreak);

  /// Closes the day (no opening windows and no breaks on it).
  WeeklyHours closeDay(int weekday) =>
      WeeklyHours(working: working.where((w) => w.weekday != weekday).toList(), breaks: breaks.where((w) => w.weekday != weekday).toList());

  /// Gives each of [targets] exactly the windows and breaks [from] has.
  WeeklyHours copyDay(int from, Iterable<int> targets) {
    var out = this;
    for (final t in targets) {
      if (t == from) continue;
      out = out.closeDay(t);
      out = WeeklyHours(
        working: [...out.working, for (final w in workingOn(from)) HoursWindow(t, w.start, w.end)],
        breaks: [...out.breaks, for (final b in breaksOn(from)) HoursWindow(t, b.start, b.end)],
      );
    }
    return out;
  }

  /// Problems with the pattern, under `working` / `breaks` (the server's field names for the two lists).
  FieldProblems validate() {
    final p = <String, String>{};
    String? check(List<HoursWindow> list, String what) {
      if (list.length > maxWindows) return 'At most $maxWindows $what in a week';
      for (final w in list) {
        if (w.weekday < 1 || w.weekday > 7) return 'Pick a day of the week';
        if (w.endMin <= w.startMin) return '${weekdayLong(w.weekday)}: a $what must end after it starts';
      }
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          final a = list[i];
          final b = list[j];
          if (a.weekday == b.weekday && a.startMin < b.endMin && b.startMin < a.endMin) {
            return '${weekdayLong(a.weekday)}: two ${what}s overlap';
          }
        }
      }
      return null;
    }

    final workingProblem = check(working, 'opening time');
    if (workingProblem != null) p['working'] = workingProblem;
    final breakProblem = check(breaks, 'break');
    if (breakProblem != null) p['breaks'] = breakProblem;
    return p;
  }

  Map<String, dynamic> toJson() => {'working': working.map((w) => w.toJson()).toList(), 'breaks': breaks.map((w) => w.toJson()).toList()};

  static String weekdayLong(int isoWeekday) =>
      const ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][isoWeekday - 1];

  @override
  bool operator ==(Object other) => other is WeeklyHours && listEquals(other.working, working) && listEquals(other.breaks, breaks);

  @override
  int get hashCode => Object.hash(Object.hashAll(working), Object.hashAll(breaks));
}

// ===== time off ======================================================================================================

/// A holiday or leave ("CLOSED") or a special opening ("OPEN"), on whole days or between two times, in the location's clock.
@immutable
class ScheduleException {
  const ScheduleException({
    required this.id,
    required this.kind,
    required this.startDate,
    required this.endDate,
    this.start,
    this.end,
    this.reason,
  });

  factory ScheduleException.fromJson(Map<String, dynamic> j) => ScheduleException(
    id: j.s('id'),
    kind: j.s('kind'),
    startDate: j.s('start_date'),
    endDate: j.s('end_date'),
    start: j.sn('start'),
    end: j.sn('end'),
    reason: j.sn('reason'),
  );

  final String id;

  /// CLOSED | OPEN
  final String kind;
  final String startDate;
  final String endDate;
  final String? start;
  final String? end;
  final String? reason;

  bool get isClosed => kind == 'CLOSED';
  bool get wholeDay => start == null;
}

@immutable
class ExceptionDraft {
  const ExceptionDraft({this.kind = 'CLOSED', this.startDate = '', this.endDate, this.start, this.end, this.reason = ''});

  final String kind;
  final String startDate;

  /// null = the same day as [startDate].
  final String? endDate;
  final String? start;
  final String? end;
  final String reason;

  static bool isCalendarDate(String s) {
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(s);
    if (m == null) return false;
    final y = int.parse(m.group(1)!);
    final mo = int.parse(m.group(2)!);
    final d = int.parse(m.group(3)!);
    final dt = DateTime.utc(y, mo, d);
    return dt.year == y && dt.month == mo && dt.day == d;
  }

  FieldProblems validate() {
    final p = <String, String>{};
    if (!isCalendarDate(startDate)) p['start_date'] = 'Pick the first day';
    final e = endDate ?? startDate;
    if (endDate != null && !isCalendarDate(e)) {
      p['end_date'] = 'Pick the last day';
    } else if (!p.containsKey('start_date') && e.compareTo(startDate) < 0) {
      p['end_date'] = 'The last day cannot be before the first day';
    }
    if ((start == null) != (end == null)) {
      p['start'] = 'Set both a start and an end time, or neither';
    } else if (start != null && end != null && HoursWindow.minutesOf(end!) <= HoursWindow.minutesOf(start!)) {
      p['end'] = 'The end time must be after the start time';
    }
    if (kind == 'OPEN' && start == null) p['start'] = 'A special opening needs a start and an end time';
    if (reason.trim().length > 200) p['reason'] = 'Too long (at most 200 characters)';
    return p;
  }

  Map<String, dynamic> toJson() => {
    'kind': kind,
    'start_date': startDate,
    if (endDate != null && endDate != startDate) 'end_date': endDate,
    if (start != null) 'start': start,
    if (end != null) 'end': end,
    if (reason.trim().isNotEmpty) 'reason': reason.trim(),
  };
}

// ===== walk-in blocks ================================================================================================

/// Time a staff member is not bookable (a walk-in customer, maintenance). The API speaks in instants (UTC).
@immutable
class StaffBlock {
  const StaffBlock({required this.id, required this.startAt, required this.endAt, this.reason});

  factory StaffBlock.fromJson(Map<String, dynamic> j) =>
      StaffBlock(id: j.s('id'), startAt: j.dt('start_at'), endAt: j.dt('end_at'), reason: j.sn('reason'));

  final String id;
  final DateTime startAt;
  final DateTime endAt;
  final String? reason;
}

/// A block built from the LOCATION's wall-clock ("10 Oct, 09:00–10:00 at the salon"), converted to instants with the
/// location's zone — never the phone's.
@immutable
class BlockDraft {
  const BlockDraft({required this.startAt, required this.endAt, this.reason = ''});

  factory BlockDraft.local({required String zone, required String date, required String start, required String end, String reason = ''}) =>
      BlockDraft(startAt: instantAt(zone, date, start), endAt: instantAt(zone, date, end), reason: reason);

  /// A walk-in that starts [now] (to the minute) and lasts [minutes].
  factory BlockDraft.walkIn({required DateTime now, required int minutes, String reason = 'Walk-in'}) {
    final start = DateTime.utc(now.toUtc().year, now.toUtc().month, now.toUtc().day, now.toUtc().hour, now.toUtc().minute);
    return BlockDraft(
      startAt: start,
      endAt: start.add(Duration(minutes: minutes)),
      reason: reason,
    );
  }

  final DateTime startAt;
  final DateTime endAt;
  final String reason;

  FieldProblems validate() {
    final p = <String, String>{};
    if (!endAt.isAfter(startAt)) {
      p['end_at'] = 'The end must be after the start';
    } else if (endAt.difference(startAt) > const Duration(hours: 24)) {
      p['end_at'] = 'A block cannot be longer than 24 hours';
    }
    if (reason.trim().length > 200) p['reason'] = 'Too long (at most 200 characters)';
    return p;
  }

  Map<String, dynamic> toJson() => {
    'start_at': startAt.toUtc().toIso8601String(),
    'end_at': endAt.toUtc().toIso8601String(),
    if (reason.trim().isNotEmpty) 'reason': reason.trim(),
  };
}

// ===== booking rules =================================================================================================

/// The booking rules in force for this business: the platform's defaults with this business's own overrides on top.
@immutable
class BookingPolicy {
  const BookingPolicy({
    required this.slotGranularityMin,
    required this.minLeadTimeMin,
    required this.maxAdvanceDays,
    required this.responseDeadlineMin,
    required this.checkInWindowMin,
    required this.noShowGraceMin,
    required this.settlementHoldHours,
  });

  factory BookingPolicy.fromJson(Map<String, dynamic> j) => BookingPolicy(
    slotGranularityMin: j.i('slot_granularity_min'),
    minLeadTimeMin: j.i('min_lead_time_min'),
    maxAdvanceDays: j.i('max_advance_days'),
    responseDeadlineMin: j.i('response_deadline_min'),
    checkInWindowMin: j.i('check_in_window_min'),
    noShowGraceMin: j.i('no_show_grace_min'),
    settlementHoldHours: j.i('settlement_hold_hours'),
  );

  static const granularities = [5, 10, 15, 20, 30, 60];

  /// Minutes between the start times offered to customers.
  final int slotGranularityMin;

  /// Customers cannot book sooner than this before the start.
  final int minLeadTimeMin;
  final int maxAdvanceDays;

  /// How long the business has to accept or decline a request before it expires (and the customer is refunded).
  final int responseDeadlineMin;

  /// How early before the start the customer's arrival can be verified.
  final int checkInWindowMin;

  /// How long after the start before a no-show can be marked.
  final int noShowGraceMin;

  /// After a service is completed, how long the customer has to raise a problem before the payment is released.
  final int settlementHoldHours;

  BookingPolicy copyWith({
    int? slotGranularityMin,
    int? minLeadTimeMin,
    int? maxAdvanceDays,
    int? responseDeadlineMin,
    int? checkInWindowMin,
    int? noShowGraceMin,
    int? settlementHoldHours,
  }) => BookingPolicy(
    slotGranularityMin: slotGranularityMin ?? this.slotGranularityMin,
    minLeadTimeMin: minLeadTimeMin ?? this.minLeadTimeMin,
    maxAdvanceDays: maxAdvanceDays ?? this.maxAdvanceDays,
    responseDeadlineMin: responseDeadlineMin ?? this.responseDeadlineMin,
    checkInWindowMin: checkInWindowMin ?? this.checkInWindowMin,
    noShowGraceMin: noShowGraceMin ?? this.noShowGraceMin,
    settlementHoldHours: settlementHoldHours ?? this.settlementHoldHours,
  );

  FieldProblems validate() {
    final p = <String, String>{};
    void range(String field, String label, int v, int min, int max) {
      if (v < min || v > max) p[field] = '$label must be between $min and $max';
    }

    if (!granularities.contains(slotGranularityMin)) p['slot_granularity_min'] = 'Choose one of ${granularities.join(', ')} minutes';
    range('min_lead_time_min', 'Notice needed', minLeadTimeMin, 0, 10080);
    range('max_advance_days', 'Booking window', maxAdvanceDays, 1, 365);
    range('response_deadline_min', 'Response time', responseDeadlineMin, 5, 1440);
    range('check_in_window_min', 'Early check-in', checkInWindowMin, 0, 720);
    range('no_show_grace_min', 'No-show wait', noShowGraceMin, 0, 240);
    range('settlement_hold_hours', 'Payment release delay', settlementHoldHours, 0, 168);
    return p;
  }

  /// The server REPLACES the business's overrides with exactly what is sent (a field left out reverts to the platform
  /// default), so every field goes out, with the value the person saw on screen.
  Map<String, dynamic> toJson() => {
    'slot_granularity_min': slotGranularityMin,
    'min_lead_time_min': minLeadTimeMin,
    'max_advance_days': maxAdvanceDays,
    'response_deadline_min': responseDeadlineMin,
    'check_in_window_min': checkInWindowMin,
    'no_show_grace_min': noShowGraceMin,
    'settlement_hold_hours': settlementHoldHours,
  };

  @override
  bool operator ==(Object other) => other is BookingPolicy && mapEquals(other.toJson(), toJson());

  @override
  int get hashCode => Object.hashAll(toJson().values);
}
