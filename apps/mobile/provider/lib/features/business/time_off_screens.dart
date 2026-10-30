import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

DateTime _todayAt(String zone) => dateOfIso(todayIn(zone));

/// "Today", "Tomorrow", "Thu, 8 Oct" — relative to today AT THE LOCATION, not on the phone.
String _dayLabel(String isoDate, String zone) => formatLocalDate(isoDate, today: _todayAt(zone));

String _rangeLabel(ScheduleException e, String zone) {
  final days = e.startDate == e.endDate ? _dayLabel(e.startDate, zone) : '${_dayLabel(e.startDate, zone)} – ${_dayLabel(e.endDate, zone)}';
  final times = e.wholeDay ? '' : ' · ${formatLocalTime(e.start!)} – ${e.end == '24:00' ? 'midnight' : formatLocalTime(e.end!)}';
  return '$days$times';
}

/// Holidays, leave and special openings for a location or (with [staffId]) one staff member.
class TimeOffScreen extends ConsumerStatefulWidget {
  const TimeOffScreen.location({super.key, required String this.locationId}) : staffId = null;
  const TimeOffScreen.staff({super.key, required String this.staffId}) : locationId = null;

  final String? locationId;
  final String? staffId;

  @override
  ConsumerState<TimeOffScreen> createState() => _TimeOffScreenState();
}

class _TimeOffScreenState extends ConsumerState<TimeOffScreen> {
  final _attempt = AttemptKey();
  final _deleting = <String>{};

  bool get _forStaff => widget.staffId != null;

  Future<void> _add(String providerId, ExceptionDraft draft) async {
    final repo = ref.read(setupRepositoryProvider);
    final key = _attempt.keyFor(draft.toJson());
    try {
      if (_forStaff) {
        await repo.addStaffException(providerId, widget.staffId!, draft, idempotencyKey: key);
      } else {
        await repo.addLocationException(providerId, widget.locationId!, draft, idempotencyKey: key);
      }
      _attempt.reset();
    } finally {
      refreshSetup(ref);
    }
  }

  Future<void> _delete(String providerId, ScheduleException e, String zone) async {
    final ok = await confirmAction(
      context,
      title: 'Remove this entry?',
      message: _rangeLabel(e, zone),
      confirmLabel: 'Remove',
      destructive: true,
    );
    if (!ok || !mounted || _deleting.contains(e.id)) return;
    setState(() => _deleting.add(e.id));
    try {
      final repo = ref.read(setupRepositoryProvider);
      if (_forStaff) {
        await repo.deleteStaffException(providerId, widget.staffId!, e.id);
      } else {
        await repo.deleteLocationException(providerId, widget.locationId!, e.id);
      }
      if (mounted) showSnack(context, 'Removed.');
    } catch (err) {
      if (mounted) showSnack(context, errorMessage(err), error: true);
    } finally {
      refreshSetup(ref);
      if (mounted) setState(() => _deleting.remove(e.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final staff = _forStaff ? ref.watch(staffProvider).value?.where((s) => s.id == widget.staffId).firstOrNull : null;
    final locationId = _forStaff ? staff?.locationId : widget.locationId;
    final location = ref.watch(locationsProvider).value?.where((l) => l.id == locationId).firstOrNull;
    final zone = location?.timezone ?? LocationDraft.defaultTimezone;
    final value = _forStaff
        ? ref.watch(staffExceptionsProvider(widget.staffId!))
        : ref.watch(locationExceptionsProvider(widget.locationId!));
    final business = ref.watch(currentBusinessProvider).value;
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(_forStaff ? 'Leave & special hours' : 'Holidays & special openings')),
      floatingActionButton: business == null
          ? null
          : FloatingActionButton.extended(
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                showDragHandle: true,
                builder: (_) => _ExceptionSheet(zone: zone, staff: _forStaff, onSubmit: (d) => _add(business.id, d)),
              ),
              icon: const Icon(Icons.add_rounded),
              label: const Text('Add'),
            ),
      body: AsyncView(
        value: value,
        onRetry: () =>
            ref.invalidate(_forStaff ? staffExceptionsProvider(widget.staffId!) : locationExceptionsProvider(widget.locationId!)),
        builder: (list) {
          if (list.isEmpty) {
            return EmptyState(
              icon: Icons.event_busy_outlined,
              title: 'Nothing planned',
              message: _forStaff
                  ? 'Add leave, or extra hours on a day they do not normally work. Dates are on the salon\'s calendar ($zone).'
                  : 'Add a holiday, or a special opening on a day you are normally closed. Dates are on the salon\'s calendar ($zone).',
            );
          }
          final sorted = [...list]..sort((a, b) => a.startDate.compareTo(b.startDate));
          return ListView.separated(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.lg, 100),
            itemCount: sorted.length,
            separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
            itemBuilder: (_, i) {
              final e = sorted[i];
              return Card(
                child: ListTile(
                  leading: Icon(
                    e.isClosed ? Icons.event_busy_outlined : Icons.event_available_outlined,
                    color: e.isClosed ? context.statusColors.danger : context.statusColors.success,
                  ),
                  title: Text(e.isClosed ? 'Closed' : 'Special opening', style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text('${_rangeLabel(e, zone)}${e.reason == null ? '' : '\n${e.reason}'}'),
                  isThreeLine: e.reason != null,
                  trailing: _deleting.contains(e.id)
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                      : IconButton(
                          tooltip: 'Remove',
                          icon: Icon(Icons.delete_outline_rounded, color: t.colorScheme.error),
                          onPressed: business == null ? null : () => _delete(business.id, e, zone),
                        ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

class _ExceptionSheet extends StatefulWidget {
  const _ExceptionSheet({required this.zone, required this.staff, required this.onSubmit});

  final String zone;
  final bool staff;
  final Future<void> Function(ExceptionDraft draft) onSubmit;

  @override
  State<_ExceptionSheet> createState() => _ExceptionSheetState();
}

class _ExceptionSheetState extends State<_ExceptionSheet> {
  String _kind = 'CLOSED';
  String? _from;
  String? _to;
  bool _partDay = false;
  String? _timeFrom;
  String? _timeTo;
  final _reason = TextEditingController();
  final _errors = ServerErrors();
  bool _busy = false;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  ExceptionDraft _draft() => ExceptionDraft(
    kind: _kind,
    startDate: _from ?? '',
    endDate: _to,
    start: (_kind == 'OPEN' || _partDay) ? _timeFrom : null,
    end: (_kind == 'OPEN' || _partDay) ? _timeTo : null,
    reason: _reason.text,
  );

  Future<void> _pickDate({required bool first}) async {
    final today = _todayAt(widget.zone);
    final initial = dateOfIso((first ? _from : (_to ?? _from)) ?? isoDateOf(today));
    final picked = await showDatePicker(
      context: context,
      initialDate: initial.isBefore(today) ? today : initial,
      firstDate: today,
      lastDate: DateTime(today.year + 2, today.month, today.day),
      helpText: first ? 'First day' : 'Last day',
    );
    if (picked == null) return;
    setState(() {
      if (first) {
        _from = isoDateOf(picked);
        _errors.clearField('start_date');
        if (_to != null && _to!.compareTo(_from!) < 0) _to = null;
      } else {
        _to = isoDateOf(picked);
        _errors.clearField('end_date');
      }
    });
  }

  Future<void> _pickTime({required bool from}) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: timeOfHhmm((from ? _timeFrom : _timeTo) ?? (from ? '10:00' : '14:00')),
    );
    if (picked == null) return;
    setState(() {
      var text = hhmmOfTime(picked);
      if (!from && text == '00:00') text = '24:00';
      if (from) {
        _timeFrom = text;
      } else {
        _timeTo = text;
      }
      _errors
        ..clearField('start')
        ..clearField('end');
    });
  }

  Future<void> _submit() async {
    if (_busy) return;
    final draft = _draft();
    final problems = draft.validate();
    if (problems.isNotEmpty) {
      setState(() => _errors.setLocal(problems));
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      await widget.onSubmit(draft);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    Widget dateButton(String label, String? iso, VoidCallback onTap, String? error) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          onPressed: onTap,
          icon: const Icon(Icons.calendar_today_outlined, size: 18),
          label: Text(iso == null ? label : formatLocalDate(iso, today: _todayAt(widget.zone))),
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(error, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
          ),
      ],
    );
    Widget timeButton(String label, String? hhmm, VoidCallback onTap, String? error) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          onPressed: onTap,
          icon: const Icon(Icons.schedule_rounded, size: 18),
          label: Text(hhmm == null ? label : (hhmm == '24:00' ? 'Midnight' : formatLocalTime(hhmm))),
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(error, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
          ),
      ],
    );
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(Gap.xl, 0, Gap.xl, Gap.xl + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.staff ? 'Add leave or special hours' : 'Add a holiday or special opening',
              style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: Gap.md),
            FormBanner(_errors.banner(const {'start_date', 'end_date', 'start', 'end', 'reason'})),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(value: 'CLOSED', label: Text(widget.staff ? 'On leave' : 'Closed')),
                const ButtonSegment(value: 'OPEN', label: Text('Special opening')),
              ],
              selected: {_kind},
              onSelectionChanged: (s) => setState(() {
                _kind = s.first;
                _errors.clear();
              }),
            ),
            const SizedBox(height: Gap.lg),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: dateButton('First day', _from, () => _pickDate(first: true), _errors.field('start_date'))),
                const SizedBox(width: Gap.md),
                Expanded(child: dateButton('Last day', _to ?? _from, () => _pickDate(first: false), _errors.field('end_date'))),
              ],
            ),
            if (_kind == 'CLOSED')
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Only part of the day'),
                value: _partDay,
                onChanged: (v) => setState(() => _partDay = v),
              ),
            if (_kind == 'OPEN' || _partDay) ...[
              const SizedBox(height: Gap.sm),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: timeButton('From', _timeFrom, () => _pickTime(from: true), _errors.field('start'))),
                  const SizedBox(width: Gap.md),
                  Expanded(child: timeButton('To', _timeTo, () => _pickTime(from: false), _errors.field('end'))),
                ],
              ),
            ],
            const SizedBox(height: Gap.md),
            TextField(
              controller: _reason,
              maxLength: 200,
              onChanged: (_) => setState(() => _errors.clearField('reason')),
              decoration: InputDecoration(labelText: 'Reason (optional)', errorText: _errors.field('reason'), counterText: ''),
            ),
            const SizedBox(height: Gap.lg),
            BusyButton(label: 'Save', busy: _busy, onPressed: _submit),
          ],
        ),
      ),
    );
  }
}

/// Walk-ins and other time a stylist is not bookable. The server decides whether it fits (an existing booking in the way is
/// refused); times are typed in the LOCATION's clock and sent as exact instants.
class BlocksScreen extends ConsumerStatefulWidget {
  const BlocksScreen({super.key, required this.staffId});

  final String staffId;

  @override
  ConsumerState<BlocksScreen> createState() => _BlocksScreenState();
}

class _BlocksScreenState extends ConsumerState<BlocksScreen> {
  final _attempt = AttemptKey();
  bool _adding = false;
  final _releasing = <String>{};

  Future<void> _add(String providerId, BlockDraft draft) async {
    final key = _attempt.keyFor(draft.toJson());
    try {
      await ref.read(setupRepositoryProvider).addBlock(providerId, widget.staffId, draft, idempotencyKey: key);
      _attempt.reset();
    } finally {
      refreshSetup(ref);
    }
  }

  Future<void> _walkIn(String providerId, int minutes) async {
    if (_adding) return;
    setState(() => _adding = true);
    try {
      await _add(providerId, BlockDraft.walkIn(now: DateTime.now(), minutes: minutes));
      if (mounted) showSnack(context, 'Blocked for ${formatDuration(minutes)}.');
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      if (mounted) setState(() => _adding = false);
    }
  }

  Future<void> _release(String providerId, StaffBlock b) async {
    final ok = await confirmAction(
      context,
      title: 'Free this time?',
      message: 'The stylist becomes bookable again for this period.',
      confirmLabel: 'Free it',
    );
    if (!ok || !mounted || _releasing.contains(b.id)) return;
    setState(() => _releasing.add(b.id));
    try {
      await ref.read(setupRepositoryProvider).releaseBlock(providerId, widget.staffId, b.id);
      if (mounted) showSnack(context, 'Time freed.');
    } catch (e) {
      if (mounted) showSnack(context, errorMessage(e), error: true);
    } finally {
      refreshSetup(ref);
      if (mounted) setState(() => _releasing.remove(b.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final staff = ref.watch(staffProvider).value?.where((s) => s.id == widget.staffId).firstOrNull;
    final location = ref.watch(locationsProvider).value?.where((l) => l.id == staff?.locationId).firstOrNull;
    final zone = location?.timezone ?? LocationDraft.defaultTimezone;
    final blocks = ref.watch(staffBlocksProvider(widget.staffId));
    final business = ref.watch(currentBusinessProvider).value;
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(staff == null ? 'Walk-ins & blocks' : '${staff.displayName} · blocks')),
      floatingActionButton: business == null
          ? null
          : FloatingActionButton.extended(
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                showDragHandle: true,
                builder: (_) => _BlockSheet(zone: zone, onSubmit: (d) => _add(business.id, d)),
              ),
              icon: const Icon(Icons.add_rounded),
              label: const Text('Block time'),
            ),
      body: AsyncView(
        value: blocks,
        onRetry: () => ref.invalidate(staffBlocksProvider(widget.staffId)),
        builder: (list) => ListView(
          padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.lg, 100),
          children: [
            Text(
              'Someone walked in? Block the stylist so nobody books that time online. Times are in $zone.',
              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: Gap.md),
            Wrap(
              spacing: Gap.sm,
              runSpacing: Gap.sm,
              children: [
                for (final m in const [30, 60, 120])
                  ActionChip(
                    avatar: const Icon(Icons.directions_walk_rounded, size: 18),
                    label: Text('Walk-in now · ${formatDuration(m)}'),
                    onPressed: (_adding || business == null) ? null : () => _walkIn(business.id, m),
                  ),
              ],
            ),
            const SizedBox(height: Gap.lg),
            if (list.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: Gap.xl),
                child: Center(child: Text('No upcoming blocks')),
              ),
            for (final b in list)
              Padding(
                padding: const EdgeInsets.only(bottom: Gap.md),
                child: Card(
                  child: ListTile(
                    leading: const Icon(Icons.block_rounded),
                    title: Text(_blockLabel(b, zone), style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: b.reason == null ? null : Text(b.reason!),
                    trailing: _releasing.contains(b.id)
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                        : IconButton(
                            tooltip: 'Free this time',
                            icon: const Icon(Icons.close_rounded),
                            onPressed: business == null ? null : () => _release(business.id, b),
                          ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

String _blockLabel(StaffBlock b, String zone) {
  final s = localParts(zone, b.startAt);
  final e = localParts(zone, b.endAt);
  final day = _dayLabel(s.date, zone);
  final endDay = s.date == e.date ? '' : '${_dayLabel(e.date, zone)} ';
  return '$day · ${formatLocalTime(s.time)} – $endDay${formatLocalTime(e.time)}';
}

class _BlockSheet extends StatefulWidget {
  const _BlockSheet({required this.zone, required this.onSubmit});

  final String zone;
  final Future<void> Function(BlockDraft draft) onSubmit;

  @override
  State<_BlockSheet> createState() => _BlockSheetState();
}

class _BlockSheetState extends State<_BlockSheet> {
  String? _date;
  String? _start;
  String? _end;
  final _reason = TextEditingController();
  final _errors = ServerErrors();
  bool _busy = false;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final today = _todayAt(widget.zone);
    final picked = await showDatePicker(
      context: context,
      initialDate: _date == null ? today : dateOfIso(_date!),
      firstDate: today,
      lastDate: DateTime(today.year + 1, today.month, today.day),
    );
    if (picked != null) setState(() => _date = isoDateOf(picked));
  }

  Future<void> _pickTime({required bool start}) async {
    final picked = await showTimePicker(context: context, initialTime: timeOfHhmm((start ? _start : _end) ?? (start ? '10:00' : '11:00')));
    if (picked == null) return;
    setState(() {
      if (start) {
        _start = hhmmOfTime(picked);
      } else {
        _end = hhmmOfTime(picked);
      }
    });
  }

  Future<void> _submit() async {
    if (_busy) return;
    if (_date == null || _start == null || _end == null) {
      setState(() => _errors.setLocal({'start_at': 'Pick the day and both times'}));
      return;
    }
    final draft = BlockDraft.local(zone: widget.zone, date: _date!, start: _start!, end: _end!, reason: _reason.text);
    final problems = draft.validate();
    if (problems.isNotEmpty) {
      setState(() => _errors.setLocal(problems));
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      await widget.onSubmit(draft);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
            Text('Block time', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: Gap.xs),
            Text('In the salon\'s clock (${widget.zone}).', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            const SizedBox(height: Gap.md),
            FormBanner(_errors.banner(const {'reason'})),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              onPressed: _pickDate,
              icon: const Icon(Icons.calendar_today_outlined, size: 18),
              label: Text(_date == null ? 'Day' : formatLocalDate(_date!, today: _todayAt(widget.zone))),
            ),
            const SizedBox(height: Gap.md),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    onPressed: () => _pickTime(start: true),
                    icon: const Icon(Icons.schedule_rounded, size: 18),
                    label: Text(_start == null ? 'From' : formatLocalTime(_start!)),
                  ),
                ),
                const SizedBox(width: Gap.md),
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    onPressed: () => _pickTime(start: false),
                    icon: const Icon(Icons.schedule_rounded, size: 18),
                    label: Text(_end == null ? 'To' : formatLocalTime(_end!)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: Gap.md),
            TextField(
              controller: _reason,
              maxLength: 200,
              onChanged: (_) => setState(() => _errors.clearField('reason')),
              decoration: InputDecoration(labelText: 'Note (optional)', errorText: _errors.field('reason'), counterText: ''),
            ),
            const SizedBox(height: Gap.lg),
            BusyButton(label: 'Block this time', busy: _busy, onPressed: _submit),
          ],
        ),
      ),
    );
  }
}
