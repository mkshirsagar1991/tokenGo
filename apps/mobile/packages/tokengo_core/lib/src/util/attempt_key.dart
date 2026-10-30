import 'dart:convert';

import 'package:uuid/uuid.dart';

/// The `Idempotency-Key` for ONE attempt at creating something (ADR-0014): generated once and re-sent on every retry of the
/// same request, so a dropped connection after the server committed cannot create a second business, location or service.
/// The key is renewed as soon as the request body changes — the server refuses a reused key with a different body, and a
/// changed form is a new intent.
class AttemptKey {
  AttemptKey({String Function()? generate}) : _generate = generate ?? (() => const Uuid().v4());

  final String Function() _generate;
  String? _key;
  String? _fingerprint;

  /// The key for [body]: the same as last time while the body is unchanged, a fresh one otherwise.
  String keyFor(Object? body) {
    final fingerprint = jsonEncode(body);
    if (_key == null || fingerprint != _fingerprint) {
      _key = _generate();
      _fingerprint = fingerprint;
    }
    return _key!;
  }

  /// Forget the key (after the server confirmed the request, so the next create is a new intent).
  void reset() {
    _key = null;
    _fingerprint = null;
  }
}
