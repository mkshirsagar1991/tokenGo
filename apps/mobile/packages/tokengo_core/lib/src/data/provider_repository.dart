import '../models/booking.dart';
import '../models/discovery.dart';
import '../models/json_helpers.dart';
import '../models/provider_account.dart';
import '../net/api_client.dart';
import 'guard.dart';

/// Reasons a salon can give when it declines or cancels (the server's own codes).
abstract final class ProviderReason {
  static const unavailable = 'UNAVAILABLE';
  static const overbooked = 'OVERBOOKED';
  static const staffUnavailable = 'STAFF_UNAVAILABLE';
  static const closedThatDay = 'CLOSED_THAT_DAY';
  static const other = 'OTHER';

  static const all = [unavailable, overbooked, staffUnavailable, closedThatDay, other];

  static String label(String code) => switch (code) {
    unavailable => 'I am not available then',
    overbooked => 'Fully booked',
    staffUnavailable => 'Stylist not available',
    closedThatDay => 'Closed that day',
    _ => 'Other reason',
  };
}

/// Everything a salon owner or staff member does in the provider app. The server decides who may do what (permissions,
/// booking state); the app only asks, and shows what comes back.
class ProviderRepository {
  ProviderRepository(this._api);

  final ApiClient _api;

  // ---- the business -------------------------------------------------------------------------------------------------
  Future<List<ProviderAccount>> mine() async {
    final json = await _api.get('/providers/mine');
    return parseResponse(() => json.l('data').map(ProviderAccount.fromJson).toList());
  }

  // ---- bookings -----------------------------------------------------------------------------------------------------
  Future<PagedResult<Booking>> bookings(
    String providerId, {
    String? status,
    DateTime? from,
    DateTime? to,
    String? cursor,
    int limit = 30,
  }) async {
    final json = await _api.get(
      '/providers/$providerId/appointments',
      query: {
        'status': status,
        'from': from?.toUtc().toIso8601String(),
        'to': to?.toUtc().toIso8601String(),
        'cursor': cursor,
        'limit': limit,
      },
    );
    return parseResponse(() => PagedResult(json.l('data').map(Booking.fromJson).toList(), json.mn('meta')?.sn('next_cursor')));
  }

  Future<Booking> booking(String id) async {
    final json = await _api.get('/appointments/$id');
    return parseResponse(() => Booking.fromJson(json.m('data')));
  }

  Future<List<BookingEvent>> events(String id) async {
    final json = await _api.get('/appointments/$id/events');
    return parseResponse(() => json.l('data').map(BookingEvent.fromJson).toList());
  }

  Future<Booking> approve(String id) => _action(id, 'approve');

  Future<Booking> reject(String id, {required String reasonCode, String? note}) => _action(id, 'reject', body: _reason(reasonCode, note));

  /// Cancelling a confirmed booking refunds the customer in full.
  Future<Booking> cancel(String id, {required String reasonCode, String? note}) =>
      _action(id, 'provider-cancel', body: _reason(reasonCode, note));

  Future<Booking> markNoShow(String id) => _action(id, 'no-show');

  /// The customer shows a 6-digit PIN (or QR) at the venue; the server checks it. Never skip this by tapping "start".
  Future<Booking> verifyArrival(String id, {required String pin}) => _action(id, 'verify-arrival', body: {'pin': pin});

  /// QR variant of [verifyArrival] (the token inside the customer's QR code).
  Future<Booking> verifyArrivalQr(String id, {required String qrToken}) => _action(id, 'verify-arrival', body: {'qr_token': qrToken});

  Future<Booking> startService(String id) => _action(id, 'start');

  Future<Booking> completeService(String id) => _action(id, 'complete');

  Map<String, dynamic> _reason(String code, String? note) => {
    'reason_code': code,
    if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
  };

  Future<Booking> _action(String id, String action, {Map<String, dynamic>? body}) async {
    final json = await _api.post('/appointments/$id/$action', body: body ?? <String, dynamic>{});
    return parseResponse(() => Booking.fromJson(json.m('data')));
  }

  // ---- money --------------------------------------------------------------------------------------------------------
  Future<Earnings> earnings(String providerId) async {
    final json = await _api.get('/providers/$providerId/earnings');
    return parseResponse(() => Earnings.fromJson(json.m('data')));
  }

  Future<PagedResult<Payable>> payables(String providerId, {String? status, String? cursor, int limit = 20}) async {
    final json = await _api.get('/providers/$providerId/payables', query: {'status': status, 'cursor': cursor, 'limit': limit});
    return parseResponse(() => PagedResult(json.l('data').map(Payable.fromJson).toList(), json.mn('meta')?.sn('next_cursor')));
  }

  Future<PagedResult<Payout>> payouts(String providerId, {String? cursor, int limit = 20}) async {
    final json = await _api.get('/providers/$providerId/payouts', query: {'cursor': cursor, 'limit': limit});
    return parseResponse(() => PagedResult(json.l('data').map(Payout.fromJson).toList(), json.mn('meta')?.sn('next_cursor')));
  }

  Future<PayoutAccount?> payoutAccount(String providerId) async {
    final json = await _api.get('/providers/$providerId/payout-account');
    return parseResponse(() {
      final data = json.mn('data');
      return data == null ? null : PayoutAccount.fromJson(data);
    });
  }

  /// Sets (or replaces) the bank account. It is verified before anything is paid to it, and the number is never
  /// readable again from the API — only a masked version.
  Future<PayoutAccount> setPayoutAccount(
    String providerId, {
    required String holderName,
    required String accountNumber,
    required String ifsc,
  }) async {
    final json = await _api.put(
      '/providers/$providerId/payout-account',
      body: {'holder_name': holderName.trim(), 'account_number': accountNumber.trim(), 'ifsc': ifsc.trim().toUpperCase()},
    );
    return parseResponse(() => PayoutAccount.fromJson(json.m('data')));
  }
}
