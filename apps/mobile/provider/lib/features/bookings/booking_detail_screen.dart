import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'booking_widgets.dart';
import 'bookings_state.dart';
import 'qr_scan_screen.dart';

/// One booking, and the next thing the salon can do with it. The buttons offered follow the server's status; the server
/// still decides whether each action is allowed (and says why not).
class BookingDetailScreen extends ConsumerStatefulWidget {
  const BookingDetailScreen({super.key, required this.bookingId});

  final String bookingId;

  @override
  ConsumerState<BookingDetailScreen> createState() => _BookingDetailScreenState();
}

class _BookingDetailScreenState extends ConsumerState<BookingDetailScreen> {
  bool _busy = false;

  /// Runs one action; shows the server's own message when it refuses, and always refreshes from the server afterwards.
  Future<void> _run(Future<Booking> Function(ProviderRepository repo) action, {String? done}) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action(ref.read(providerRepositoryProvider));
      if (mounted && done != null) showSnack(context, done);
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
      if (mounted) refreshBookings(ref, bookingId: widget.bookingId);
    }
  }

  Future<void> _decline(Booking b) async {
    final r = await askReason(context, title: 'Decline this booking?', confirmLabel: 'Decline booking');
    if (r == null) return;
    await _run(
      (repo) => repo.reject(b.id, reasonCode: r.code, note: r.note),
      done: 'Declined. The customer is refunded in full.',
    );
  }

  Future<void> _cancel(Booking b) async {
    final r = await askReason(context, title: 'Cancel this booking?', confirmLabel: 'Cancel booking');
    if (r == null) return;
    await _run(
      (repo) => repo.cancel(b.id, reasonCode: r.code, note: r.note),
      done: 'Cancelled. The customer is refunded in full.',
    );
  }

  /// Types in the customer's 6-digit code (the always-available path).
  Future<void> _verifyArrival(Booking b) async {
    final pin = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _PinSheet(),
    );
    if (pin == null) return;
    await _run((repo) => repo.verifyArrival(b.id, pin: pin), done: 'Customer checked in.');
  }

  /// Reads the QR on the customer's phone. The camera permission is asked for only now, when the scanner opens. The token goes
  /// to the server untouched; the server checks its signature and expiry and says why when it refuses.
  Future<void> _scanArrival(Booking b) async {
    final scanned = await ref.read(qrScanLauncherProvider)(context);
    if (scanned == null || !mounted) return; // backed out
    final token = arrivalTokenFrom(scanned);
    if (token == null) {
      showSnack(context, 'That is not a TokenGo arrival code. Ask the customer to open the code in their app.', error: true);
      return;
    }
    await _run((repo) => repo.verifyArrivalQr(b.id, qrToken: token), done: 'Customer checked in.');
  }

  Future<void> _confirmNoShow(Booking b) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Mark as no-show?'),
        content: const Text('Use this only if the customer did not come. Payment handling follows the cancellation policy.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not yet')),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(100, 44)),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('No-show'),
          ),
        ],
      ),
    );
    if (ok == true) await _run((repo) => repo.markNoShow(b.id), done: 'Marked as no-show.');
  }

  @override
  Widget build(BuildContext context) {
    final booking = ref.watch(bookingProvider(widget.bookingId));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Booking'),
        leading: BackButton(onPressed: () => context.canPop() ? context.pop() : context.go('/')),
      ),
      body: booking.when(
        loading: () => const BrandLoader(),
        error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(bookingProvider(widget.bookingId))),
        data: (b) => RefreshIndicator(
          onRefresh: () => ref.refresh(bookingProvider(widget.bookingId).future),
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(Gap.lg),
            children: [
              _Header(booking: b),
              const SizedBox(height: Gap.md),
              _Details(booking: b),
              const SizedBox(height: Gap.lg),
              _Actions(
                booking: b,
                busy: _busy,
                onApprove: () => _run((r) => r.approve(b.id), done: 'Accepted. The customer has been told.'),
                onDecline: () => _decline(b),
                onCancel: () => _cancel(b),
                onVerify: () => _verifyArrival(b),
                onScan: () => _scanArrival(b),
                onStart: () => _run((r) => r.startService(b.id), done: 'Service started.'),
                onComplete: () =>
                    _run((r) => r.completeService(b.id), done: 'Marked complete. Payment is released once the customer confirms.'),
                onNoShow: () => _confirmNoShow(b),
              ),
              const SizedBox(height: Gap.xl),
              _Timeline(bookingId: b.id),
            ],
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.booking});

  final Booking booking;

  /// The brand illustration for the states that have one: the customer has checked in, and a booking that did not go ahead.
  static BrandArt? _art(String status) => switch (status) {
    BookingStatus.customerArrived => BrandArt.successCheckin,
    BookingStatus.customerCancelled ||
    BookingStatus.providerCancelled ||
    BookingStatus.providerRejected ||
    BookingStatus.expired => BrandArt.errorBookingCancelled,
    _ => null,
  };

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final step = nextStep(booking);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_art(booking.status) case final art?) ...[
              Center(child: BrandImage(art, height: 84)),
              const SizedBox(height: Gap.md),
            ],
            Row(
              children: [
                Expanded(
                  child: Text(booking.serviceName, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                ),
                StatusPill(providerStatusLabel(booking.status), tone: bookingTone(booking.status)),
              ],
            ),
            const SizedBox(height: Gap.xs),
            Text('Ref ${booking.reference}', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            if (step != null) ...[
              const SizedBox(height: Gap.md),
              Row(
                children: [
                  Icon(Icons.arrow_forward_rounded, size: 18, color: t.colorScheme.primary),
                  const SizedBox(width: Gap.sm),
                  Expanded(
                    child: Text(step, style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
            ],
            if (booking.statusReason != null) ...[
              const SizedBox(height: Gap.sm),
              Text(booking.statusReason!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            ],
          ],
        ),
      ),
    );
  }
}

class _Details extends StatelessWidget {
  const _Details({required this.booking});

  final Booking booking;

  @override
  Widget build(BuildContext context) {
    Widget row(IconData icon, String label, String value) => Padding(
      padding: const EdgeInsets.symmetric(vertical: Gap.xs + 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: Gap.md),
          SizedBox(
            width: 84,
            child: Text(
              label,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
          ),
          Expanded(
            child: Text(value, style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          children: [
            if (booking.hasSeveralServices)
              row(Icons.content_cut_rounded, 'Services', [for (final s in booking.services) '${s.name} · ${s.price.format()}'].join('\n')),
            row(Icons.event_outlined, 'When', formatLocalDateTime(booking.localStart)),
            row(Icons.timer_outlined, 'Duration', formatDuration(booking.durationMin)),
            row(Icons.store_outlined, 'Where', booking.locationName ?? '-'),
            if (booking.staffName != null) row(Icons.person_outline_rounded, 'Stylist', booking.staffName!),
            row(Icons.currency_rupee_rounded, 'Price', booking.price.format()),
            if (booking.note != null && booking.note!.isNotEmpty) row(Icons.sticky_note_2_outlined, 'Note', booking.note!),
          ],
        ),
      ),
    );
  }
}

class _Actions extends StatelessWidget {
  const _Actions({
    required this.booking,
    required this.busy,
    required this.onApprove,
    required this.onDecline,
    required this.onCancel,
    required this.onVerify,
    required this.onScan,
    required this.onStart,
    required this.onComplete,
    required this.onNoShow,
  });

  final Booking booking;
  final bool busy;
  final VoidCallback onApprove, onDecline, onCancel, onVerify, onScan, onStart, onComplete, onNoShow;

  @override
  Widget build(BuildContext context) {
    final spinner = const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.5));
    Widget primary(String label, VoidCallback onTap, {IconData? icon}) =>
        FilledButton.icon(onPressed: busy ? null : onTap, icon: busy ? spinner : Icon(icon ?? Icons.check_rounded), label: Text(label));
    Widget secondary(String label, VoidCallback onTap, {bool danger = false}) => OutlinedButton(
      style: danger
          ? OutlinedButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.error,
              side: BorderSide(color: Theme.of(context).colorScheme.error.withValues(alpha: 0.5)),
            )
          : null,
      onPressed: busy ? null : onTap,
      child: Text(label),
    );
    final gap = const SizedBox(height: Gap.md);
    return switch (booking.status) {
      BookingStatus.requested => Column(
        children: [primary('Accept booking', onApprove), gap, secondary('Decline', onDecline, danger: true)],
      ),
      BookingStatus.confirmed => Column(
        children: [
          primary('Scan customer QR', onScan, icon: Icons.qr_code_scanner_rounded),
          gap,
          secondary('Enter 6-digit code', onVerify),
          gap,
          secondary('Mark no-show', onNoShow),
          gap,
          secondary('Cancel booking', onCancel, danger: true),
        ],
      ),
      BookingStatus.customerArrived => Column(
        children: [
          primary('Start service', onStart, icon: Icons.play_arrow_rounded),
          gap,
          secondary('Cancel booking', onCancel, danger: true),
        ],
      ),
      BookingStatus.serviceStarted => primary('Mark service complete', onComplete, icon: Icons.done_all_rounded),
      _ => const SizedBox.shrink(),
    };
  }
}

/// Six digits the customer reads out (or shows in their app). Wrong codes are counted by the server, which locks after a few tries.
class _PinSheet extends StatefulWidget {
  const _PinSheet();

  @override
  State<_PinSheet> createState() => _PinSheetState();
}

class _PinSheetState extends State<_PinSheet> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(Gap.xl, 0, Gap.xl, Gap.xl + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Customer\'s arrival code', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: Gap.xs),
            Text(
              'Ask the customer for the 6-digit code shown in their TokenGo app.',
              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: Gap.lg),
            TextField(
              controller: _controller,
              autofocus: true,
              keyboardType: TextInputType.number,
              textAlign: TextAlign.center,
              maxLength: 6,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              style: t.textTheme.displaySmall?.copyWith(letterSpacing: 12, fontWeight: FontWeight.w700),
              onChanged: (_) => setState(() {}),
              onSubmitted: (v) {
                if (v.length == 6) Navigator.of(context).pop(v);
              },
              decoration: const InputDecoration(counterText: '', hintText: '••••••'),
            ),
            const SizedBox(height: Gap.lg),
            FilledButton(
              onPressed: _controller.text.length == 6 ? () => Navigator.of(context).pop(_controller.text) : null,
              child: const Text('Verify'),
            ),
          ],
        ),
      ),
    );
  }
}

class _Timeline extends ConsumerWidget {
  const _Timeline({required this.bookingId});

  final String bookingId;

  static final _fmt = DateFormat('d MMM · h:mm a');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(_eventsProvider(bookingId));
    final t = Theme.of(context);
    return events.maybeWhen(
      data: (list) => list.isEmpty
          ? const SizedBox.shrink()
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('History', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: Gap.sm),
                for (final e in list)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        Icon(Icons.circle, size: 8, color: t.colorScheme.outline),
                        const SizedBox(width: Gap.md),
                        Expanded(
                          child: Text(e.toStatus == null ? e.type : providerStatusLabel(e.toStatus!), style: t.textTheme.bodyMedium),
                        ),
                        Text(
                          _fmt.format(e.occurredAt.toLocal()),
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

final _eventsProvider = FutureProvider.autoDispose.family<List<BookingEvent>, String>((ref, id) {
  ref.watch(sessionUserProvider);
  ref.watch(bookingProvider(id)); // reload the history whenever the booking changes
  return ref.watch(providerRepositoryProvider).events(id);
});
