import '../models/discovery.dart';
import '../models/json_helpers.dart';
import '../models/payments.dart';
import '../models/wallet.dart';
import '../net/api_client.dart';
import 'guard.dart';

/// The wallet and adding money to it.
class WalletRepository {
  WalletRepository(this._api);

  final ApiClient _api;

  Future<WalletBalance> balance() async {
    final json = await _api.get('/wallet');
    return parseResponse(() => WalletBalance.fromJson(json.m('data')));
  }

  Future<PagedResult<WalletEntry>> transactions({String? cursor, int limit = 30}) async {
    final json = await _api.get('/wallet/transactions', query: {'cursor': cursor, 'limit': limit});
    return parseResponse(() => PagedResult(json.l('data').map(WalletEntry.fromJson).toList(), json.mn('meta')?.sn('next_cursor')));
  }

  /// Starts adding [amountMinor] (paise). Nothing is credited yet. [idempotencyKey]: once per attempt, re-used on retries.
  Future<PaymentIntent> startTopUp(int amountMinor, {required String idempotencyKey}) async {
    final json = await _api.post('/payments/intents', idempotencyKey: idempotencyKey, body: {'amount_minor': amountMinor});
    return parseResponse(() => PaymentIntent.fromJson(json.m('data')));
  }

  /// "I came back from checkout — did it work?" The SERVER asks the payment provider (the app's own word is never
  /// used) and answers with the intent as the books now stand. Safe to call repeatedly.
  Future<PaymentIntent> verifyTopUp(String intentId) async {
    final json = await _api.post('/payments/intents/$intentId/verify');
    return parseResponse(() => PaymentIntent.fromJson(json.m('data')));
  }

  Future<PaymentIntent> topUp(String intentId) async {
    final json = await _api.get('/payments/intents/$intentId');
    return parseResponse(() => PaymentIntent.fromJson(json.m('data')));
  }
}
