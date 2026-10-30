import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import '../business/business_state.dart';

/// Earnings summary for the current business (null when there is no approved business yet).
final earningsProvider = FutureProvider.autoDispose<Earnings?>((ref) async {
  ref.watch(sessionUserProvider);
  final business = await ref.watch(currentBusinessProvider.future);
  if (business == null || !business.isApproved) return null;
  return ref.watch(providerRepositoryProvider).earnings(business.id);
});

@immutable
class PagedList<T> {
  const PagedList(this.items, this.nextCursor, {this.loadingMore = false});
  final List<T> items;
  final String? nextCursor;
  final bool loadingMore;
  bool get hasMore => nextCursor != null;
}

class PayoutsNotifier extends AsyncNotifier<PagedList<Payout>> {
  @override
  Future<PagedList<Payout>> build() async {
    ref.watch(sessionUserProvider);
    final business = await ref.watch(currentBusinessProvider.future);
    if (business == null || !business.isApproved) return const PagedList([], null);
    final page = await ref.read(providerRepositoryProvider).payouts(business.id);
    return PagedList(page.items, page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null) return;
    state = AsyncData(PagedList(current.items, current.nextCursor, loadingMore: true));
    try {
      final page = await ref.read(providerRepositoryProvider).payouts(business.id, cursor: current.nextCursor);
      state = AsyncData(PagedList([...current.items, ...page.items], page.nextCursor));
    } catch (_) {
      state = AsyncData(PagedList(current.items, current.nextCursor));
    }
  }
}

final payoutsProvider = AsyncNotifierProvider<PayoutsNotifier, PagedList<Payout>>(PayoutsNotifier.new);

class PayablesNotifier extends AsyncNotifier<PagedList<Payable>> {
  @override
  Future<PagedList<Payable>> build() async {
    ref.watch(sessionUserProvider);
    final business = await ref.watch(currentBusinessProvider.future);
    if (business == null || !business.isApproved) return const PagedList([], null);
    final page = await ref.read(providerRepositoryProvider).payables(business.id);
    return PagedList(page.items, page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null) return;
    state = AsyncData(PagedList(current.items, current.nextCursor, loadingMore: true));
    try {
      final page = await ref.read(providerRepositoryProvider).payables(business.id, cursor: current.nextCursor);
      state = AsyncData(PagedList([...current.items, ...page.items], page.nextCursor));
    } catch (_) {
      state = AsyncData(PagedList(current.items, current.nextCursor));
    }
  }
}

final payablesProvider = AsyncNotifierProvider<PayablesNotifier, PagedList<Payable>>(PayablesNotifier.new);

void refreshEarnings(WidgetRef ref) {
  ref.invalidate(earningsProvider);
  ref.invalidate(payoutsProvider);
  ref.invalidate(payablesProvider);
}
