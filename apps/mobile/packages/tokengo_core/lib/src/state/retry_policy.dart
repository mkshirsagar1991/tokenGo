import '../net/api_exception.dart';

/// How a failed request is retried (give it to each app's `ProviderScope(retry: providerRetry)`).
///
/// Riverpod 3 re-asks a failed request up to TEN times, waiting longer each time (about 40 seconds in all), and shows the loading
/// spinner the whole time. For this app that is wrong: when the server has answered, even with "not yet" or "not found", asking again
/// five seconds later changes nothing, and the person stares at a spinner. So:
///  * the server ANSWERED (any HTTP status): no retry, the answer is shown at once;
///  * the phone could not REACH the server (no network, timeout): two quick retries, then the error with its "Try again" button.
Duration? providerRetry(int retryCount, Object error) {
  if (retryCount >= 2) return null;
  if (error is ApiException && error.isNetwork) return Duration(milliseconds: 400 * (retryCount + 1));
  return null;
}
