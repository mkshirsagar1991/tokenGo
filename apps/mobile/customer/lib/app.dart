import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'core/push.dart';
import 'core/router.dart';

class TokenGoApp extends ConsumerWidget {
  const TokenGoApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'TokenGo',
      debugShowCheckedModeBanner: false,
      theme: TokenGoTheme.light(),
      darkTheme: TokenGoTheme.dark(),
      routerConfig: ref.watch(routerProvider),
      // Push notifications: register this phone, refresh what is on screen when something changes, open the right booking on a tap.
      builder: (context, child) => PushListener(onRefresh: refreshForPush, onOpen: openFromPush, child: child ?? const SizedBox.shrink()),
    );
  }
}
