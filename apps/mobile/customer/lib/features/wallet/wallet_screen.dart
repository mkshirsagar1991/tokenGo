import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'top_up_sheet.dart';
import 'wallet_state.dart';

/// The wallet: what you can spend, what is reserved for bookings, and every movement.
class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key, this.suggestedTopUpMinor});

  /// Set when the person arrived here because a booking needs more money than they have: the sheet opens by itself.
  final int? suggestedTopUpMinor;

  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  bool _autoOpened = false;

  @override
  void initState() {
    super.initState();
    if (widget.suggestedTopUpMinor != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _autoOpened) return;
        _autoOpened = true;
        if (ref.read(sessionUserProvider) != null) TopUpSheet.show(context, suggestedMinor: widget.suggestedTopUpMinor!);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = ref.watch(sessionUserProvider) != null;
    if (!signedIn) {
      return Scaffold(
        appBar: AppBar(title: const Text('Wallet')),
        body: SignInPrompt(
          title: 'Your wallet',
          message: 'Sign in to add money and pay for bookings.',
          onSignIn: () => context.push('/login'),
        ),
      );
    }
    final balance = ref.watch(walletBalanceProvider);
    final statement = ref.watch(statementProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: RefreshIndicator(
        onRefresh: () async {
          refreshWallet(ref);
          await Future.wait([ref.read(walletBalanceProvider.future), ref.read(statementProvider.future)]);
        },
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(Gap.lg),
                child: balance.when(
                  loading: () => const _BalanceCard.loading(),
                  error: (e, _) => SizedBox(
                    height: 220,
                    child: ErrorState(error: e, onRetry: () => ref.invalidate(walletBalanceProvider)),
                  ),
                  data: (b) => _BalanceCard(balance: b, onAdd: () => TopUpSheet.show(context)),
                ),
              ),
            ),
            const SliverToBoxAdapter(child: SectionHeader('Activity')),
            statement.when(
              loading: () => const SliverFillRemaining(hasScrollBody: false, child: Center(child: CircularProgressIndicator())),
              error: (e, _) => SliverFillRemaining(
                hasScrollBody: false,
                child: ErrorState(error: e, onRetry: () => ref.invalidate(statementProvider)),
              ),
              data: (s) {
                final items = collapseMirrorLegs(s.items);
                if (items.isEmpty && !s.hasMore) {
                  return const SliverFillRemaining(
                    hasScrollBody: false,
                    child: EmptyState(
                      icon: Icons.receipt_long_outlined,
                      art: BrandArt.emptyWallet,
                      title: 'No activity yet',
                      message: 'Money you add and spend will show up here.',
                    ),
                  );
                }
                return SliverList.builder(
                  itemCount: items.length + (s.hasMore ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= items.length) {
                      ref.read(statementProvider.notifier).loadMore();
                      return const Padding(
                        padding: EdgeInsets.all(Gap.lg),
                        child: Center(child: CircularProgressIndicator()),
                      );
                    }
                    return _EntryTile(
                      entry: items[i],
                      onOpenBooking: items[i].bookingId == null ? null : () => context.push('/bookings/${items[i].bookingId}'),
                    );
                  },
                );
              },
            ),
            const SliverToBoxAdapter(child: SizedBox(height: Gap.xxl)),
          ],
        ),
      ),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.balance, required this.onAdd}) : _loading = false;
  const _BalanceCard.loading() : balance = WalletBalance.empty, onAdd = null, _loading = true;

  final WalletBalance balance;
  final VoidCallback? onAdd;
  final bool _loading;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    return Container(
      padding: const EdgeInsets.all(Gap.xl),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(Corners.lg + 4),
        gradient: LinearGradient(
          colors: [c.primary, Color.alphaBlend(c.tertiary.withValues(alpha: 0.35), c.primary)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Available to spend', style: t.textTheme.labelLarge?.copyWith(color: c.onPrimary.withValues(alpha: 0.85))),
          const SizedBox(height: Gap.xs),
          _loading
              ? const SizedBox(
                  height: 48,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: SizedBox(height: 24, width: 24, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white)),
                  ),
                )
              : Text(
                  balance.available.format(),
                  style: t.textTheme.displaySmall?.copyWith(color: c.onPrimary, fontWeight: FontWeight.w800),
                ),
          const SizedBox(height: Gap.md),
          Row(
            children: [
              Icon(Icons.lock_clock_outlined, size: 18, color: c.onPrimary.withValues(alpha: 0.85)),
              const SizedBox(width: Gap.sm),
              Expanded(
                child: Text(
                  _loading ? ' ' : '${balance.held.format()} reserved for upcoming bookings',
                  style: t.textTheme.bodyMedium?.copyWith(color: c.onPrimary.withValues(alpha: 0.85)),
                ),
              ),
            ],
          ),
          const SizedBox(height: Gap.xl),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: c.onPrimary, foregroundColor: c.primary),
            onPressed: onAdd,
            icon: const Icon(Icons.add_rounded),
            label: const Text('Add money'),
          ),
        ],
      ),
    );
  }
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({required this.entry, this.onOpenBooking});

  final WalletEntry entry;
  final VoidCallback? onOpenBooking;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final s = context.statusColors;
    final credit = entry.isCredit;
    // Money moving between "available" and "held" is the customer's own money changing pockets, not spending or earning.
    final internal = entry.type == 'HOLD_CREATE' || entry.type == 'HOLD_RELEASE';
    final color = internal ? t.colorScheme.onSurfaceVariant : (credit ? s.success : t.colorScheme.onSurface);
    return ListTile(
      onTap: onOpenBooking,
      leading: CircleAvatar(
        backgroundColor: t.colorScheme.surfaceContainerHighest,
        child: Icon(
          internal ? Icons.swap_horiz_rounded : (credit ? Icons.south_west_rounded : Icons.north_east_rounded),
          color: color,
          size: 20,
        ),
      ),
      title: Text(entry.label, style: t.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
      subtitle: Text(DateFormat('d MMM y · h:mm a').format(entry.postedAt.toLocal()), style: t.textTheme.bodySmall),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            '${credit ? '+' : '−'}${entry.amount.format()}',
            style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800, color: color),
          ),
          if (!internal)
            Text('Balance ${entry.balanceAfter.format()}', style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}
