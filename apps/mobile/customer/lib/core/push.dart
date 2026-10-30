import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../features/booking/booking_state.dart';
import '../features/wallet/wallet_state.dart';
import 'router.dart';

/// A notification arrived (or the app came back to the front): show the server's current truth. A booking change can also move
/// money (a refund, a released hold), so the wallet is refreshed with it.
void refreshForPush(WidgetRef ref, PushMessage? message) {
  refreshBookings(ref, bookingId: message?.bookingId);
  refreshWallet(ref);
}

/// Opens the screen a notification is about.
void openFromPush(WidgetRef ref, PushMessage message) {
  final router = ref.read(routerProvider);
  final bookingId = message.bookingId;
  if (bookingId != null) {
    router.go('/bookings/$bookingId');
  } else if (message.kind.startsWith('WALLET') || message.kind.startsWith('REFUND')) {
    router.go('/wallet');
  }
}
