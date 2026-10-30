import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';

/// What the booking screen asks availability for: one visit (one or more services) at one location, starting on [fromDate].
/// [serviceIds] is the ids joined with commas AND SORTED (see [serviceKey]): a plain list would never compare equal, and the screen
/// would ask the server again on every rebuild. The order does not change when the visit can happen, only what is booked.
typedef SlotsQuery = ({String locationId, String serviceIds, String fromDate});

/// The same key for the same set of services, whatever order they were ticked in.
String serviceKey(Iterable<String> serviceIds) => (serviceIds.toSet().toList()..sort()).join(',');

/// Open slots for the next two weeks. Advisory — the booking request re-checks the slot.
final slotsProvider = FutureProvider.autoDispose.family<SlotsResult, SlotsQuery>((ref, q) {
  return ref.watch(discoveryRepositoryProvider).slots(locationId: q.locationId, serviceIds: q.serviceIds.split(','), fromDate: q.fromDate, days: 14);
});

@immutable
class BookingsState {
  const BookingsState(this.items, this.nextCursor, {this.loadingMore = false});

  final List<Booking> items;
  final String? nextCursor;
  final bool loadingMore;
  bool get hasMore => nextCursor != null;

  /// Soonest first.
  List<Booking> get upcoming => items.where((b) => b.isActive).toList()..sort((a, b) => a.startAt.compareTo(b.startAt));

  /// Most recent first.
  List<Booking> get past => items.where((b) => !b.isActive).toList()..sort((a, b) => b.startAt.compareTo(a.startAt));
}

/// The customer's bookings, loaded a page at a time. Re-created when a different person signs in.
class BookingsNotifier extends AsyncNotifier<BookingsState> {
  @override
  Future<BookingsState> build() async {
    ref.watch(sessionUserProvider);
    final page = await ref.read(bookingRepositoryProvider).list(limit: 30);
    return BookingsState(page.items, page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(BookingsState(current.items, current.nextCursor, loadingMore: true));
    try {
      final page = await ref.read(bookingRepositoryProvider).list(cursor: current.nextCursor, limit: 30);
      state = AsyncData(BookingsState([...current.items, ...page.items], page.nextCursor));
    } catch (_) {
      state = AsyncData(BookingsState(current.items, current.nextCursor));
    }
  }
}

final bookingsProvider = AsyncNotifierProvider<BookingsNotifier, BookingsState>(BookingsNotifier.new);

final bookingProvider = FutureProvider.autoDispose.family<Booking, String>((ref, id) {
  ref.watch(sessionUserProvider);
  return ref.watch(bookingRepositoryProvider).get(id);
});

final bookingEventsProvider = FutureProvider.autoDispose.family<List<BookingEvent>, String>((ref, id) {
  ref.watch(sessionUserProvider);
  return ref.watch(bookingRepositoryProvider).events(id);
});

/// Call after anything that changes a booking so lists and details show the server's truth.
void refreshBookings(WidgetRef ref, {String? bookingId}) {
  ref.invalidate(bookingsProvider);
  if (bookingId != null) {
    ref.invalidate(bookingProvider(bookingId));
    ref.invalidate(bookingEventsProvider(bookingId));
  }
}
