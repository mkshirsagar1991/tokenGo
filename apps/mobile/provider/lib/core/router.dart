import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../features/account/account_screen.dart';
import '../features/bookings/booking_detail_screen.dart';
import '../features/business/business_screens.dart';
import '../features/business/hours_screens.dart';
import '../features/business/locations_screens.dart';
import '../features/business/policy_screen.dart';
import '../features/business/services_screens.dart';
import '../features/business/staff_screens.dart';
import '../features/business/time_off_screens.dart';
import '../features/bookings/history_screen.dart';
import '../features/bookings/today_screen.dart';
import '../features/earnings/bank_account_screen.dart';
import '../features/earnings/earnings_screen.dart';

final _rootKey = GlobalKey<NavigatorState>(debugLabel: 'root');

/// The provider app is for signed-in business users only: everything except sign-in sends a signed-out person to sign in,
/// and a signed-in person never sees the sign-in screens.
final routerProvider = Provider<GoRouter>((ref) {
  final session = ref.watch(sessionManagerProvider);
  final router = GoRouter(
    navigatorKey: _rootKey,
    initialLocation: '/',
    refreshListenable: session,
    redirect: (context, state) {
      final onLogin = state.uri.path.startsWith('/login');
      if (!session.isSignedIn) return onLogin ? null : '/login';
      if (onLogin) return '/';
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        parentNavigatorKey: _rootKey,
        builder: (context, _) => PhoneScreen(
          heading: 'TokenGo Business',
          blurb: 'Sign in with the mobile number registered for your business. We will send you a 6-digit code on WhatsApp.',
          footnote: 'Customers use the TokenGo app. This app is for salon owners and staff.',
          onCodeSent: (phone) => context.push('/login/verify?phone=$phone'),
        ),
      ),
      GoRoute(
        path: '/login/verify',
        parentNavigatorKey: _rootKey,
        builder: (context, s) => OtpScreen(
          phone: s.uri.queryParameters['phone'] ?? '',
          onChangeNumber: () => context.pop(),
          // Explicit: a router redirect is not re-run for screens opened with push.
          onSignedIn: () => context.go('/'),
        ),
      ),
      GoRoute(
        path: '/booking/:bookingId',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => BookingDetailScreen(bookingId: s.pathParameters['bookingId']!),
      ),
      GoRoute(path: '/earnings/bank-account', parentNavigatorKey: _rootKey, builder: (_, _) => const BankAccountScreen()),
      // Business setup: full-screen pages opened with `push` (from Today's checklist or the Business tab), so Back always returns
      // to where the owner came from. `new` routes come before their `:id` siblings.
      GoRoute(path: '/register', parentNavigatorKey: _rootKey, builder: (_, _) => const RegisterScreen()),
      GoRoute(path: '/manage/profile', parentNavigatorKey: _rootKey, builder: (_, _) => const ProfileScreen()),
      GoRoute(path: '/manage/policy', parentNavigatorKey: _rootKey, builder: (_, _) => const PolicyScreen()),
      GoRoute(path: '/manage/locations', parentNavigatorKey: _rootKey, builder: (_, _) => const LocationsScreen()),
      GoRoute(path: '/manage/locations/new', parentNavigatorKey: _rootKey, builder: (_, _) => const LocationFormScreen()),
      GoRoute(
        path: '/manage/locations/:id',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => LocationFormScreen(locationId: s.pathParameters['id']),
      ),
      GoRoute(
        path: '/manage/locations/:id/hours',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => LocationHoursScreen(locationId: s.pathParameters['id']!),
      ),
      GoRoute(
        path: '/manage/locations/:id/time-off',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => TimeOffScreen.location(locationId: s.pathParameters['id']!),
      ),
      GoRoute(path: '/manage/services', parentNavigatorKey: _rootKey, builder: (_, _) => const ServicesScreen()),
      GoRoute(path: '/manage/services/new', parentNavigatorKey: _rootKey, builder: (_, _) => const ServiceFormScreen()),
      GoRoute(
        path: '/manage/services/:id',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => ServiceFormScreen(serviceId: s.pathParameters['id']),
      ),
      GoRoute(path: '/manage/staff', parentNavigatorKey: _rootKey, builder: (_, _) => const StaffScreen()),
      GoRoute(path: '/manage/staff/new', parentNavigatorKey: _rootKey, builder: (_, _) => const StaffFormScreen()),
      GoRoute(
        path: '/manage/staff/:id',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => StaffDetailScreen(staffId: s.pathParameters['id']!),
      ),
      GoRoute(
        path: '/manage/staff/:id/schedule',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => StaffScheduleScreen(staffId: s.pathParameters['id']!),
      ),
      GoRoute(
        path: '/manage/staff/:id/time-off',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => TimeOffScreen.staff(staffId: s.pathParameters['id']!),
      ),
      GoRoute(
        path: '/manage/staff/:id/blocks',
        parentNavigatorKey: _rootKey,
        builder: (_, s) => BlocksScreen(staffId: s.pathParameters['id']!),
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => _HomeShell(shell: shell),
        branches: [
          StatefulShellBranch(
            routes: [GoRoute(path: '/', builder: (_, _) => const TodayScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/bookings', builder: (_, _) => const HistoryScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/earnings', builder: (_, _) => const EarningsScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/business', builder: (_, _) => const BusinessHubScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/account', builder: (_, _) => const AccountScreen())],
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
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today_rounded), label: 'Today'),
          NavigationDestination(icon: Icon(Icons.event_note_outlined), selectedIcon: Icon(Icons.event_note_rounded), label: 'Bookings'),
          NavigationDestination(
            icon: Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: Icon(Icons.account_balance_wallet_rounded),
            label: 'Earnings',
          ),
          NavigationDestination(icon: Icon(Icons.storefront_outlined), selectedIcon: Icon(Icons.storefront_rounded), label: 'Business'),
          NavigationDestination(icon: Icon(Icons.person_outline_rounded), selectedIcon: Icon(Icons.person_rounded), label: 'Account'),
        ],
      ),
    );
  }
}
