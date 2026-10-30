import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:uuid/uuid.dart';

import '../../core/providers.dart';
import '../discover/search_state.dart';
import '../wallet/wallet_state.dart';
import 'booking_state.dart';

/// Book in as few steps as possible: services (one or more), day, time (and optionally a stylist), then one button.
/// The server prices the services, holds the money and reserves the slot in a single step; this screen sends none of that.
class BookingFlowScreen extends ConsumerStatefulWidget {
  const BookingFlowScreen({super.key, required this.locationId, this.initialServiceIds = const []});

  final String locationId;

  /// Services already ticked on the salon page.
  final List<String> initialServiceIds;

  @override
  ConsumerState<BookingFlowScreen> createState() => _BookingFlowScreenState();
}

class _BookingFlowScreenState extends ConsumerState<BookingFlowScreen> {
  /// The ticked services, in the order they were ticked (that order is how they are listed on the booking).
  List<String> _serviceIds = [];
  String? _date;
  Slot? _slot;
  String? _resourceId; // null = any available stylist
  final _note = TextEditingController();
  bool _busy = false;

  /// One key per booking ATTEMPT. A retry after a dropped connection re-sends the same key and gets the same booking back
  /// instead of a second one (and a second hold on the wallet). It is renewed whenever the choices change.
  String? _attemptKey;

  late final String _fromDate = todayIso();

  @override
  void initState() {
    super.initState();
    _serviceIds = [...widget.initialServiceIds.toSet()];
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  void _changed(VoidCallback update) => setState(() {
    update();
    _attemptKey = null;
  });

  SlotsQuery _slotsQuery(LocationProfile profile) => (locationId: profile.locationId, serviceIds: serviceKey(_serviceIds), fromDate: _fromDate);

  Future<void> _submit(LocationProfile profile, List<ServiceItem> services) async {
    final slot = _slot;
    if (slot == null || _busy) return;
    setState(() => _busy = true);
    _attemptKey ??= const Uuid().v4();
    try {
      final booking = await ref
          .read(bookingRepositoryProvider)
          .create(
            locationId: profile.locationId,
            serviceIds: [for (final s in services) s.id],
            startAt: slot.startAt,
            resourceId: _resourceId,
            note: _note.text,
            idempotencyKey: _attemptKey!,
          );
      refreshBookings(ref);
      refreshWallet(ref);
      if (mounted) context.go('/bookings/${booking.id}?new=1');
    } on ApiException catch (e) {
      if (!mounted) return;
      await _handleFailure(e, profile);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _handleFailure(ApiException e, LocationProfile profile) async {
    switch (e.code) {
      case 'INSUFFICIENT_FUNDS':
        final shortfall = e.details['shortfall'] is Map<String, dynamic>
            ? Money.fromJson(e.details['shortfall'] as Map<String, dynamic>)
            : null;
        final go = await showDialog<bool>(
          context: context,
          builder: (_) => AlertDialog(
            icon: const Icon(Icons.account_balance_wallet_outlined),
            title: const Text('Add money to book'),
            content: Text(
              shortfall == null
                  ? 'Your wallet balance is not enough for this booking.'
                  : 'Your wallet is ${shortfall.format()} short for this booking. Add money and come back — your choices are kept.',
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Not now')),
              FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(120, 44)),
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Add money'),
              ),
            ],
          ),
        );
        if (go == true && mounted) context.push('/add-money?amount=${shortfall?.minor ?? 0}');
      case 'SLOT_UNAVAILABLE':
        showSnack(context, 'Someone just took that time. Pick another one.', error: true);
        ref.invalidate(slotsProvider(_slotsQuery(profile)));
        _changed(() {
          _slot = null;
          _resourceId = null;
        });
      default:
        // A network failure keeps the attempt key, so pressing the button again is safe.
        showSnack(context, e.isNetwork ? 'No connection. Your booking was not placed — try again.' : e.userMessage, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final profileAsync = ref.watch(locationProfileProvider(widget.locationId));
    return Scaffold(
      appBar: AppBar(title: const Text('Book an appointment')),
      body: profileAsync.when(
        loading: () => const BrandLoader(),
        error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(locationProfileProvider(widget.locationId))),
        data: (profile) => _buildForm(context, profile),
      ),
    );
  }

  Widget _buildForm(BuildContext context, LocationProfile profile) {
    final t = Theme.of(context);
    // What is ticked, in the order it was ticked (ids the salon no longer offers are ignored).
    final chosen = [for (final id in _serviceIds) ?profile.services.where((s) => s.id == id).firstOrNull];
    final total = chosen.fold(Money.zero, (sum, s) => sum + s.price);
    final slotsAsync = chosen.isEmpty ? null : ref.watch(slotsProvider((locationId: profile.locationId, serviceIds: serviceKey(chosen.map((s) => s.id)), fromDate: _fromDate)));
    final balance = ref.watch(walletBalanceProvider).value;
    final signedIn = ref.watch(sessionUserProvider) != null;

    final days = slotsAsync?.value?.byDay;
    final daySlots = (_date != null && days != null) ? days[_date] ?? const <Slot>[] : const <Slot>[];
    final canBook = chosen.isNotEmpty && _slot != null;
    final insufficient = chosen.isNotEmpty && balance != null && balance.available < total;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.sm, Gap.lg, Gap.xl),
            children: [
              Text(profile.name, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              Text(profile.address.oneLine, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              const SizedBox(height: Gap.xl),
              Text('1 · Choose services', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              Text('Tick one or more. They are done together in one visit.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              const SizedBox(height: Gap.sm),
              for (final s in profile.services)
                Padding(
                  padding: const EdgeInsets.only(bottom: Gap.sm),
                  child: _SelectableCard(
                    selected: _serviceIds.contains(s.id),
                    onTap: () => _changed(() {
                      _serviceIds = _serviceIds.contains(s.id) ? ([..._serviceIds]..remove(s.id)) : [..._serviceIds, s.id];
                      _date = null;
                      _slot = null;
                      _resourceId = null;
                    }),
                    child: Row(
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(right: Gap.md),
                          child: Icon(
                            _serviceIds.contains(s.id) ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
                            color: _serviceIds.contains(s.id) ? t.colorScheme.primary : t.colorScheme.outline,
                          ),
                        ),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(s.name, style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                              Text(formatDuration(s.durationMin), style: t.textTheme.bodySmall),
                            ],
                          ),
                        ),
                        Text(s.price.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                ),
              if (chosen.length > 1) ...[
                const SizedBox(height: Gap.xs),
                Container(
                  padding: const EdgeInsets.all(Gap.md),
                  decoration: BoxDecoration(color: t.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(Corners.md)),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${chosen.length} services · ${slotsAsync?.value != null ? formatDuration(slotsAsync!.value!.durationMin) : 'about ${formatDuration(chosen.fold(0, (m, s) => m + s.durationMin))}'}',
                          style: t.textTheme.bodyMedium,
                        ),
                      ),
                      Text(total.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                    ],
                  ),
                ),
              ],
              if (chosen.isNotEmpty) ...[
                const SizedBox(height: Gap.lg),
                Text('2 · Pick a day and time', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: Gap.sm),
                slotsAsync!.when(
                  loading: () => const Padding(
                    padding: EdgeInsets.all(Gap.xl),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (e, _) => SizedBox(
                    height: 180,
                    child: ErrorState(
                      error: e,
                      onRetry: () =>
                          ref.invalidate(slotsProvider(_slotsQuery(profile))),
                    ),
                  ),
                  data: (result) {
                    if (result.slots.isEmpty) {
                      return const Padding(
                        padding: EdgeInsets.symmetric(vertical: Gap.xl),
                        child: EmptyState(
                          icon: Icons.event_busy_outlined,
                          art: BrandArt.emptyBookings,
                          title: 'No free times',
                          message: 'This salon has nothing open in the next two weeks for this visit. Try fewer services, another service or another salon.',
                        ),
                      );
                    }
                    final dates = result.byDay.keys.toList();
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          height: 84,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount: dates.length,
                            separatorBuilder: (_, _) => const SizedBox(width: Gap.sm),
                            itemBuilder: (context, i) => _DayChip(
                              date: dates[i],
                              selected: dates[i] == _date,
                              onTap: () => _changed(() {
                                _date = dates[i];
                                _slot = null;
                                _resourceId = null;
                              }),
                            ),
                          ),
                        ),
                        const SizedBox(height: Gap.md),
                        if (_date == null)
                          Text(
                            'Choose a day to see times.',
                            style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                          ),
                        for (final part in _DayPart.values)
                          if (daySlots.any((s) => _DayPart.of(s.localTime) == part)) ...[
                            Padding(
                              padding: const EdgeInsets.only(top: Gap.sm, bottom: Gap.sm),
                              child: Row(
                                children: [
                                  Icon(part.icon, size: 18, color: t.colorScheme.onSurfaceVariant),
                                  const SizedBox(width: Gap.sm),
                                  Text(part.label, style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                                ],
                              ),
                            ),
                            Wrap(
                              spacing: Gap.sm,
                              runSpacing: Gap.sm,
                              children: [
                                for (final s in daySlots.where((s) => _DayPart.of(s.localTime) == part))
                                  ChoiceChip(
                                    label: Text(formatLocalTime(s.localTime)),
                                    showCheckmark: false,
                                    selected: _slot?.startAt == s.startAt,
                                    onSelected: (_) => _changed(() {
                                      _slot = s;
                                      _resourceId = null;
                                    }),
                                  ),
                              ],
                            ),
                          ],
                      ],
                    );
                  },
                ),
                if (_slot != null) ...[
                  const SizedBox(height: Gap.xl),
                  Text('3 · Stylist', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: Gap.sm),
                  if (_slot!.resources.length > 1)
                    Wrap(
                      spacing: Gap.sm,
                      runSpacing: Gap.sm,
                      children: [
                        ChoiceChip(
                          label: const Text('Any available'),
                          selected: _resourceId == null,
                          onSelected: (_) => _changed(() => _resourceId = null),
                        ),
                        for (final r in _slot!.resources)
                          ChoiceChip(
                            label: Text(r.displayName),
                            selected: _resourceId == r.id,
                            onSelected: (_) => _changed(() => _resourceId = r.id),
                          ),
                      ],
                    )
                  else
                    Text(_slot!.resources.first.displayName, style: t.textTheme.bodyLarge),
                  const SizedBox(height: Gap.lg),
                  TextField(
                    controller: _note,
                    maxLines: 2,
                    maxLength: 500,
                    onChanged: (_) => _attemptKey = null,
                    decoration: const InputDecoration(labelText: 'Note for the salon (optional)', counterText: ''),
                  ),
                ],
              ],
            ],
          ),
        ),
        _BottomBar(
          services: chosen,
          total: total,
          slot: _slot,
          busy: _busy,
          signedIn: signedIn,
          balance: balance,
          insufficient: insufficient,
          canBook: canBook,
          onAddMoney: () =>
              context.push('/add-money?amount=${chosen.isEmpty || balance == null ? 0 : (total - balance.available).minor}'),
          onBook: () => _submit(profile, chosen),
          onSignIn: () => context.push('/login?from=${Uri.encodeQueryComponent(GoRouterState.of(context).uri.toString())}'),
        ),
      ],
    );
  }
}

/// Times are easier to scan in three groups than in one long run.
enum _DayPart {
  morning('Morning', Icons.wb_twilight_rounded),
  afternoon('Afternoon', Icons.wb_sunny_outlined),
  evening('Evening', Icons.nights_stay_outlined);

  const _DayPart(this.label, this.icon);
  final String label;
  final IconData icon;

  /// [hhmm] is the salon's wall-clock time, "09:30".
  static _DayPart of(String hhmm) {
    final hour = int.parse(hhmm.split(':').first);
    return hour < 12
        ? morning
        : hour < 17
        ? afternoon
        : evening;
  }
}

class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.services,
    required this.total,
    required this.slot,
    required this.busy,
    required this.signedIn,
    required this.balance,
    required this.insufficient,
    required this.canBook,
    required this.onAddMoney,
    required this.onBook,
    required this.onSignIn,
  });

  final List<ServiceItem> services;
  final Money total;
  final Slot? slot;
  final bool busy;
  final bool signedIn;
  final WalletBalance? balance;
  final bool insufficient;
  final bool canBook;
  final VoidCallback onAddMoney;
  final VoidCallback onBook;
  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final s = context.statusColors;
    return Material(
      elevation: 8,
      color: t.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(Gap.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (services.isNotEmpty && slot != null) ...[
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${services.map((s) => s.name).join(' + ')} · ${formatLocalDateTime(slot!.localStart)}',
                        style: t.textTheme.bodyMedium,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Text(total.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                  ],
                ),
                const SizedBox(height: Gap.xs),
                Text(
                  signedIn && balance != null
                      ? (insufficient
                            ? 'Your wallet has ${balance!.available.format()} available — you need ${(total - balance!.available).format()} more.'
                            : '${total.format()} is held from your wallet (${balance!.available.format()} available) until the salon responds. Released automatically if they decline or do not answer.')
                      : 'Payment comes from your TokenGo wallet and is held until the salon responds.',
                  style: t.textTheme.bodySmall?.copyWith(color: insufficient ? s.danger : t.colorScheme.onSurfaceVariant),
                ),
                const SizedBox(height: Gap.md),
              ],
              if (!signedIn)
                FilledButton(onPressed: canBook ? onSignIn : null, child: const Text('Sign in to book'))
              else if (insufficient)
                FilledButton.icon(onPressed: onAddMoney, icon: const Icon(Icons.add_card), label: const Text('Add money to your wallet'))
              else
                FilledButton(
                  onPressed: canBook && !busy ? onBook : null,
                  child: busy
                      ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                      : const Text('Request booking'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SelectableCard extends StatelessWidget {
  const _SelectableCard({required this.selected, required this.onTap, required this.child});

  final bool selected;
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Material(
      color: selected ? c.primaryContainer : c.surfaceContainerLow,
      borderRadius: BorderRadius.circular(Corners.lg),
      child: InkWell(
        borderRadius: BorderRadius.circular(Corners.lg),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(Gap.lg),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Corners.lg),
            border: Border.all(color: selected ? c.primary : c.outlineVariant, width: selected ? 2 : 1),
          ),
          child: child,
        ),
      ),
    );
  }
}

class _DayChip extends StatelessWidget {
  const _DayChip({required this.date, required this.selected, required this.onTap});

  final String date;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(Corners.lg),
      onTap: onTap,
      child: Container(
        width: 64,
        decoration: BoxDecoration(
          color: selected ? c.primary : c.surfaceContainerLow,
          borderRadius: BorderRadius.circular(Corners.lg),
          border: Border.all(color: selected ? c.primary : c.outlineVariant),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(weekdayShort(date), style: t.textTheme.labelMedium?.copyWith(color: selected ? c.onPrimary : c.onSurfaceVariant)),
            Text(
              dayOfMonth(date),
              style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: selected ? c.onPrimary : c.onSurface),
            ),
            Text(monthShort(date), style: t.textTheme.labelSmall?.copyWith(color: selected ? c.onPrimary : c.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }
}
