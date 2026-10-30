import 'package:flutter/foundation.dart';

import 'json_helpers.dart';
import 'money.dart';

/// A page of results with the cursor for the next one (null = the end).
@immutable
class PagedResult<T> {
  const PagedResult(this.items, this.nextCursor);
  final List<T> items;
  final String? nextCursor;
  bool get hasMore => nextCursor != null;
}

@immutable
class ServiceCategory {
  const ServiceCategory({required this.id, required this.code, required this.name, this.description});

  factory ServiceCategory.fromJson(Map<String, dynamic> j) =>
      ServiceCategory(id: j.s('id'), code: j.s('code'), name: j.s('name'), description: j.sn('description'));

  final String id;
  final String code;
  final String name;
  final String? description;
}

@immutable
class Address {
  const Address({required this.line1, this.line2, required this.city, required this.state, required this.postalCode});

  factory Address.fromJson(Map<String, dynamic> j) =>
      Address(line1: j.s('line1'), line2: j.sn('line2'), city: j.s('city'), state: j.s('state'), postalCode: j.s('postal_code'));

  final String line1;
  final String? line2;
  final String city;
  final String state;
  final String postalCode;

  String get oneLine => [line1, if (line2 != null && line2!.isNotEmpty) line2, city].join(', ');
}

@immutable
class Rating {
  const Rating({this.average, required this.count});
  factory Rating.fromJson(Map<String, dynamic> j) => Rating(average: j.dn('average'), count: j.i('count'));
  final double? average;
  final int count;
  bool get hasRatings => average != null && count > 0;
}

/// One row of the nearby-search results (a provider LOCATION).
@immutable
class ProviderCard {
  const ProviderCard({
    required this.locationId,
    required this.providerId,
    required this.name,
    required this.locationName,
    required this.address,
    required this.latitude,
    required this.longitude,
    required this.distanceM,
    required this.timezone,
    required this.rating,
    this.priceFrom,
    required this.matchingServices,
    required this.openNow,
  });

  factory ProviderCard.fromJson(Map<String, dynamic> j) => ProviderCard(
    locationId: j.s('location_id'),
    providerId: j.s('provider_id'),
    name: j.s('name'),
    locationName: j.s('location_name'),
    address: Address.fromJson(j.m('address')),
    latitude: j.d('latitude'),
    longitude: j.d('longitude'),
    distanceM: j.inn('distance_m'),
    timezone: j.s('timezone'),
    rating: Rating.fromJson(j.m('rating')),
    priceFrom: j.mn('price_from') == null ? null : Money.fromJson(j.m('price_from')),
    matchingServices: j.i('matching_services'),
    openNow: j.b('open_now'),
  );

  final String locationId;
  final String providerId;
  final String name;
  final String locationName;
  final Address address;
  final double latitude;
  final double longitude;
  final int? distanceM;
  final String timezone;
  final Rating rating;
  final Money? priceFrom;
  final int matchingServices;
  final bool openNow;

  /// "850 m" / "4.7 km".
  String get distanceLabel {
    final d = distanceM;
    if (d == null) return '';
    return d < 1000 ? '$d m' : '${(d / 1000).toStringAsFixed(1)} km';
  }
}

@immutable
class ServiceItem {
  const ServiceItem({
    required this.id,
    required this.name,
    this.description,
    required this.category,
    required this.serviceType,
    required this.price,
    required this.durationMin,
  });

  factory ServiceItem.fromJson(Map<String, dynamic> j) => ServiceItem(
    id: j.s('id'),
    name: j.s('name'),
    description: j.sn('description'),
    category: j.s('category'),
    serviceType: j.s('service_type'),
    price: Money.fromJson(j.m('price')),
    durationMin: j.i('duration_min'),
  );

  final String id;
  final String name;
  final String? description;
  final String category;
  final String serviceType;
  final Money price;
  final int durationMin;
}

@immutable
class StaffMember {
  const StaffMember({required this.id, required this.displayName, this.serviceIds});
  factory StaffMember.fromJson(Map<String, dynamic> j) =>
      StaffMember(id: j.s('id'), displayName: j.s('display_name'), serviceIds: j['service_ids'] == null ? null : j.ls('service_ids'));
  final String id;
  final String displayName;

  /// null = can do every service.
  final List<String>? serviceIds;
}

@immutable
class OpeningDay {
  const OpeningDay({required this.weekday, required this.windows, required this.breaks});

  factory OpeningDay.fromJson(Map<String, dynamic> j) => OpeningDay(
    weekday: j.i('weekday'),
    windows: j.l('windows').map((w) => TimeWindow(w.s('start'), w.s('end'))).toList(),
    breaks: j.l('breaks').map((w) => TimeWindow(w.s('start'), w.s('end'))).toList(),
  );

  /// 1 = Monday … 7 = Sunday (ISO).
  final int weekday;
  final List<TimeWindow> windows;
  final List<TimeWindow> breaks;
  bool get closed => windows.isEmpty;
}

@immutable
class TimeWindow {
  const TimeWindow(this.start, this.end);
  final String start;
  final String end;
  @override
  String toString() => '$start–$end';
}

/// Everything the provider page shows about one location.
@immutable
class LocationProfile {
  const LocationProfile({
    required this.locationId,
    required this.providerId,
    required this.name,
    required this.locationName,
    this.description,
    required this.address,
    required this.latitude,
    required this.longitude,
    required this.timezone,
    required this.rating,
    required this.openNow,
    required this.hours,
    required this.services,
    required this.staff,
  });

  factory LocationProfile.fromJson(Map<String, dynamic> j) => LocationProfile(
    locationId: j.s('location_id'),
    providerId: j.s('provider_id'),
    name: j.s('name'),
    locationName: j.s('location_name'),
    description: j.sn('description'),
    address: Address.fromJson(j.m('address')),
    latitude: j.d('latitude'),
    longitude: j.d('longitude'),
    timezone: j.s('timezone'),
    rating: Rating.fromJson(j.m('rating')),
    openNow: j.b('open_now'),
    hours: j.l('hours').map(OpeningDay.fromJson).toList(),
    services: j.l('services').map(ServiceItem.fromJson).toList(),
    staff: j.l('staff').map(StaffMember.fromJson).toList(),
  );

  final String locationId;
  final String providerId;
  final String name;
  final String locationName;
  final String? description;
  final Address address;
  final double latitude;
  final double longitude;
  final String timezone;
  final Rating rating;
  final bool openNow;
  final List<OpeningDay> hours;
  final List<ServiceItem> services;
  final List<StaffMember> staff;
}

/// A pin on the map (lighter than a [ProviderCard]).
@immutable
class MapPin {
  const MapPin({required this.locationId, required this.name, required this.latitude, required this.longitude, this.priceFrom});

  factory MapPin.fromJson(Map<String, dynamic> j) => MapPin(
    locationId: j.s('location_id'),
    name: j.s('name'),
    latitude: j.d('latitude'),
    longitude: j.d('longitude'),
    priceFrom: j.mn('price_from') == null ? null : Money.fromJson(j.m('price_from')),
  );

  final String locationId;
  final String name;
  final double latitude;
  final double longitude;
  final Money? priceFrom;
}
