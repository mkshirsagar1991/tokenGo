import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import '../business/business_state.dart';

/// What needs doing now and what is coming up: pending requests first, then the active schedule by start time.
@immutable
class Schedule {
  const Schedule({required this.requests, required this.active});

  /// Waiting for this business to accept or decline (oldest deadline first).
  final List<Booking> requests;

  /// Accepted and in progress: confirmed, arrived, started, finished-but-unconfirmed (soonest first).
  final List<Booking> active;

  bool get isEmpty => requests.isEmpty && active.isEmpty;
}

Schedule buildSchedule(Iterable<Booking> bookings) {
  final requests = bookings.where((b) => b.status == BookingStatus.requested).toList()
    ..sort((a, b) => (a.responseDeadlineAt ?? a.startAt).compareTo(b.responseDeadlineAt ?? b.startAt));
  const activeStatuses = {
    BookingStatus.confirmed,
    BookingStatus.customerArrived,
    BookingStatus.serviceStarted,
    BookingStatus.serviceCompleted,
  };
  final active = bookings.where((b) => activeStatuses.contains(b.status)).toList()..sort((a, b) => a.startAt.compareTo(b.startAt));
  return Schedule(requests: requests, active: active);
}

/// Bookings from yesterday onwards (so one that started late last night and is still in progress does not vanish at midnight),
/// newest-created first, up to three pages. [truncated] = there were more than that, so counts are "at least".
@immutable
class BookingsWindow {
  const BookingsWindow(this.items, {this.truncated = false});
  final List<Booking> items;
  final bool truncated;
}

final bookingsWindowProvider = FutureProvider.autoDispose<BookingsWindow>((ref) async {
  ref.watch(sessionUserProvider);
  final business = await ref.watch(currentBusinessProvider.future);
  if (business == null || !business.isApproved) return const BookingsWindow([]);
  final repo = ref.watch(providerRepositoryProvider);
  final from = DateTime.now().subtract(const Duration(hours: 30));
  final items = <Booking>[];
  String? cursor;
  for (var page = 0; page < 3; page++) {
    final result = await repo.bookings(business.id, from: from, limit: 50, cursor: cursor);
    items.addAll(result.items);
    cursor = result.nextCursor;
    if (cursor == null) break;
  }
  return BookingsWindow(items, truncated: cursor != null);
});

/// The business's current work. Re-created when a different person signs in.
final scheduleProvider = FutureProvider.autoDispose<Schedule>((ref) async {
  final window = await ref.watch(bookingsWindowProvider.future);
  return buildSchedule(window.items);
});

/// The Today dashboard's numbers, derived from the same bookings.
@immutable
class Dashboard {
  const Dashboard({
    required this.requests,
    required this.today,
    required this.upcoming,
    required this.completedToday,
    this.truncated = false,
  });

  /// Waiting for this business to accept or decline (most urgent first).
  final List<Booking> requests;

  /// On today's calendar AT THE LOCATION (plus anything still in progress from before midnight), soonest first.
  final List<Booking> today;

  /// Accepted, starting after today.
  final List<Booking> upcoming;

  /// Today's services that are done (awaiting the customer, or closed).
  final List<Booking> completedToday;
  final bool truncated;

  /// What today's finished services were worth BEFORE TokenGo's commission. Display only: the server owns what is earned
  /// (see the earnings card for that).
  Money get completedValue => completedToday.fold(Money.zero, (sum, b) => sum + b.price);

  bool get isEmpty => requests.isEmpty && today.isEmpty && upcoming.isEmpty;
}

/// [now] is injectable for tests. "Today" is each booking's OWN location date (its time zone), never the phone's.
Dashboard buildDashboard(Iterable<Booking> bookings, {DateTime? now, bool truncated = false}) {
  final at = now ?? DateTime.now();
  const onTodayList = {
    BookingStatus.confirmed,
    BookingStatus.customerArrived,
    BookingStatus.serviceStarted,
    BookingStatus.serviceCompleted,
    BookingStatus.closed,
  };
  const done = {BookingStatus.serviceCompleted, BookingStatus.closed};
  const inProgress = {BookingStatus.customerArrived, BookingStatus.serviceStarted};
  final requests = buildSchedule(bookings).requests;
  final today = <Booking>[];
  final upcoming = <Booking>[];
  for (final b in bookings) {
    final localToday = todayIn(b.timezone, now: at);
    if (onTodayList.contains(b.status) && (b.localDate == localToday || inProgress.contains(b.status))) today.add(b);
    if (b.status == BookingStatus.confirmed && b.localDate.compareTo(localToday) > 0) upcoming.add(b);
  }
  today.sort((a, b) => a.startAt.compareTo(b.startAt));
  upcoming.sort((a, b) => a.startAt.compareTo(b.startAt));
  return Dashboard(
    requests: requests,
    today: today,
    upcoming: upcoming,
    completedToday: today.where((b) => done.contains(b.status)).toList(),
    truncated: truncated,
  );
}

final dashboardProvider = FutureProvider.autoDispose<Dashboard>((ref) async {
  final window = await ref.watch(bookingsWindowProvider.future);
  return buildDashboard(window.items, truncated: window.truncated);
});

/// One booking, fresh from the server (the detail screen refreshes it after every action).
final bookingProvider = FutureProvider.autoDispose.family<Booking, String>((ref, id) {
  ref.watch(sessionUserProvider);
  return ref.watch(providerRepositoryProvider).booking(id);
});

/// Which status the history list is filtered to (null = everything).
class HistoryFilter extends Notifier<String?> {
  @override
  String? build() => null;

  void choose(String? status) => state = status;
}

final historyFilterProvider = NotifierProvider<HistoryFilter, String?>(HistoryFilter.new);

@immutable
class HistoryState {
  const HistoryState(this.items, this.nextCursor, {this.loadingMore = false});
  final List<Booking> items;
  final String? nextCursor;
  final bool loadingMore;
  bool get hasMore => nextCursor != null;
}

/// Every booking, newest first, loaded a page at a time.
class HistoryNotifier extends AsyncNotifier<HistoryState> {
  @override
  Future<HistoryState> build() async {
    ref.watch(sessionUserProvider);
    final status = ref.watch(historyFilterProvider);
    final business = await ref.watch(currentBusinessProvider.future);
    if (business == null || !business.isApproved) return const HistoryState([], null);
    final page = await ref.read(providerRepositoryProvider).bookings(business.id, status: status);
    return HistoryState(page.items, page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null) return;
    state = AsyncData(HistoryState(current.items, current.nextCursor, loadingMore: true));
    try {
      final page = await ref
          .read(providerRepositoryProvider)
          .bookings(business.id, status: ref.read(historyFilterProvider), cursor: current.nextCursor);
      state = AsyncData(HistoryState([...current.items, ...page.items], page.nextCursor));
    } catch (_) {
      state = AsyncData(HistoryState(current.items, current.nextCursor));
    }
  }
}

final historyProvider = AsyncNotifierProvider<HistoryNotifier, HistoryState>(HistoryNotifier.new);

/// After any change to a booking, make every list show the server's truth.
void refreshBookings(WidgetRef ref, {String? bookingId}) {
  ref.invalidate(bookingsWindowProvider);
  ref.invalidate(historyProvider);
  if (bookingId != null) ref.invalidate(bookingProvider(bookingId));
}
