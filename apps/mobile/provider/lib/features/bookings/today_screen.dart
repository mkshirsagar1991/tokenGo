import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import '../business/business_screens.dart';
import '../business/business_state.dart';
import '../business/invitations_section.dart';
import '../business/onboarding_card.dart';
import '../earnings/earnings_state.dart';
import 'booking_widgets.dart';
import 'bookings_state.dart';

/// The salon's home. A new owner sees the review status and the setup checklist; an approved business sees today's numbers,
/// earnings, requests that need an answer and the schedule.
class TodayScreen extends ConsumerStatefulWidget {
  const TodayScreen({super.key});

  @override
  ConsumerState<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends ConsumerState<TodayScreen> {
  Timer? _poll;
  final _busy = <String>{};

  @override
  void initState() {
    super.initState();
    // New requests arrive (and a review decision is made) while the app is open; there are no push notifications yet, so look
    // again every 30 seconds.
    _poll = Timer.periodic(const Duration(seconds: 30), (_) {
      if (!mounted) return;
      ref.invalidate(bookingsWindowProvider);
      final b = ref.read(currentBusinessProvider).value;
      if (b != null && !b.isApproved) ref.invalidate(myBusinessesProvider);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _approve(Booking b) async {
    if (_busy.contains(b.id)) return;
    setState(() => _busy.add(b.id));
    try {
      await ref.read(providerRepositoryProvider).approve(b.id);
      if (mounted) showSnack(context, 'Accepted ${b.reference}. The customer has been told.');
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      if (mounted) setState(() => _busy.remove(b.id));
      if (mounted) refreshBookings(ref, bookingId: b.id);
    }
  }

  Future<void> _decline(Booking b) async {
    final reason = await askReason(context, title: 'Decline this booking?', confirmLabel: 'Decline booking');
    if (reason == null || !mounted) return;
    setState(() => _busy.add(b.id));
    try {
      await ref.read(providerRepositoryProvider).reject(b.id, reasonCode: reason.code, note: reason.note);
      if (mounted) showSnack(context, 'Declined ${b.reference}. The customer is refunded in full.');
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      if (mounted) setState(() => _busy.remove(b.id));
      if (mounted) refreshBookings(ref, bookingId: b.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final business = ref.watch(currentBusinessProvider);
    return Scaffold(
      appBar: AppBar(title: Text(business.value?.displayName ?? 'TokenGo Business')),
      body: business.when(
        skipLoadingOnReload: true,
        loading: () => const BrandLoader(),
        error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(myBusinessesProvider)),
        data: (b) {
          if (b == null) return const _NoBusiness();
          if (!b.isApproved) return _NotApproved(business: b);
          return _Dashboard(busy: _busy, onApprove: _approve, onDecline: _decline);
        },
      ),
    );
  }
}

/// A person with no business: register one, or accept an invitation to join one.
class _NoBusiness extends ConsumerWidget {
  const _NoBusiness();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(myBusinessesProvider);
        ref.invalidate(invitationsProvider);
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: Gap.lg),
          const InvitationsSection(),
          SizedBox(
            height: 420,
            child: EmptyState(
              icon: Icons.storefront_outlined,
              title: 'No business yet',
              message: 'Register your salon to start taking bookings, or ask your salon owner to invite this number as staff.',
              action: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(220, 52)),
                onPressed: () => context.push('/register'),
                child: const Text('Register your business'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Review status plus the setup checklist, for a business that is not approved (yet).
class _NotApproved extends ConsumerWidget {
  const _NotApproved({required this.business});

  final ProviderAccount business;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async => refreshSetup(ref),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: Gap.xxl),
        children: [
          Padding(
            padding: const EdgeInsets.all(Gap.lg),
            child: ReviewStatusCard(business: business),
          ),
          const InvitationsSection(),
          const OnboardingCard(hideWhenComplete: false),
          Padding(
            padding: const EdgeInsets.all(Gap.lg),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    onPressed: () => ref.invalidate(myBusinessesProvider),
                    icon: const Icon(Icons.refresh_rounded),
                    label: const Text('Check status'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Dashboard extends ConsumerWidget {
  const _Dashboard({required this.busy, required this.onApprove, required this.onDecline});

  final Set<String> busy;
  final Future<void> Function(Booking) onApprove;
  final Future<void> Function(Booking) onDecline;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dashboard = ref.watch(dashboardProvider);
    final earnings = ref.watch(earningsProvider);
    return RefreshIndicator(
      onRefresh: () async {
        refreshBookings(ref);
        ref.invalidate(earningsProvider);
        ref.invalidate(onboardingProvider);
      },
      child: dashboard.when(
        skipLoadingOnReload: true,
        loading: () => const BrandLoader(),
        error: (e, _) => ListView(
          children: [
            SizedBox(
              height: 400,
              child: ErrorState(error: e, onRetry: () => ref.invalidate(bookingsWindowProvider)),
            ),
          ],
        ),
        data: (d) => ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: Gap.xxl),
          children: [
            const SizedBox(height: Gap.sm),
            const InvitationsSection(),
            const OnboardingCard(),
            _Stats(d: d),
            _EarningsCard(earnings: earnings, onRetry: () => ref.invalidate(earningsProvider)),
            if (d.isEmpty)
              const Padding(
                padding: EdgeInsets.all(Gap.xl),
                child: Center(child: Text('No bookings to act on right now. New requests appear here.', textAlign: TextAlign.center)),
              ),
            if (d.requests.isNotEmpty) ...[
              SectionHeader('Needs your response (${d.requests.length})'),
              for (final b in d.requests)
                Padding(
                  padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
                  child: BookingTile(
                    booking: b,
                    onTap: () => context.push('/booking/${b.id}'),
                    footer: Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(44)),
                            onPressed: busy.contains(b.id) ? null : () => onDecline(b),
                            child: const Text('Decline'),
                          ),
                        ),
                        const SizedBox(width: Gap.md),
                        Expanded(
                          child: FilledButton(
                            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(44)),
                            onPressed: busy.contains(b.id) ? null : () => onApprove(b),
                            child: busy.contains(b.id)
                                ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2.5))
                                : const Text('Accept'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
            if (d.today.isNotEmpty) ...[
              const SectionHeader('Today'),
              for (final b in d.today)
                Padding(
                  padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
                  child: BookingTile(booking: b, onTap: () => context.push('/booking/${b.id}')),
                ),
            ],
            if (d.upcoming.isNotEmpty) ...[
              SectionHeader('Coming up (${d.upcoming.length}${d.truncated ? '+' : ''})'),
              for (final b in d.upcoming.take(5))
                Padding(
                  padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
                  child: BookingTile(booking: b, onTap: () => context.push('/booking/${b.id}')),
                ),
              if (d.upcoming.length > 5)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
                  child: Text('${d.upcoming.length - 5} more are listed under Bookings.', style: Theme.of(context).textTheme.bodySmall),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Stats extends StatelessWidget {
  const _Stats({required this.d});

  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final plus = d.truncated ? '+' : '';
    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: _StatTile(icon: Icons.today_rounded, label: 'Today', value: '${d.today.length}', hint: 'appointments'),
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: _StatTile(
                  icon: Icons.notifications_active_outlined,
                  label: 'Requests',
                  value: '${d.requests.length}$plus',
                  hint: 'need an answer',
                  tone: d.requests.isEmpty ? null : context.statusColors.warning,
                ),
              ),
            ],
          ),
          const SizedBox(height: Gap.md),
          Row(
            children: [
              Expanded(
                child: _StatTile(
                  icon: Icons.event_available_outlined,
                  label: 'Upcoming',
                  value: '${d.upcoming.length}$plus',
                  hint: 'after today',
                ),
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: _StatTile(
                  icon: Icons.task_alt_rounded,
                  label: 'Completed today',
                  value: '${d.completedToday.length}',
                  hint: d.completedToday.isEmpty ? 'services' : '${d.completedValue.format()} before commission',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.icon, required this.label, required this.value, required this.hint, this.tone});

  final IconData icon;
  final String label;
  final String value;
  final String hint;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 18, color: tone ?? t.colorScheme.primary),
                const SizedBox(width: Gap.xs),
                Expanded(
                  child: Text(
                    label,
                    style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: Gap.xs),
            Text(
              value,
              style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800, color: tone),
            ),
            Text(
              hint,
              style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}

/// Earnings as the SERVER reports them (after commission): payable now, pending, paid.
class _EarningsCard extends StatelessWidget {
  const _EarningsCard({required this.earnings, required this.onRetry});

  final AsyncValue<Earnings?> earnings;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.md),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => context.go('/earnings'),
          child: Padding(
            padding: const EdgeInsets.all(Gap.lg),
            child: earnings.when(
              skipLoadingOnReload: true,
              loading: () => const SizedBox(height: 60, child: Center(child: CircularProgressIndicator())),
              error: (e, _) => Row(
                children: [
                  Expanded(child: Text('Could not load earnings. ${errorMessage(e)}')),
                  TextButton(onPressed: onRetry, child: const Text('Retry')),
                ],
              ),
              data: (e) {
                if (e == null) return const Text('Earnings appear here once your business is approved.');
                final pending = e.waiting + e.inPayout;
                Widget col(String label, Money m, {bool strong = false}) => Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(m.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: strong ? FontWeight.w800 : FontWeight.w700)),
                      Text(label, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    ],
                  ),
                );
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text('Earnings', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)),
                        ),
                        Icon(Icons.chevron_right_rounded, color: t.colorScheme.outline),
                      ],
                    ),
                    const SizedBox(height: Gap.sm),
                    Row(
                      children: [
                        col('Payable now', e.eligible, strong: true),
                        col('Pending payout', pending),
                        col('Paid so far', e.paidTotal),
                      ],
                    ),
                    if (PayoutBlocker.explain(e.blocker) != null && (e.eligible.isPositive || pending.isPositive))
                      Padding(
                        padding: const EdgeInsets.only(top: Gap.sm),
                        child: Text(
                          PayoutBlocker.explain(e.blocker)!,
                          style: t.textTheme.bodySmall?.copyWith(color: context.statusColors.warning),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
