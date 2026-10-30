import 'package:flutter/material.dart';
import 'package:tokengo_core/tokengo_core.dart';

/// How a booking status reads to the salon (the customer's wording differs: "Waiting for the salon" vs "New request").
String providerStatusLabel(String status) => switch (status) {
  BookingStatus.requested => 'New request',
  BookingStatus.confirmed => 'Confirmed',
  BookingStatus.providerRejected => 'Declined',
  BookingStatus.expired => 'Expired — no response',
  BookingStatus.customerCancelled => 'Cancelled by customer',
  BookingStatus.providerCancelled => 'Cancelled by you',
  BookingStatus.noShow => 'No-show',
  BookingStatus.customerArrived => 'Customer arrived',
  BookingStatus.serviceStarted => 'In progress',
  BookingStatus.serviceCompleted => 'Done — awaiting customer',
  BookingStatus.disputed => 'Under review',
  BookingStatus.closed => 'Completed',
  _ => status,
};

/// What the salon should do next, in a few words (null = nothing).
String? nextStep(Booking b) => switch (b.status) {
  BookingStatus.requested => 'Accept or decline',
  BookingStatus.confirmed => 'Verify the customer\'s code when they arrive',
  BookingStatus.customerArrived => 'Start the service',
  BookingStatus.serviceStarted => 'Mark it complete when done',
  BookingStatus.serviceCompleted => 'Payment is released when the customer confirms, or automatically after the review window',
  _ => null,
};

class BookingTile extends StatelessWidget {
  const BookingTile({super.key, required this.booking, required this.onTap, this.footer});

  final Booking booking;
  final VoidCallback onTap;

  /// Quick actions under the details (e.g. Accept / Decline).
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(Gap.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(booking.serviceName, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  ),
                  Text(booking.price.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                ],
              ),
              const SizedBox(height: Gap.xs),
              Text(
                '${booking.reference}${booking.locationName == null ? '' : ' · ${booking.locationName}'}',
                style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: Gap.md),
              Row(
                children: [
                  Icon(Icons.event_outlined, size: 18, color: t.colorScheme.primary),
                  const SizedBox(width: Gap.sm),
                  Expanded(
                    child: Text(
                      formatLocalDateTime(booking.localStart),
                      style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                  StatusPill(providerStatusLabel(booking.status), tone: bookingTone(booking.status)),
                ],
              ),
              if (booking.status == BookingStatus.requested && booking.responseDeadlineAt != null) ...[
                const SizedBox(height: Gap.sm),
                Text(
                  'Respond ${formatCountdown(booking.responseDeadlineAt!)} or it expires',
                  style: t.textTheme.bodySmall?.copyWith(color: context.statusColors.warning, fontWeight: FontWeight.w600),
                ),
              ],
              if (footer != null) ...[const SizedBox(height: Gap.md), footer!],
            ],
          ),
        ),
      ),
    );
  }
}

/// Asks WHY a booking is being declined or cancelled. Returns null if dismissed.
Future<({String code, String? note})?> askReason(BuildContext context, {required String title, required String confirmLabel}) {
  return showModalBottomSheet<({String code, String? note})>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _ReasonSheet(title: title, confirmLabel: confirmLabel),
  );
}

class _ReasonSheet extends StatefulWidget {
  const _ReasonSheet({required this.title, required this.confirmLabel});

  final String title;
  final String confirmLabel;

  @override
  State<_ReasonSheet> createState() => _ReasonSheetState();
}

class _ReasonSheetState extends State<_ReasonSheet> {
  String? _code;
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
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
            Text(widget.title, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: Gap.xs),
            Text(
              'The customer is told, and gets their money back in full.',
              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: Gap.md),
            RadioGroup<String>(
              groupValue: _code,
              onChanged: (v) => setState(() => _code = v),
              child: Column(
                children: [
                  for (final c in ProviderReason.all)
                    RadioListTile<String>(contentPadding: EdgeInsets.zero, value: c, title: Text(ProviderReason.label(c))),
                ],
              ),
            ),
            TextField(
              controller: _note,
              maxLength: 500,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Note (optional)'),
            ),
            const SizedBox(height: Gap.md),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: t.colorScheme.error, foregroundColor: t.colorScheme.onError),
              onPressed: _code == null
                  ? null
                  : () => Navigator.of(context).pop((code: _code!, note: _note.text.trim().isEmpty ? null : _note.text.trim())),
              child: Text(widget.confirmLabel),
            ),
          ],
        ),
      ),
    );
  }
}
