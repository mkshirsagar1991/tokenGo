import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

/// How bookings work for this business. The server owns the rules and their limits; this screen shows the values in force
/// and sends them back exactly as shown.
class PolicyScreen extends ConsumerWidget {
  const PolicyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final policy = ref.watch(policyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Booking rules')),
      body: AsyncView(
        value: policy,
        onRetry: () => ref.invalidate(policyProvider),
        builder: (p) =>
            p == null ? const EmptyState(icon: Icons.rule_rounded, title: 'Register your business first') : _PolicyForm(initial: p),
      ),
    );
  }
}

class _PolicyForm extends ConsumerStatefulWidget {
  const _PolicyForm({required this.initial});

  final BookingPolicy initial;

  @override
  ConsumerState<_PolicyForm> createState() => _PolicyFormState();
}

class _PolicyFormState extends ConsumerState<_PolicyForm> {
  late BookingPolicy _baseline = widget.initial;
  late int _granularity = widget.initial.slotGranularityMin;
  late final _lead = TextEditingController(text: '${widget.initial.minLeadTimeMin}');
  late final _advance = TextEditingController(text: '${widget.initial.maxAdvanceDays}');
  late final _response = TextEditingController(text: '${widget.initial.responseDeadlineMin}');
  late final _checkIn = TextEditingController(text: '${widget.initial.checkInWindowMin}');
  late final _noShow = TextEditingController(text: '${widget.initial.noShowGraceMin}');
  late final _hold = TextEditingController(text: '${widget.initial.settlementHoldHours}');
  final _errors = ServerErrors();
  bool _busy = false;

  static const _fields = {
    'slot_granularity_min',
    'min_lead_time_min',
    'max_advance_days',
    'response_deadline_min',
    'check_in_window_min',
    'no_show_grace_min',
    'settlement_hold_hours',
  };

  @override
  void dispose() {
    for (final c in [_lead, _advance, _response, _checkIn, _noShow, _hold]) {
      c.dispose();
    }
    super.dispose();
  }

  BookingPolicy _draft() => BookingPolicy(
    slotGranularityMin: _granularity,
    minLeadTimeMin: int.tryParse(_lead.text) ?? -1,
    maxAdvanceDays: int.tryParse(_advance.text) ?? -1,
    responseDeadlineMin: int.tryParse(_response.text) ?? -1,
    checkInWindowMin: int.tryParse(_checkIn.text) ?? -1,
    noShowGraceMin: int.tryParse(_noShow.text) ?? -1,
    settlementHoldHours: int.tryParse(_hold.text) ?? -1,
  );

  void _fill(BookingPolicy p) {
    _baseline = p;
    _granularity = p.slotGranularityMin;
    _lead.text = '${p.minLeadTimeMin}';
    _advance.text = '${p.maxAdvanceDays}';
    _response.text = '${p.responseDeadlineMin}';
    _checkIn.text = '${p.checkInWindowMin}';
    _noShow.text = '${p.noShowGraceMin}';
    _hold.text = '${p.settlementHoldHours}';
  }

  Future<void> _save() async {
    if (_busy) return;
    final draft = _draft();
    final problems = draft.validate();
    if (problems.isNotEmpty) {
      setState(() => _errors.setLocal(problems));
      return;
    }
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null || !mounted) return;
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      final saved = await ref.read(setupRepositoryProvider).setPolicy(business.id, draft);
      if (mounted) {
        setState(() => _fill(saved));
        showSnack(context, 'Booking rules saved.');
      }
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      ref.invalidate(policyProvider);
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reset() async {
    final ok = await confirmAction(
      context,
      title: 'Use TokenGo\'s standard rules?',
      message: 'Every value goes back to the platform default, and follows it if TokenGo changes it.',
      confirmLabel: 'Reset',
    );
    if (!ok || !mounted || _busy) return;
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null || !mounted) return;
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      final defaults = await ref.read(setupRepositoryProvider).resetPolicy(business.id);
      if (mounted) {
        setState(() => _fill(defaults));
        showSnack(context, 'Back to the standard rules.');
      }
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      ref.invalidate(policyProvider);
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _number(TextEditingController c, String field, String label, String unit, String helper) => Padding(
    padding: const EdgeInsets.only(bottom: Gap.lg),
    child: TextField(
      controller: c,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(5)],
      onChanged: (_) => setState(() => _errors.clearField(field)),
      decoration: InputDecoration(
        labelText: label,
        suffixText: unit,
        helperText: helper,
        helperMaxLines: 3,
        errorText: _errors.field(field),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final dirty = _draft() != _baseline;
    return ListView(
      padding: const EdgeInsets.all(Gap.lg),
      children: [
        Text(
          'Customers request a booking and you accept or decline it. These rules control how requests behave.',
          style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: Gap.lg),
        FormBanner(_errors.banner(_fields)),
        _number(
          _response,
          'response_deadline_min',
          'Answer requests within',
          'min',
          'If you do not accept or decline in time, the request expires and the customer is refunded in full.',
        ),
        Text('Start times offered every', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: Gap.sm),
        Wrap(
          spacing: Gap.sm,
          children: [
            for (final g in BookingPolicy.granularities)
              ChoiceChip(
                label: Text('$g min'),
                selected: _granularity == g,
                onSelected: (_) => setState(() {
                  _granularity = g;
                  _errors.clearField('slot_granularity_min');
                }),
              ),
          ],
        ),
        if (_errors.field('slot_granularity_min') != null)
          Text(_errors.field('slot_granularity_min')!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
        const SizedBox(height: Gap.lg),
        _number(
          _lead,
          'min_lead_time_min',
          'Notice needed before a booking',
          'min',
          'Customers cannot book a start time sooner than this.',
        ),
        _number(_advance, 'max_advance_days', 'How far ahead customers can book', 'days', 'The furthest day offered, counting from today.'),
        _number(_checkIn, 'check_in_window_min', 'Check-in opens', 'min before', 'How early you can verify the customer\'s arrival.'),
        _number(
          _noShow,
          'no_show_grace_min',
          'Wait before marking a no-show',
          'min',
          'How long after the start time before a no-show can be marked.',
        ),
        _number(
          _hold,
          'settlement_hold_hours',
          'Payment release delay',
          'hours',
          'After you complete a service, the customer can raise a problem for this long before the payment is released to you.',
        ),
        const SizedBox(height: Gap.sm),
        BusyButton(label: dirty ? 'Save rules' : 'Saved', busy: _busy, onPressed: dirty ? _save : null),
        const SizedBox(height: Gap.md),
        TextButton(onPressed: _busy ? null : _reset, child: const Text('Use TokenGo\'s standard rules')),
      ],
    );
  }
}
