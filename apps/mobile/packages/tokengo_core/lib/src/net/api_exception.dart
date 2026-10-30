/// Everything that can go wrong talking to the TokenGo API, in one type the UI can reason about.
///
/// The server answers failures as RFC 7807 problem+json with a STABLE machine `code` (docs §O.1). Screens branch on
/// [code] — never on the message text — and show [userMessage] otherwise.
class ApiException implements Exception {
  const ApiException({
    required this.status,
    required this.code,
    required this.message,
    this.fields = const {},
    this.details = const {},
    this.requestId,
  });

  /// HTTP status, or 0 when the request never completed (no network, timeout, bad response).
  final int status;
  final String code;
  final String message;

  /// Per-field validation messages (`errors.fields`), e.g. `{'phone': ['must be ...']}`.
  final Map<String, List<String>> fields;

  /// Extra machine-readable context, e.g. `shortfall` for INSUFFICIENT_FUNDS.
  final Map<String, dynamic> details;
  final String? requestId;

  static const networkCode = 'NETWORK_ERROR';
  static const timeoutCode = 'TIMEOUT';
  static const badResponseCode = 'BAD_RESPONSE';

  factory ApiException.network([String? message]) =>
      ApiException(status: 0, code: networkCode, message: message ?? 'Could not reach the server');

  factory ApiException.timeout() => const ApiException(status: 0, code: timeoutCode, message: 'The server took too long to answer');

  factory ApiException.badResponse(int status) =>
      ApiException(status: status, code: badResponseCode, message: 'The server sent an unexpected response');

  /// Builds an exception from a decoded problem+json body (tolerant: any field may be missing).
  factory ApiException.fromProblem(int status, Map<String, dynamic> body) {
    final errors = body['errors'];
    final fields = <String, List<String>>{};
    var details = <String, dynamic>{};
    if (errors is Map<String, dynamic>) {
      details = errors;
      final f = errors['fields'];
      if (f is Map) {
        f.forEach((k, v) {
          if (v is List) fields['$k'] = v.map((e) => '$e').toList();
        });
      }
    }
    return ApiException(
      status: status,
      code: (body['code'] as String?) ?? 'HTTP_$status',
      message: (body['detail'] as String?) ?? (body['title'] as String?) ?? 'Request failed',
      fields: fields,
      details: details,
      requestId: (body['request_id'] ?? body['requestId']) as String?,
    );
  }

  bool get isNetwork => code == networkCode || code == timeoutCode;
  bool get isUnauthenticated => status == 401;
  bool get isForbidden => status == 403;
  bool get isNotFound => status == 404;
  bool get isConflict => status == 409;
  bool get isValidation => status == 422;
  bool get isServerError => status >= 500;

  /// Something a person can read. Never includes ids or stack traces.
  String get userMessage {
    if (isNetwork) return 'No connection. Check your internet and try again.';
    if (isServerError) return 'Something went wrong on our side. Please try again in a moment.';
    return message;
  }

  @override
  String toString() => 'ApiException($status $code: $message)';
}
