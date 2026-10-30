import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';

void main() {
  group('providerRetry (a failed request must not keep the person staring at a spinner)', () {
    test('an ANSWER from the server is final: 409 "not yet", 404, 422, 500 are shown at once, never asked again', () {
      for (final status in [400, 401, 403, 404, 409, 422, 500, 503]) {
        final e = ApiException(status: status, code: 'X', message: 'm');
        expect(providerRetry(0, e), isNull, reason: 'HTTP $status');
      }
    });

    test('a phone that could not REACH the server tries twice more, quickly, then gives up', () {
      final offline = ApiException.network();
      final slow = ApiException.timeout();
      expect(providerRetry(0, offline), const Duration(milliseconds: 400));
      expect(providerRetry(1, offline), const Duration(milliseconds: 800));
      expect(providerRetry(2, offline), isNull);
      expect(providerRetry(0, slow), const Duration(milliseconds: 400));
    });

    test('programming errors and anything unknown are not retried', () {
      expect(providerRetry(0, StateError('bug')), isNull);
      expect(providerRetry(0, Exception('who knows')), isNull);
    });

    test('the longest a retried failure can keep a spinner up is about 1.2 seconds of waiting (it used to be about 40)', () {
      final offline = ApiException.network();
      var waited = Duration.zero;
      for (var i = 0; providerRetry(i, offline) != null; i++) {
        waited += providerRetry(i, offline)!;
      }
      expect(waited, lessThanOrEqualTo(const Duration(milliseconds: 1500)));
    });
  });
}
