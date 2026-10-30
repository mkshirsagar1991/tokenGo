import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'config/app_config.dart';
import 'core/push.dart';
import 'core/router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Read the saved session BEFORE the first frame so a signed-in person never sees a flash of the sign-in screen.
  final session = SessionManager(SecureTokenStore());
  await session.load();
  runApp(
    ProviderScope(
      retry: providerRetry, // a failed request is shown at once unless the phone could not reach the server (see retry_policy.dart)
      overrides: [
        sessionManagerProvider.overrideWithValue(session),
        apiBaseUrlProvider.overrideWithValue(AppConfig.apiBaseUrl),
        brandAppProvider.overrideWithValue(BrandApp.business), // the orange shop-front logo, icon and loader
        pushServiceProvider.overrideWithValue(FirebasePushService()), // push only starts if the app was built with google-services.json
      ],
      child: const TokenGoBusinessApp(),
    ),
  );
}

class TokenGoBusinessApp extends ConsumerWidget {
  const TokenGoBusinessApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'TokenGo Business',
      debugShowCheckedModeBanner: false,
      theme: TokenGoTheme.light(seed: TokenGoTheme.providerSeed),
      darkTheme: TokenGoTheme.dark(seed: TokenGoTheme.providerSeed),
      routerConfig: ref.watch(routerProvider),
      // Push notifications: register this phone, refresh what is on screen when something changes, open the right booking on a tap.
      builder: (context, child) => PushListener(onRefresh: refreshForPush, onOpen: openFromPush, child: child ?? const SizedBox.shrink()),
    );
  }
}
