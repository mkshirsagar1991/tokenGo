import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../features/bookings/bookings_state.dart';
import '../features/earnings/earnings_state.dart';
import 'router.dart';

/// A notification arrived (or the app came back to the front): show the server's current truth.
void refreshForPush(WidgetRef ref, PushMessage? message) {
  refreshBookings(ref, bookingId: message?.bookingId);
  ref.invalidate(earningsProvider);
  ref.invalidate(payoutsProvider);
  ref.invalidate(payablesProvider);
}

/// Opens the screen a notification is about.
void openFromPush(WidgetRef ref, PushMessage message) {
  final router = ref.read(routerProvider);
  final bookingId = message.bookingId;
  if (bookingId != null) {
    router.push('/booking/$bookingId');
  } else if (message.kind.startsWith('BANK_ACCOUNT')) {
    router.push('/earnings/bank-account');
  }
}
