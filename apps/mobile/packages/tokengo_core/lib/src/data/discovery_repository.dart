import '../models/booking.dart';
import '../models/discovery.dart';
import '../models/json_helpers.dart';
import '../net/api_client.dart';
import 'guard.dart';

/// Public discovery: categories, nearby search, provider profiles and availability. None of it needs a login, and the
/// customer's coordinates go out only as query parameters (the server does not store or log them).
class DiscoveryRepository {
  DiscoveryRepository(this._api);

  final ApiClient _api;

  Future<List<ServiceCategory>> categories() async {
    final json = await _api.get('/categories', auth: false);
    return parseResponse(() => json.l('data').map(ServiceCategory.fromJson).toList());
  }

  Future<PagedResult<ProviderCard>> search({
    required double lat,
    required double lng,
    int radiusMeters = 10000,
    String? category,
    String? serviceType,
    int? maxPriceMinor,
    double? minRating,
    bool? openNow,
    String sort = 'distance',
    int limit = 20,
    String? cursor,
  }) async {
    final json = await _api.get(
      '/search/providers',
      auth: false,
      query: {
        'lat': lat,
        'lng': lng,
        'radius_m': radiusMeters,
        'category': category,
        'service_type': serviceType,
        'max_price_minor': maxPriceMinor,
        'min_rating': minRating,
        'open_now': openNow,
        'sort': sort,
        'limit': limit,
        'cursor': cursor,
      },
    );
    return parseResponse(() => PagedResult(json.l('data').map(ProviderCard.fromJson).toList(), json.mn('meta')?.sn('next_cursor')));
  }

  /// Pins inside a map viewport: [west], [south], [east], [north].
  Future<List<MapPin>> mapPins({
    required double west,
    required double south,
    required double east,
    required double north,
    String? category,
  }) async {
    final json = await _api.get('/search/map', auth: false, query: {'bbox': '$west,$south,$east,$north', 'category': category});
    return parseResponse(() => json.l('data').map(MapPin.fromJson).toList());
  }

  Future<LocationProfile> profile(String locationId) async {
    final json = await _api.get('/locations/$locationId', auth: false);
    return parseResponse(() => LocationProfile.fromJson(json.m('data')));
  }

  /// Open slots for one visit of one or more services (the times and prices are added up), from [fromDate] ("YYYY-MM-DD", at the location) for [days] days. Advisory: the booking
  /// request re-checks the slot, so a slot someone else just took is refused cleanly there.
  Future<SlotsResult> slots({
    required String locationId,
    required List<String> serviceIds,
    required String fromDate,
    int days = 7,
    String? resourceId,
  }) async {
    final json = await _api.get(
      '/availability/slots',
      auth: false,
      query: {'location_id': locationId, 'service_ids': serviceIds.join(','), 'date': fromDate, 'days': days, 'resource_id': resourceId},
    );
    return parseResponse(() => SlotsResult.fromJson(json.m('data')));
  }
}
