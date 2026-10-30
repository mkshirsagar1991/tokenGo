import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import '../wallet/wallet_state.dart';
import 'booking_state.dart';

/// One booking: where it stands, what it costs, what happens if you cancel, and what to do next.
class BookingDetailScreen extends ConsumerStatefulWidget {
  const BookingDetailScreen({super.key, required this.bookingId, this.justCreated = false});

  final String bookingId;
  final bool justCreated;

  @override
  ConsumerState<BookingDetailScreen> createState() => _BookingDetailScreenState();
}

class _BookingDetailScreenState extends ConsumerState<BookingDetailScreen> {
  Timer? _poll;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // The salon answers in the background: keep the screen current without the person having to pull to refresh.
    _poll = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted && !_busy) refreshBookings(ref, bookingId: widget.bookingId);
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _cancel(Booking b) async {
    final refund = b.cancellation.refundIfCancelledNow;
    final sure = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Cancel this booking?'),
        content: Text(
          refund == null
              ? 'This cannot be undone.'
              : refund.minor == b.price.minor
              ? 'You will get the full ${refund.format()} back to your wallet.'
              : refund.isZero
              ? 'Under the cancellation policy you will not get a refund this close to the appointment.'
              : 'Under the cancellation policy you will get ${refund.format()} of ${b.price.format()} back to your wallet.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep booking')),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(120, 44), backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Cancel booking'),
          ),
        ],
      ),
    );
    if (sure != true) return;
    await _run(() => ref.read(bookingRepositoryProvider).cancel(b.id), done: 'Booking cancelled.');
  }

  Future<void> _confirmDone(Booking b) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Was the service done?'),
        content: Text(
          'Confirming releases ${b.price.format()} to the salon. If something was wrong, do not confirm — the payment stays protected for a short review window.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Not yet')),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(120, 44)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Yes, all good'),
          ),
        ],
      ),
    );
    if (sure != true) return;
    await _run(() => ref.read(bookingRepositoryProvider).confirmCompletion(b.id), done: 'Thanks! Payment released to the salon.');
  }

  Future<void> _run(Future<Booking> Function() action, {required String done}) async {
    setState(() => _busy = true);
    try {
      await action();
      refreshBookings(ref, bookingId: widget.bookingId);
      refreshWallet(ref);
      if (mounted) showSnack(context, done);
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showArrivalCode(Booking b) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) => _ArrivalCodeSheet(booking: b),
    );
  }

  @override
  Widget build(BuildContext context) {
    final booking = ref.watch(bookingProvider(widget.bookingId));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Booking'),
        leading: BackButton(onPressed: () => context.canPop() ? context.pop() : context.go('/bookings')),
      ),
      body: booking.when(
        loading: () => const BrandLoader(),
        error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(bookingProvider(widget.bookingId))),
        data: (b) => RefreshIndicator(
          onRefresh: () async {
            refreshBookings(ref, bookingId: widget.bookingId);
            await ref.read(bookingProvider(widget.bookingId).future);
          },
          child: ListView(
            padding: const EdgeInsets.all(Gap.lg),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              if (widget.justCreated && b.status == BookingStatus.requested)
                _Banner(
                  icon: Icons.check_circle_outline,
                  tone: Tone.success,
                  text:
                      'Request sent! ${formatLocalDateTime(b.localStart)} is held for you. The salon usually answers within ${_deadlineMinutes(b)} minutes.',
                ),
              _StatusCard(booking: b),
              const SizedBox(height: Gap.md),
              _DetailsCard(booking: b),
              const SizedBox(height: Gap.md),
              _MoneyCard(booking: b),
              const SizedBox(height: Gap.lg),
              if (b.showsArrivalCode)
                FilledButton.icon(
                  onPressed: _busy ? null : () => _showArrivalCode(b),
                  icon: const Icon(Icons.qr_code_2_rounded),
                  label: const Text('Show arrival code'),
                ),
              if (b.needsCompletionConfirmation)
                FilledButton.icon(
                  onPressed: _busy ? null : () => _confirmDone(b),
                  icon: const Icon(Icons.verified_outlined),
                  label: const Text('Confirm service done'),
                ),
              if (b.canCancel) ...[
                const SizedBox(height: Gap.md),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                  onPressed: _busy ? null : () => _cancel(b),
                  child: const Text('Cancel booking'),
                ),
              ],
              const SizedBox(height: Gap.sm),
              _Timeline(bookingId: b.id),
              const SizedBox(height: Gap.xl),
            ],
          ),
        ),
      ),
    );
  }

  int _deadlineMinutes(Booking b) {
    final d = b.responseDeadlineAt;
    if (d == null) return 30;
    return d.difference(DateTime.now()).inMinutes.clamp(1, 24 * 60);
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.icon, required this.tone, required this.text});

  final IconData icon;
  final Tone tone;
  final String text;

  @override
  Widget build(BuildContext context) {
    final s = context.statusColors;
    final (bg, fg) = switch (tone) {
      Tone.success => (s.successContainer, s.success),
      Tone.warning => (s.warningContainer, s.warning),
      Tone.danger => (s.dangerContainer, s.danger),
      _ => (s.infoContainer, s.info),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: Gap.md),
      padding: const EdgeInsets.all(Gap.lg),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(Corners.lg)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: fg),
          const SizedBox(width: Gap.md),
          Expanded(
            child: Text(
              text,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: fg, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.booking});

  final Booking booking;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final hint = _hint(booking);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_art(booking.status) case final art?) ...[
              Center(child: BrandImage(art, height: 88)),
              const SizedBox(height: Gap.md),
            ],
            Row(
              children: [
                Expanded(
                  child: Text(
                    booking.reference,
                    style: t.textTheme.labelLarge?.copyWith(letterSpacing: 1.2, color: t.colorScheme.onSurfaceVariant),
                  ),
                ),
                StatusPill(BookingStatus.label(booking.status), tone: bookingTone(booking.status)),
              ],
            ),
            const SizedBox(height: Gap.sm),
            Text(booking.serviceName, style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            if (hint != null) ...[
              const SizedBox(height: Gap.sm),
              Text(hint, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            ],
          ],
        ),
      ),
    );
  }

  /// The brand illustration for the states that have one: a confirmed slot, and a booking that did not go ahead.
  static BrandArt? _art(String status) => switch (status) {
    BookingStatus.confirmed => BrandArt.successBooking,
    BookingStatus.customerCancelled || BookingStatus.providerCancelled || BookingStatus.providerRejected || BookingStatus.expired => BrandArt.errorBookingCancelled,
    _ => null,
  };

  String? _hint(Booking b) => switch (b.status) {
    BookingStatus.requested =>
      'Waiting for the salon to accept. Your money is held and is released automatically if they decline or do not answer.',
    BookingStatus.confirmed => 'The salon confirmed your slot. When you arrive, show your arrival code to start the service.',
    BookingStatus.providerRejected => 'The salon could not take this booking. Your money has been released back to your wallet.',
    BookingStatus.expired => 'The salon did not respond in time. Your money has been released back to your wallet.',
    BookingStatus.customerCancelled || BookingStatus.providerCancelled => 'This booking was cancelled. Any refund due is in your wallet.',
    BookingStatus.serviceCompleted =>
      'The salon marked this done. Please confirm, or the payment is released automatically after the review window.',
    BookingStatus.closed => 'All done. Thank you!',
    _ => null,
  };
}

class _DetailsCard extends StatelessWidget {
  const _DetailsCard({required this.booking});

  final Booking booking;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          children: [
            _Row(icon: Icons.storefront_outlined, label: 'Salon', value: booking.locationName ?? '—'),
            if (booking.hasSeveralServices)
              _Row(
                icon: Icons.content_cut_rounded,
                label: 'Services',
                value: [for (final s in booking.services) '${s.name} · ${s.price.format()}'].join('\n'),
              ),
            _Row(
              icon: Icons.event_outlined,
              label: 'When',
              value:
                  '${formatLocalDateLong(booking.localDate)}\n${formatLocalTime(booking.localTime)} · ${formatDuration(booking.durationMin)}',
            ),
            if (booking.staffName != null) _Row(icon: Icons.person_outline_rounded, label: 'Stylist', value: booking.staffName!),
            if (booking.note != null) _Row(icon: Icons.notes_outlined, label: 'Your note', value: booking.note!),
          ],
        ),
      ),
    );
  }
}

class _MoneyCard extends StatelessWidget {
  const _MoneyCard({required this.booking});

  final Booking booking;

  @override
  Widget build(BuildContext context) {
    final fundsText = switch (booking.fundsStatus) {
      'HELD' => 'Held from your wallet',
      'RELEASED' => 'Released back to your wallet',
      'SETTLED' => 'Paid to the salon',
      'PARTIAL' => 'Partly refunded, rest paid to the salon',
      _ => '—',
    };
    final refund = booking.cancellation.refundIfCancelledNow;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          children: [
            _Row(icon: Icons.payments_outlined, label: 'Price', value: booking.price.format()),
            _Row(icon: Icons.account_balance_wallet_outlined, label: 'Your money', value: fundsText),
            if (refund != null)
              _Row(
                icon: Icons.undo_rounded,
                label: 'If you cancel now',
                value: refund.isZero
                    ? 'No refund'
                    : '${refund.format()} back${booking.cancellation.refundBps == null || booking.cancellation.refundBps == 10000 ? '' : ' (${booking.cancellation.refundBps! ~/ 100}%)'}',
              ),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.label, required this.value});

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Gap.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: t.colorScheme.primary),
          const SizedBox(width: Gap.md),
          SizedBox(
            width: 110,
            child: Text(label, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(value, style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}

/// The booking's history, from the server's immutable event log.
class _Timeline extends ConsumerWidget {
  const _Timeline({required this.bookingId});

  final String bookingId;

  static const _labels = {
    'BookingRequested': 'Request sent',
    'BookingApproved': 'Confirmed by the salon',
    'BookingRejected': 'Declined by the salon',
    'BookingExpired': 'No response from the salon',
    'BookingCancelledByCustomer': 'You cancelled',
    'BookingCancelledByProvider': 'Cancelled by the salon',
    'ArrivalVerificationFailed': 'Arrival code did not match',
    'CustomerArrived': 'You arrived',
    'ServiceStarted': 'Service started',
    'ServiceCompleted': 'Service completed',
    'ServiceSettled': 'Payment released to the salon',
    'NoShowMarked': 'Marked as no-show',
  };

  static String _label(String type) => _labels[type] ?? type.replaceAllMapped(RegExp(r'(?<=[a-z])(?=[A-Z])'), (_) => ' ');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(bookingEventsProvider(bookingId));
    final t = Theme.of(context);
    return events.maybeWhen(
      data: (list) => list.isEmpty
          ? const SizedBox.shrink()
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('Timeline'),
                for (final e in list)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.xs),
                    child: Row(
                      children: [
                        Icon(Icons.circle, size: 10, color: t.colorScheme.primary),
                        const SizedBox(width: Gap.md),
                        Expanded(child: Text(_label(e.type), style: t.textTheme.bodyMedium)),
                        Text(
                          '${e.occurredAt.toLocal().day}/${e.occurredAt.toLocal().month} ${e.occurredAt.toLocal().hour.toString().padLeft(2, '0')}:${e.occurredAt.toLocal().minute.toString().padLeft(2, '0')}',
                          style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
      orElse: () => const SizedBox.shrink(),
    );
  }
}

final _arrivalCodeProvider = FutureProvider.autoDispose.family<ArrivalCode, String>(
  (ref, id) => ref.watch(bookingRepositoryProvider).arrivalCode(id),
);

/// The PIN and QR the customer shows at the venue. Only issued shortly before the appointment; the QR expires.
/// Why there is no code right now, and when there will be. The server only issues one from shortly before the appointment starts
/// until it ends, and says when that opens (`opens_at`): the app turns that into the person's own clock time, or says that the
/// time has passed (it used to say "not just yet" for both, which sent people away from an appointment that was already over).
Widget _arrivalNotOpen(Booking booking, ApiException e) {
  final opensAt = DateTime.tryParse('${e.details['opens_at'] ?? ''}')?.toUtc();
  if (opensAt != null && !DateTime.now().toUtc().isBefore(opensAt)) {
    return const EmptyState(
      icon: Icons.event_busy_outlined,
      title: 'This appointment time has passed',
      message: 'Arrival codes are only available until the end of the appointment. If you still need help, contact the salon or TokenGo support.',
    );
  }
  String when = 'shortly before your appointment';
  if (opensAt != null) {
    final lead = booking.startAt.toUtc().difference(opensAt); // the check-in window, e.g. 30 minutes
    final opensLocal = DateTime.parse(booking.localStart).subtract(lead); // the same wall clock the booking is shown in
    when = '${formatDuration(lead.inMinutes)} before it, at ${formatLocalDateTime(opensLocal.toIso8601String().substring(0, 16))}';
  }
  return EmptyState(
    icon: Icons.schedule,
    title: 'Your code is not open yet',
    message: 'Your arrival code appears $when. Come back then, when you are at the salon.',
  );
}

class _ArrivalCodeSheet extends ConsumerWidget {
  const _ArrivalCodeSheet({required this.booking});

  final Booking booking;

  String get bookingId => booking.id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final code = ref.watch(_arrivalCodeProvider(bookingId));
    final t = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Gap.xl, 0, Gap.xl, Gap.xl),
        child: code.when(
          loading: () => const SizedBox(height: 260, child: Center(child: CircularProgressIndicator())),
          error: (e, _) {
            final outside = e is ApiException && e.code == 'OUTSIDE_CHECK_IN_WINDOW';
            // At least as tall as the loading state (so the sheet does not jump), taller when the message needs it.
            return ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 260),
              child: outside
                  ? _arrivalNotOpen(booking, e)
                  : ErrorState(error: e, onRetry: () => ref.invalidate(_arrivalCodeProvider(bookingId))),
            );
          },
          data: (c) => Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Show this at the salon', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: Gap.lg),
              Container(
                padding: const EdgeInsets.all(Gap.md),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(Corners.lg)),
                child: QrImageView(data: c.qrToken, size: 190),
              ),
              const SizedBox(height: Gap.lg),
              Text('or read out your PIN', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              Text(c.pin, style: t.textTheme.displayMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: 8)),
              const SizedBox(height: Gap.sm),
              Text(
                '${c.reference} · the QR code refreshes if it expires',
                style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
              ),
              TextButton.icon(
                onPressed: () => ref.invalidate(_arrivalCodeProvider(bookingId)),
                icon: const Icon(Icons.refresh),
                label: const Text('Refresh code'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
