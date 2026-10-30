import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../features/booking/booking_detail_screen.dart';
import '../features/booking/booking_flow_screen.dart';
import '../features/booking/bookings_screen.dart';
import '../features/discover/discover_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/provider/provider_detail_screen.dart';
import '../features/wallet/wallet_screen.dart';

final _rootKey = GlobalKey<NavigatorState>(debugLabel: 'root');

/// Only ever return to a place INSIDE the app: `from` comes from a query string, so it is not trusted.
@visibleForTesting
String? safeReturnPath(String? from) {
  if (from == null || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/login')) return null;
  return from;
}

/// After signing in: close the two sign-in screens and land back on the very page the person tapped "sign in" from (the booking
/// screen, Profile, Wallet…), now signed in. The page underneath is still alive, so everything they had chosen (services, day,
/// time, stylist, note) is exactly as they left it: `go(from)` would REBUILD that page from its address and lose all of it.
/// [from] is only the fallback for when there is nothing to return to (the sign-in screen was opened directly).
/// This is done explicitly because a router `redirect` is NOT re-evaluated for screens opened with `push`: relying on it left
/// people stuck on the code screen.
@visibleForTesting
void leaveSignIn(GoRouter router, String? from) {
  var closed = 0;
  while (closed < 2 && router.canPop()) {
    router.pop();
    closed++;
  }
  if (closed == 0) router.go(from ?? '/');
}

final routerProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(
    navigatorKey: _rootKey,
    initialLocation: '/',
    routes: [
      GoRoute(
        path: '/login',
        parentNavigatorKey: _rootKey,
        builder: (context, s) {
          final from = s.uri.queryParameters['from'];
          return PhoneScreen(
            heading: 'Welcome to TokenGo',
            blurb: 'Enter your mobile number. We will send you a 6-digit code on WhatsApp to sign in or create your account.',
            footnote: 'By continuing you agree to receive a one-time code on WhatsApp. We never share your number with salons until you book.',
            showBack: true,
            onCodeSent: (phone) =>
                context.push('/login/verify?phone=$phone${from == null ? '' : '&from=${Uri.encodeQueryComponent(from)}'}'),
          );
        },
      ),
      GoRoute(
        path: '/login/verify',
        parentNavigatorKey: _rootKey,
        builder: (context, s) {
          final from = safeReturnPath(s.uri.queryParameters['from']);
          return OtpScreen(
            phone: s.uri.queryParameters['phone'] ?? '',
            onChangeNumber: () => context.pop(),
            onSignedIn: () => leaveSignIn(GoRouter.of(context), from),
          );
        },
      ),
      GoRoute(
        path: '/add-money',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => WalletScreen(suggestedTopUpMinor: int.tryParse(s.uri.queryParameters['amount'] ?? '') ?? 0),
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => _HomeShell(shell: shell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/',
                builder: (_, _) => const DiscoverScreen(),
                routes: [
                  // Full-screen pages that sit above the tab bar, but keep "home" underneath so Back always has somewhere to go.
                  GoRoute(
                    path: 'provider/:locationId',
                    parentNavigatorKey: _rootKey,
                    builder: (_, s) => ProviderDetailScreen(locationId: s.pathParameters['locationId']!),
                  ),
                  GoRoute(
                    path: 'book/:locationId',
                    parentNavigatorKey: _rootKey,
                    builder: (_, s) => BookingFlowScreen(
                      locationId: s.pathParameters['locationId']!,
                      // `services=a,b,c` (several ticked on the salon page), or the older `service=a`
                      initialServiceIds: [
                        ...?s.uri.queryParameters['services']?.split(','),
                        ?s.uri.queryParameters['service'],
                      ].where((id) => id.isNotEmpty).toList(),
                    ),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/bookings',
                builder: (_, _) => const BookingsScreen(),
                routes: [
                  // A booking opens above the tab bar but UNDER the Bookings tab: Back always returns to "My bookings",
                  // including right after a new booking (which navigates here with `go`).
                  GoRoute(
                    path: ':bookingId',
                    parentNavigatorKey: _rootKey,
                    builder: (_, s) =>
                        BookingDetailScreen(bookingId: s.pathParameters['bookingId']!, justCreated: s.uri.queryParameters['new'] == '1'),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/wallet', builder: (_, _) => const WalletScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/profile', builder: (_, _) => const ProfileScreen())],
          ),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});

class _HomeShell extends StatelessWidget {
  const _HomeShell({required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        // Tapping the tab you are already on returns to its first screen.
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.search_rounded), selectedIcon: Icon(Icons.search_rounded), label: 'Discover'),
          NavigationDestination(icon: Icon(Icons.event_note_outlined), selectedIcon: Icon(Icons.event_note_rounded), label: 'Bookings'),
          NavigationDestination(
            icon: Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: Icon(Icons.account_balance_wallet_rounded),
            label: 'Wallet',
          ),
          NavigationDestination(icon: Icon(Icons.person_outline_rounded), selectedIcon: Icon(Icons.person_rounded), label: 'Profile'),
        ],
      ),
    );
  }
}
