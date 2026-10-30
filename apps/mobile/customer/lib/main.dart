import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'app.dart';
import 'config/app_config.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Read the saved session BEFORE the first frame so a signed-in person never sees a flash of the signed-out app.
  final session = SessionManager(SecureTokenStore());
  await session.load();
  runApp(
    ProviderScope(
      retry: providerRetry, // a failed request is shown at once unless the phone could not reach the server (see retry_policy.dart)
      overrides: [
        sessionManagerProvider.overrideWithValue(session),
        apiBaseUrlProvider.overrideWithValue(AppConfig.apiBaseUrl),
        pushServiceProvider.overrideWithValue(FirebasePushService()), // push only starts if the app was built with google-services.json
      ],
      child: const TokenGoApp(),
    ),
  );
}
