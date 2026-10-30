import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';

/// The customer's wallet balance. Re-created when a different person signs in.
final walletBalanceProvider = FutureProvider.autoDispose<WalletBalance>((ref) {
  ref.watch(sessionUserProvider);
  return ref.watch(walletRepositoryProvider).balance();
});

@immutable
class StatementState {
  const StatementState(this.items, this.nextCursor, {this.loadingMore = false});
  final List<WalletEntry> items;
  final String? nextCursor;
  final bool loadingMore;
  bool get hasMore => nextCursor != null;
}

/// The wallet statement, newest first, loaded a page at a time.
class StatementNotifier extends AsyncNotifier<StatementState> {
  @override
  Future<StatementState> build() async {
    ref.watch(sessionUserProvider);
    final page = await ref.read(walletRepositoryProvider).transactions();
    return StatementState(page.items, page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(StatementState(current.items, current.nextCursor, loadingMore: true));
    try {
      final page = await ref.read(walletRepositoryProvider).transactions(cursor: current.nextCursor);
      state = AsyncData(StatementState([...current.items, ...page.items], page.nextCursor));
    } catch (_) {
      state = AsyncData(StatementState(current.items, current.nextCursor));
    }
  }
}

final statementProvider = AsyncNotifierProvider<StatementNotifier, StatementState>(StatementNotifier.new);

/// Call after anything that moves money (booking, cancellation, top-up) so the numbers on screen are the server's.
void refreshWallet(WidgetRef ref) {
  ref.invalidate(walletBalanceProvider);
  ref.invalidate(statementProvider);
}

/// The ledger records a hold or a release as TWO lines (one on "available", one on "held"). A customer thinks of it as one
/// event, so when both legs of the same posting are present only the "available" leg is shown (that is the number they can
/// spend). A leg with no partner on the available side, such as a held amount being settled to the salon, is kept.
List<WalletEntry> collapseMirrorLegs(List<WalletEntry> all) {
  String key(WalletEntry e) => '${e.type}|${e.bookingId}|${e.postedAt.microsecondsSinceEpoch}|${e.amount.minor}';
  final availableSide = {
    for (final e in all)
      if (!e.touchesHeld) key(e),
  };
  return [
    for (final e in all)
      if (!(e.touchesHeld && availableSide.contains(key(e)))) e,
  ];
}
