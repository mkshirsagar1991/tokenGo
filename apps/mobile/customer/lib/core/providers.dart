import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

// The session, API client and auth repository are shared with the provider app (see tokengo_core). Re-exported here so
// the customer features keep one import for "the app's providers".
export 'package:tokengo_core/tokengo_core.dart'
    show apiBaseUrlProvider, apiClientProvider, authRepositoryProvider, sessionManagerProvider, sessionUserProvider;

final discoveryRepositoryProvider = Provider<DiscoveryRepository>((ref) => DiscoveryRepository(ref.watch(apiClientProvider)));
final bookingRepositoryProvider = Provider<BookingRepository>((ref) => BookingRepository(ref.watch(apiClientProvider)));
final walletRepositoryProvider = Provider<WalletRepository>((ref) => WalletRepository(ref.watch(apiClientProvider)));
