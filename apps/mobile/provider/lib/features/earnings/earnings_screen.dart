import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../business/business_state.dart';
import 'earnings_state.dart';

/// What the business has earned, what is on its way to the bank, and where it is paid.
class EarningsScreen extends ConsumerWidget {
  const EarningsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final business = ref.watch(currentBusinessProvider);
    final earnings = ref.watch(earningsProvider);
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(title: const Text('Earnings')),
        body: business.when(
          loading: () => const BrandLoader(),
          error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(myBusinessesProvider)),
          data: (b) {
            if (b == null || !b.isApproved) {
              return const EmptyState(
                icon: Icons.account_balance_wallet_outlined,
                art: BrandArt.emptyEarnings,
                title: 'Earnings start after approval',
                message: 'Once TokenGo approves your business, what you earn shows up here.',
              );
            }
            return RefreshIndicator(
              onRefresh: () async {
                refreshEarnings(ref);
                await ref.read(earningsProvider.future);
              },
              child: NestedScrollView(
                headerSliverBuilder: (context, _) => [
                  SliverToBoxAdapter(
                    child: earnings.when(
                      loading: () => const Padding(
                        padding: EdgeInsets.all(Gap.xxl),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                      error: (e, _) => SizedBox(
                        height: 260,
                        child: ErrorState(error: e, onRetry: () => ref.invalidate(earningsProvider)),
                      ),
                      data: (e) => e == null ? const SizedBox.shrink() : _Summary(earnings: e),
                    ),
                  ),
                  const SliverToBoxAdapter(
                    child: TabBar(
                      tabs: [
                        Tab(text: 'Per booking'),
                        Tab(text: 'Bank payouts'),
                      ],
                    ),
                  ),
                ],
                body: const TabBarView(children: [_PayablesList(), _PayoutsList()]),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.earnings});

  final Earnings earnings;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    final blocker = PayoutBlocker.explain(earnings.blocker);
    Widget stat(String label, Money m, {String? hint}) => Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: t.textTheme.labelMedium?.copyWith(color: c.onSurfaceVariant)),
          const SizedBox(height: 2),
          Text(m.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          if (hint != null) Text(hint, style: t.textTheme.labelSmall?.copyWith(color: c.onSurfaceVariant)),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.all(Gap.lg),
      child: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(Gap.xl),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(Corners.lg + 4), color: c.primary),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Ready for your next payout', style: t.textTheme.labelLarge?.copyWith(color: c.onPrimary.withValues(alpha: 0.85))),
                const SizedBox(height: Gap.xs),
                Text(
                  earnings.eligible.format(),
                  style: t.textTheme.displaySmall?.copyWith(color: c.onPrimary, fontWeight: FontWeight.w800),
                ),
                if (blocker != null) ...[
                  const SizedBox(height: Gap.md),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.info_outline_rounded, size: 18, color: c.onPrimary.withValues(alpha: 0.9)),
                      const SizedBox(width: Gap.sm),
                      Expanded(
                        child: Text(blocker, style: t.textTheme.bodySmall?.copyWith(color: c.onPrimary.withValues(alpha: 0.9))),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: Gap.md),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(Gap.lg),
              child: Column(
                children: [
                  Row(
                    children: [
                      stat(
                        'In review window',
                        earnings.waiting,
                        hint: earnings.nextEligibleAt == null
                            ? null
                            : 'next ${DateFormat('d MMM').format(earnings.nextEligibleAt!.toLocal())}',
                      ),
                      stat('On its way', earnings.inPayout),
                      stat('Paid so far', earnings.paidTotal),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: Gap.md),
          _AccountCard(account: earnings.account),
        ],
      ),
    );
  }
}

class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.account});

  final PayoutAccount? account;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final a = account;
    final (label, tone) = switch (a) {
      null => ('Not added', Tone.warning),
      PayoutAccount(isVerified: true) => ('Verified', Tone.success),
      PayoutAccount(hasFailed: true) => ('Needs fixing', Tone.danger),
      _ => ('Being verified', Tone.info),
    };
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(Corners.lg),
        onTap: () => context.push('/earnings/bank-account'),
        child: Padding(
          padding: const EdgeInsets.all(Gap.lg),
          child: Row(
            children: [
              Icon(Icons.account_balance_outlined, color: t.colorScheme.primary),
              const SizedBox(width: Gap.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Bank account', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    Text(
                      a == null ? 'Add the account we pay your earnings into' : '${a.holderName} · ${a.accountMasked}',
                      style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                    ),
                    if (a?.hasFailed == true && a?.failureReason != null)
                      Text(a!.failureReason!, style: t.textTheme.bodySmall?.copyWith(color: context.statusColors.danger)),
                  ],
                ),
              ),
              StatusPill(label, tone: tone),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

final _dateTime = DateFormat('d MMM y · h:mm a');

class _PayablesList extends ConsumerWidget {
  const _PayablesList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(payablesProvider);
    return state.when(
      loading: () => const BrandLoader(),
      error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(payablesProvider)),
      data: (s) => s.items.isEmpty
          ? const EmptyState(
              icon: Icons.receipt_long_outlined,
              art: BrandArt.emptyEarnings,
              title: 'Nothing earned yet',
              message: 'Each completed booking shows up here, after TokenGo\'s commission.',
            )
          : ListView.builder(
              itemCount: s.items.length + (s.hasMore ? 1 : 0),
              itemBuilder: (context, i) {
                if (i >= s.items.length) {
                  ref.read(payablesProvider.notifier).loadMore();
                  return const Padding(
                    padding: EdgeInsets.all(Gap.lg),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                final p = s.items[i];
                return ListTile(
                  onTap: () => context.push('/booking/${p.bookingId}'),
                  title: Text(p.net.format(), style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text('${p.statusLabel} · commission ${p.commission.format()}'),
                  trailing: Text(DateFormat('d MMM').format(p.eligibleAt.toLocal()), style: Theme.of(context).textTheme.bodySmall),
                );
              },
            ),
    );
  }
}

class _PayoutsList extends ConsumerWidget {
  const _PayoutsList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(payoutsProvider);
    return state.when(
      loading: () => const BrandLoader(),
      error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(payoutsProvider)),
      data: (s) => s.items.isEmpty
          ? const EmptyState(
              icon: Icons.account_balance_outlined,
              art: BrandArt.emptyEarnings,
              title: 'No bank payouts yet',
              message: 'Payouts are sent to your verified bank account once earnings pass the review window.',
            )
          : ListView.builder(
              itemCount: s.items.length + (s.hasMore ? 1 : 0),
              itemBuilder: (context, i) {
                if (i >= s.items.length) {
                  ref.read(payoutsProvider.notifier).loadMore();
                  return const Padding(
                    padding: EdgeInsets.all(Gap.lg),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                final p = s.items[i];
                return ListTile(
                  title: Text(p.amount.format(), style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    '${p.statusLabel}${p.utr == null ? '' : ' · ref ${p.utr}'}${p.isFailed && p.failureReason != null ? '\n${p.failureReason}' : ''}',
                  ),
                  isThreeLine: p.isFailed && p.failureReason != null,
                  trailing: Text(_dateTime.format(p.createdAt.toLocal()), style: Theme.of(context).textTheme.bodySmall),
                );
              },
            ),
    );
  }
}
