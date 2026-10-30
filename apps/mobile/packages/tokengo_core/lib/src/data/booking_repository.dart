import '../models/booking.dart';
import '../models/discovery.dart';
import '../models/json_helpers.dart';
import '../net/api_client.dart';
import 'guard.dart';

/// A customer's bookings. The server prices the service, holds the money and reserves the slot in ONE step; the request
/// carries no amounts or statuses (it would be rejected if it did).
class BookingRepository {
  BookingRepository(this._api);

  final ApiClient _api;

  /// [idempotencyKey] must be generated ONCE per booking attempt and re-used on every retry of that attempt: a retry
  /// after a dropped connection then returns the same booking instead of creating (and charging for) a second one.
  Future<Booking> create({
    required String locationId,
    required List<String> serviceIds,
    required DateTime startAt,
    String? resourceId,
    String? note,
    required String idempotencyKey,
  }) async {
    final json = await _api.post(
      '/appointments',
      idempotencyKey: idempotencyKey,
      body: {
        'location_id': locationId,
        // one visit, one or more services: the server adds up the prices and the times
        'service_ids': serviceIds,
        'start_at': startAt.toUtc().toIso8601String(),
        'resource_id': ?resourceId,
        if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      },
    );
    return parseResponse(() => Booking.fromJson(json.m('data')));
  }

  Future<PagedResult<Booking>> list({String? status, String? cursor, int limit = 20}) async {
    final json = await _api.get('/appointments', query: {'status': status, 'cursor': cursor, 'limit': limit});
    return parseResponse(() => PagedResult(json.l('data').map(Booking.fromJson).toList(), json.mn('meta')?.sn('next_cursor')));
  }

  Future<Booking> get(String id) async {
    final json = await _api.get('/appointments/$id');
    return parseResponse(() => Booking.fromJson(json.m('data')));
  }

  Future<List<BookingEvent>> events(String id) async {
    final json = await _api.get('/appointments/$id/events');
    return parseResponse(() => json.l('data').map(BookingEvent.fromJson).toList());
  }

  /// PIN + QR to show at the venue. Only available once the salon confirmed, and only near the appointment time.
  Future<ArrivalCode> arrivalCode(String id) async {
    final json = await _api.get('/appointments/$id/arrival-code');
    return parseResponse(() => ArrivalCode.fromJson(json.m('data')));
  }

  Future<Booking> cancel(String id) async {
    final json = await _api.post('/appointments/$id/cancel', body: <String, dynamic>{});
    return parseResponse(() => Booking.fromJson(json.m('data')));
  }

  /// "The service was done" — releases the payment to the salon without waiting for the dispute window.
  Future<Booking> confirmCompletion(String id) async {
    final json = await _api.post('/appointments/$id/confirm-completion', body: <String, dynamic>{});
    return parseResponse(() => Booking.fromJson(json.m('data')));
  }
}
