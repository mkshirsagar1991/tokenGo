import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/session_manager.dart';
import '../data/auth_repository.dart';
import '../net/api_client.dart';
import '../push/device_registration.dart';
import '../push/push_service.dart';
import '../ui/brand.dart';

/// The session, loaded before the app starts (each app's main() overrides this).
final sessionManagerProvider = Provider<SessionManager>(
  (ref) => throw UnimplementedError('sessionManagerProvider must be overridden in main()'),
);

/// The API base URL, e.g. `http://10.0.2.2:3000/api/v1` (each app's main() overrides this from its build configuration).
final apiBaseUrlProvider = Provider<String>((ref) => throw UnimplementedError('apiBaseUrlProvider must be overridden in main()'));

/// The signed-in user's id, or null. Anything cached PER USER watches this so that signing out (or in as someone else)
/// can never show the previous person's data.
final sessionUserProvider = NotifierProvider<SessionUserNotifier, String?>(SessionUserNotifier.new);

class SessionUserNotifier extends Notifier<String?> {
  @override
  String? build() {
    final session = ref.watch(sessionManagerProvider);
    void onChange() => state = session.userId;
    session.addListener(onChange);
    ref.onDispose(() => session.removeListener(onChange));
    return session.userId;
  }
}

final apiClientProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(baseUrl: ref.watch(apiBaseUrlProvider), sessions: ref.watch(sessionManagerProvider));
  ref.onDispose(client.close);
  return client;
});

/// Registers this phone for the signed-in person's push notifications (and takes it back on sign-out).
final deviceRegistrationProvider = Provider<DeviceRegistration>(
  (ref) => DeviceRegistration(api: ref.watch(apiClientProvider), push: ref.watch(pushServiceProvider), app: ref.watch(brandAppProvider)),
);

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(
    ref.watch(apiClientProvider),
    ref.watch(sessionManagerProvider),
    beforeSignOut: () => ref.read(deviceRegistrationProvider).unregister(),
  ),
);
