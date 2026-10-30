import '../net/api_exception.dart';

/// Runs [parse] over a decoded response. A malformed body (missing field, wrong type) becomes an [ApiException] the UI
/// already knows how to show, instead of a crash on some screen.
T parseResponse<T>(T Function() parse) {
  try {
    return parse();
  } on FormatException {
    throw ApiException.badResponse(200);
  } on TypeError {
    throw ApiException.badResponse(200);
  }
}
