import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

/// A location's weekly opening hours, breaks included. The clock is the LOCATION's, whatever time zone the phone is in.
class LocationHoursScreen extends ConsumerWidget {
  const LocationHoursScreen({super.key, required this.locationId});

  final String locationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hours = ref.watch(locationHoursProvider(locationId));
    final locations = ref.watch(locationsProvider).value ?? const <OwnedLocation>[];
    final location = locations.where((l) => l.id == locationId).firstOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(location == null ? 'Opening hours' : '${location.name} · hours')),
      body: AsyncView(
        value: hours,
        onRetry: () => ref.invalidate(locationHoursProvider(locationId)),
        builder: (h) => HoursForm(
          initial: h,
          zone: location?.timezone,
          intro: 'Customers can book only inside these hours. Add a break to block time inside a day.',
          onSave: (draft) async {
            final business = await ref.read(currentBusinessProvider.future);
            if (business == null) throw StateError('No business');
            try {
              return await ref.read(setupRepositoryProvider).setLocationHours(business.id, locationId, draft);
            } finally {
              refreshSetup(ref);
            }
          },
        ),
      ),
    );
  }
}

/// A staff member's own hours. With no opening windows of their own they follow the location's hours.
class StaffScheduleScreen extends ConsumerWidget {
  const StaffScheduleScreen({super.key, required this.staffId});

  final String staffId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final staff = ref.watch(staffProvider).value?.where((s) => s.id == staffId).firstOrNull;
    final schedule = ref.watch(staffScheduleProvider(staffId));
    final locationHours = staff == null ? null : ref.watch(locationHoursProvider(staff.locationId)).value;
    final location = staff == null ? null : ref.watch(locationsProvider).value?.where((l) => l.id == staff.locationId).firstOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(staff == null ? 'Working hours' : '${staff.displayName} · hours')),
      body: AsyncView(
        value: schedule,
        onRetry: () => ref.invalidate(staffScheduleProvider(staffId)),
        builder: (h) => HoursForm(
          initial: h,
          zone: location?.timezone,
          staffMode: true,
          locationHours: locationHours,
          intro: 'Leave "Same as the salon" on to follow the opening hours. Turn it off to set days and times just for this person.',
          onSave: (draft) async {
            final business = await ref.read(currentBusinessProvider.future);
            if (business == null) throw StateError('No business');
            try {
              return await ref.read(setupRepositoryProvider).setStaffSchedule(business.id, staffId, draft);
            } finally {
              refreshSetup(ref);
            }
          },
        ),
      ),
    );
  }
}

/// The weekly editor shared by the location and the staff screens. Unsaved edits are kept until Save; leaving with unsaved edits
/// asks first.
class HoursForm extends StatefulWidget {
  const HoursForm({
    super.key,
    required this.initial,
    required this.onSave,
    required this.intro,
    this.zone,
    this.staffMode = false,
    this.locationHours,
  });

  final WeeklyHours initial;
  final Future<WeeklyHours> Function(WeeklyHours draft) onSave;
  final String intro;
  final String? zone;

  /// Staff: no opening windows means "same as the salon", and only breaks are edited in that mode.
  final bool staffMode;
  final WeeklyHours? locationHours;

  @override
  State<HoursForm> createState() => _HoursFormState();
}

class _HoursFormState extends State<HoursForm> {
  late WeeklyHours _baseline = widget.initial;
  late WeeklyHours _draft = widget.initial;
  final _errors = ServerErrors();
  bool _busy = false;

  bool get _dirty => _draft != _baseline;
  bool get _followsSalon => widget.staffMode && _draft.working.isEmpty;

  @override
  void didUpdateWidget(covariant HoursForm old) {
    super.didUpdateWidget(old);
    if (widget.initial != old.initial && !_dirty) {
      _baseline = widget.initial;
      _draft = widget.initial;
    }
  }

  void _change(WeeklyHours h) => setState(() {
    _draft = h;
    _errors.clear();
  });

  Future<void> _save() async {
    if (_busy) return;
    final problems = _draft.validate();
    if (problems.isNotEmpty) {
      setState(() => _errors.setLocal(problems));
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      final saved = await widget.onSave(_draft);
      if (!mounted) return;
      setState(() {
        _baseline = saved;
        _draft = saved;
      });
      showSnack(context, 'Hours saved.');
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = await confirmAction(
          context,
          title: 'Discard your changes?',
          message: 'The hours you edited have not been saved.',
          confirmLabel: 'Discard',
          cancelLabel: 'Keep editing',
          destructive: true,
        );
        if (leave && context.mounted) Navigator.of(context).pop();
      },
      child: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(Gap.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(widget.intro, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                  if (widget.zone != null)
                    Padding(
                      padding: const EdgeInsets.only(top: Gap.xs),
                      child: Text('Times are in ${widget.zone}.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.outline)),
                    ),
                  const SizedBox(height: Gap.md),
                  FormBanner(_errors.banner(const {})),
                  if (widget.staffMode)
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Same as the salon'),
                      subtitle: const Text('Works whenever the location is open'),
                      value: _followsSalon,
                      onChanged: _busy
                          ? null
                          : (follow) {
                              if (follow) {
                                _change(WeeklyHours(breaks: _draft.breaks));
                              } else {
                                // Start from the salon's own hours so there is something sensible to adjust.
                                final base = widget.locationHours?.working ?? const <HoursWindow>[];
                                _change(
                                  WeeklyHours(
                                    working: base.isEmpty
                                        ? WeeklyHours.uniform(weekdays: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00').working
                                        : base,
                                    breaks: _draft.breaks,
                                  ),
                                );
                              }
                            },
                    ),
                  if (!widget.staffMode && _draft.working.isEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: Gap.md),
                      child: OutlinedButton.icon(
                        onPressed: () => _change(WeeklyHours.uniform(weekdays: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00')),
                        icon: const Icon(Icons.auto_awesome_outlined),
                        label: const Text('Start with 9 AM – 7 PM, Monday to Saturday'),
                      ),
                    ),
                  for (var day = 1; day <= 7; day++)
                    Padding(
                      padding: const EdgeInsets.only(bottom: Gap.md),
                      child: _DayCard(day: day, hours: _draft, showWorking: !_followsSalon, enabled: !_busy, onChanged: _change),
                    ),
                ],
              ),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.sm, Gap.lg, Gap.lg),
              child: BusyButton(label: _dirty ? 'Save hours' : 'Saved', busy: _busy, onPressed: _dirty ? _save : null),
            ),
          ),
        ],
      ),
    );
  }
}

class _DayCard extends StatelessWidget {
  const _DayCard({required this.day, required this.hours, required this.showWorking, required this.enabled, required this.onChanged});

  final int day;
  final WeeklyHours hours;
  final bool showWorking;
  final bool enabled;
  final ValueChanged<WeeklyHours> onChanged;

  Future<HoursWindow?> _pick(BuildContext context, {HoursWindow? initial, required String label}) async {
    final start = await showTimePicker(context: context, initialTime: timeOfHhmm(initial?.start ?? '09:00'), helpText: '$label starts');
    if (start == null || !context.mounted) return null;
    final end = await showTimePicker(
      context: context,
      initialTime: timeOfHhmm(initial?.end ?? '19:00'),
      helpText: '$label ends (12:00 AM = midnight)',
    );
    if (end == null || !context.mounted) return null;
    final startText = hhmmOfTime(start);
    var endText = hhmmOfTime(end);
    if (endText == '00:00') endText = '24:00';
    final w = HoursWindow(day, startText, endText);
    if (w.endMin <= w.startMin) {
      showSnack(context, 'The end time must be after the start time.', error: true);
      return null;
    }
    return w;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final working = hours.workingOn(day);
    final breaks = hours.breaksOn(day);
    final open = hours.isOpenOn(day);
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.sm, Gap.sm, Gap.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(WeeklyHours.weekdayLong(day), style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                ),
                if (showWorking)
                  Switch(
                    value: open,
                    onChanged: !enabled
                        ? null
                        : (on) => onChanged(on ? hours.add(HoursWindow(day, '09:00', '19:00'), isBreak: false) : hours.closeDay(day)),
                  ),
                if (open || breaks.isNotEmpty)
                  PopupMenuButton<String>(
                    tooltip: 'More',
                    enabled: enabled,
                    onSelected: (v) => onChanged(hours.copyDay(day, [for (var d = 1; d <= 7; d++) d])),
                    itemBuilder: (_) => const [PopupMenuItem(value: 'all', child: Text('Copy to all days'))],
                  ),
              ],
            ),
            if (showWorking && !open) Text('Closed', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.outline)),
            if (showWorking)
              for (final w in working)
                _WindowRow(
                  icon: Icons.schedule_rounded,
                  label: windowLabel(w),
                  enabled: enabled,
                  onTap: () async {
                    final updated = await _pick(context, initial: w, label: 'Open');
                    if (updated != null) onChanged(hours.replace(w, updated, isBreak: false));
                  },
                  onDelete: () => onChanged(hours.remove(w, isBreak: false)),
                ),
            for (final b in breaks)
              _WindowRow(
                icon: Icons.free_breakfast_outlined,
                label: 'Break ${windowLabel(b)}',
                enabled: enabled,
                onTap: () async {
                  final updated = await _pick(context, initial: b, label: 'Break');
                  if (updated != null) onChanged(hours.replace(b, updated, isBreak: true));
                },
                onDelete: () => onChanged(hours.remove(b, isBreak: true)),
              ),
            Wrap(
              spacing: Gap.sm,
              children: [
                if (showWorking && open)
                  TextButton.icon(
                    onPressed: !enabled
                        ? null
                        : () async {
                            final w = await _pick(context, label: 'Open');
                            if (w != null) onChanged(hours.add(w, isBreak: false));
                          },
                    icon: const Icon(Icons.add_rounded, size: 18),
                    label: const Text('Add hours'),
                  ),
                if (open || !showWorking)
                  TextButton.icon(
                    onPressed: !enabled
                        ? null
                        : () async {
                            final w = await _pick(context, label: 'Break');
                            if (w != null) onChanged(hours.add(w, isBreak: true));
                          },
                    icon: const Icon(Icons.add_rounded, size: 18),
                    label: const Text('Add break'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _WindowRow extends StatelessWidget {
  const _WindowRow({required this.icon, required this.label, required this.enabled, required this.onTap, required this.onDelete});

  final IconData icon;
  final String label;
  final bool enabled;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) => InkWell(
    borderRadius: BorderRadius.circular(Corners.sm),
    onTap: enabled ? onTap : null,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: Gap.xs),
      child: Row(
        children: [
          Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: Gap.sm),
          Expanded(
            child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          IconButton(
            tooltip: 'Remove',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.close_rounded, size: 20),
            onPressed: enabled ? onDelete : null,
          ),
        ],
      ),
    ),
  );
}
