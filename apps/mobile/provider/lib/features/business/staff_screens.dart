import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

class StaffScreen extends ConsumerWidget {
  const StaffScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final staff = ref.watch(staffProvider);
    final locations = ref.watch(locationsProvider).value ?? const <OwnedLocation>[];
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Staff')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/manage/staff/new'),
        icon: const Icon(Icons.person_add_alt_1_rounded),
        label: const Text('Add staff'),
      ),
      body: AsyncView(
        value: staff,
        onRetry: () => ref.invalidate(staffProvider),
        builder: (list) {
          if (list.isEmpty) {
            return EmptyState(
              icon: Icons.groups_outlined,
              art: BrandArt.emptyStaff,
              title: 'No staff yet',
              message: 'Customers book a time with a person. Add yourself, or invite your stylists by mobile number.',
              action: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(200, 52)),
                onPressed: () => context.push('/manage/staff/new'),
                child: const Text('Add a staff member'),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () => ref.refresh(staffProvider.future),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.lg, 100),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
              itemBuilder: (_, i) {
                final s = list[i];
                final loc = locations.where((l) => l.id == s.locationId).firstOrNull;
                return Card(
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => context.push('/manage/staff/${s.id}'),
                    child: Padding(
                      padding: const EdgeInsets.all(Gap.lg),
                      child: Row(
                        children: [
                          CircleAvatar(
                            backgroundColor: t.colorScheme.primaryContainer,
                            child: Text(
                              s.displayName.isEmpty ? '?' : s.displayName.characters.first.toUpperCase(),
                              style: TextStyle(color: t.colorScheme.onPrimaryContainer, fontWeight: FontWeight.w800),
                            ),
                          ),
                          const SizedBox(width: Gap.md),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(s.displayName, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                                Text(
                                  '${s.roleLabel}${loc == null ? '' : ' · ${loc.name}'}',
                                  style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                                ),
                              ],
                            ),
                          ),
                          if (s.isInvited) const StatusPill('Invitation sent', tone: Tone.info),
                          const Icon(Icons.chevron_right_rounded),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/// Add a staff member. With a mobile number they are INVITED (and must accept in their own app — nobody is attached without
/// consent); without one they are a stylist the owner schedules.
class StaffFormScreen extends ConsumerStatefulWidget {
  const StaffFormScreen({super.key});

  @override
  ConsumerState<StaffFormScreen> createState() => _StaffFormScreenState();
}

class _StaffFormScreenState extends ConsumerState<StaffFormScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  String? _locationId;
  String _role = StaffRole.staff;
  final _errors = ServerErrors();
  final _attempt = AttemptKey();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save(List<OwnedLocation> locations) async {
    if (_busy) return;
    final draft = StaffDraft(
      locationId: _locationId ?? (locations.length == 1 ? locations.single.id : null),
      displayName: _name.text,
      role: _role,
      phone: _phone.text,
    );
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
      final created = await ref
          .read(setupRepositoryProvider)
          .createStaff(business.id, draft, idempotencyKey: _attempt.keyFor(draft.toCreateJson()));
      _attempt.reset();
      refreshSetup(ref);
      if (!mounted) return;
      showSnack(
        context,
        created.isInvited
            ? 'Invitation sent to ${draft.phone.trim()}. They appear as active once they accept.'
            : '${created.displayName} added.',
      );
      context.pop();
    } catch (e) {
      refreshSetup(ref);
      if (mounted) setState(() => _errors.set(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final locations = ref.watch(locationsProvider);
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Add staff')),
      body: AsyncView(
        value: locations,
        onRetry: () => ref.invalidate(locationsProvider),
        builder: (all) {
          final list = all.where((l) => l.isActive).toList();
          if (list.isEmpty) {
            return EmptyState(
              icon: Icons.place_outlined,
              title: 'Add a location first',
              message: 'Staff work at a location.',
              action: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(200, 52)),
                onPressed: () => context.push('/manage/locations/new'),
                child: const Text('Add a location'),
              ),
            );
          }
          final selected = _locationId ?? (list.length == 1 ? list.single.id : null);
          return ListView(
            padding: const EdgeInsets.all(Gap.lg),
            children: [
              FormBanner(_errors.banner(const {'location_id', 'display_name', 'phone', 'staff_role'})),
              if (list.length > 1) ...[
                DropdownButtonFormField<String>(
                  initialValue: selected,
                  decoration: InputDecoration(labelText: 'Works at', errorText: _errors.field('location_id')),
                  items: [for (final l in list) DropdownMenuItem(value: l.id, child: Text(l.name))],
                  onChanged: (v) => setState(() {
                    _locationId = v;
                    _errors.clearField('location_id');
                  }),
                ),
                const SizedBox(height: Gap.md),
              ],
              TextField(
                controller: _name,
                textCapitalization: TextCapitalization.words,
                maxLength: 100,
                onChanged: (_) => setState(() => _errors.clearField('display_name')),
                decoration: InputDecoration(
                  labelText: 'Name',
                  helperText: 'As customers will see it when they pick a stylist',
                  errorText: _errors.field('display_name'),
                  counterText: '',
                ),
              ),
              const SizedBox(height: Gap.md),
              SegmentedButton<String>(
                segments: [for (final r in StaffRole.all) ButtonSegment(value: r, label: Text(StaffRole.label(r)))],
                selected: {_role},
                onSelectionChanged: (s) => setState(() => _role = s.first),
              ),
              const SizedBox(height: Gap.xs),
              Text(
                _role == StaffRole.manager
                    ? 'Managers can run bookings and manage hours at this location.'
                    : 'Stylists take bookings and run their own appointments.',
                style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: Gap.lg),
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
                onChanged: (_) => setState(() => _errors.clearField('phone')),
                decoration: InputDecoration(
                  labelText: 'Mobile number (optional)',
                  prefixText: '+91 ',
                  helperText: 'Enter it to invite them to sign in. Leave it empty to add a stylist without a login (for example yourself).',
                  helperMaxLines: 3,
                  errorText: _errors.field('phone'),
                ),
              ),
              const SizedBox(height: Gap.xl),
              BusyButton(
                label: _phone.text.trim().isEmpty ? 'Add staff member' : 'Send invitation',
                busy: _busy,
                onPressed: () => _save(list),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// One staff member: name and role, which services they perform, their hours, leave and blocks.
class StaffDetailScreen extends ConsumerWidget {
  const StaffDetailScreen({super.key, required this.staffId});

  final String staffId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final staff = ref.watch(staffProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Staff member')),
      body: AsyncView(
        value: staff,
        onRetry: () => ref.invalidate(staffProvider),
        builder: (list) {
          final found = list.where((s) => s.id == staffId);
          if (found.isEmpty) return const EmptyState(icon: Icons.person_off_outlined, title: 'This person is no longer on your staff');
          return _StaffDetail(staff: found.first);
        },
      ),
    );
  }
}

class _StaffDetail extends ConsumerStatefulWidget {
  const _StaffDetail({required this.staff});

  final OwnedStaff staff;

  @override
  ConsumerState<_StaffDetail> createState() => _StaffDetailState();
}

class _StaffDetailState extends ConsumerState<_StaffDetail> {
  late final _name = TextEditingController(text: widget.staff.displayName);
  late String _role = widget.staff.staffRole;
  final _errors = ServerErrors();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    final n = _name.text.trim().length;
    if (n < 1 || n > 100) {
      setState(() => _errors.setLocal({'display_name': 'Enter a name (up to 100 characters)'}));
      return;
    }
    final nameChanged = _name.text.trim() != widget.staff.displayName;
    final roleChanged = _role != widget.staff.staffRole;
    if (!nameChanged && !roleChanged) {
      showSnack(context, 'Nothing to save.');
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
    });
    try {
      await ref
          .read(setupRepositoryProvider)
          .updateStaff(
            widget.staff.providerId,
            widget.staff.id,
            displayName: nameChanged ? _name.text : null,
            role: roleChanged ? _role : null,
          );
      if (mounted) showSnack(context, 'Saved.');
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      refreshSetup(ref);
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove() async {
    final ok = await confirmAction(
      context,
      title: 'Remove ${widget.staff.displayName}?',
      message:
          'They can no longer be booked${widget.staff.hasLogin ? ' and lose access to this business' : ''}. Existing bookings are not cancelled.',
      confirmLabel: 'Remove',
      destructive: true,
    );
    if (!ok || !mounted || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(setupRepositoryProvider).deleteStaff(widget.staff.providerId, widget.staff.id);
      refreshSetup(ref);
      if (!mounted) return;
      showSnack(context, 'Removed.');
      context.pop();
    } catch (e) {
      refreshSetup(ref);
      if (mounted) {
        setState(() => _busy = false);
        showSnack(context, errorMessage(e), error: true);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.staff;
    final t = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(Gap.lg),
      children: [
        if (s.isInvited)
          Padding(
            padding: const EdgeInsets.only(bottom: Gap.md),
            child: Row(
              children: [
                const StatusPill('Invitation sent', tone: Tone.info),
                const SizedBox(width: Gap.sm),
                Expanded(
                  child: Text(
                    'Becomes active once they accept.',
                    style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                  ),
                ),
              ],
            ),
          ),
        FormBanner(_errors.banner(const {'display_name', 'staff_role'})),
        TextField(
          controller: _name,
          textCapitalization: TextCapitalization.words,
          maxLength: 100,
          onChanged: (_) => setState(() => _errors.clearField('display_name')),
          decoration: InputDecoration(labelText: 'Name', errorText: _errors.field('display_name'), counterText: ''),
        ),
        const SizedBox(height: Gap.md),
        SegmentedButton<String>(
          segments: [for (final r in StaffRole.all) ButtonSegment(value: r, label: Text(StaffRole.label(r)))],
          selected: {_role},
          onSelectionChanged: _busy ? null : (v) => setState(() => _role = v.first),
        ),
        const SizedBox(height: Gap.lg),
        BusyButton(label: 'Save changes', busy: _busy, onPressed: _save),
        const SizedBox(height: Gap.xl),
        _SkillsCard(staff: s),
        const SizedBox(height: Gap.lg),
        Card(
          child: Column(
            children: [
              MenuTile(
                icon: Icons.schedule_rounded,
                title: 'Working hours',
                subtitle: 'Their own days and times, or the salon\'s',
                onTap: () => context.push('/manage/staff/${s.id}/schedule'),
              ),
              const Divider(height: 1),
              MenuTile(
                icon: Icons.event_busy_outlined,
                title: 'Leave & special hours',
                onTap: () => context.push('/manage/staff/${s.id}/time-off'),
              ),
              const Divider(height: 1),
              MenuTile(
                icon: Icons.block_rounded,
                title: 'Walk-ins & blocks',
                subtitle: 'Hold time so it cannot be booked online',
                onTap: () => context.push('/manage/staff/${s.id}/blocks'),
              ),
            ],
          ),
        ),
        const SizedBox(height: Gap.lg),
        TextButton.icon(
          style: TextButton.styleFrom(foregroundColor: t.colorScheme.error),
          onPressed: _busy ? null : _remove,
          icon: const Icon(Icons.person_remove_outlined),
          label: const Text('Remove from staff'),
        ),
      ],
    );
  }
}

/// Which services this person performs. Nothing ticked = they can do every service the business offers.
class _SkillsCard extends ConsumerStatefulWidget {
  const _SkillsCard({required this.staff});

  final OwnedStaff staff;

  @override
  ConsumerState<_SkillsCard> createState() => _SkillsCardState();
}

class _SkillsCardState extends ConsumerState<_SkillsCard> {
  Set<String>? _draft;
  bool _busy = false;
  String? _error;

  Future<void> _save(Set<String> selected) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(setupRepositoryProvider).setStaffSkills(widget.staff.providerId, widget.staff.id, selected.toList());
      if (mounted) {
        setState(() => _draft = null);
        showSnack(context, 'Services saved.');
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorMessage(e));
    } finally {
      ref.invalidate(staffSkillsProvider(widget.staff.id));
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final skills = ref.watch(staffSkillsProvider(widget.staff.id));
    final services = ref.watch(servicesProvider);
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Gap.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Services they perform', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: Gap.sm),
            AsyncViewInline(
              value: skills,
              onRetry: () => ref.invalidate(staffSkillsProvider(widget.staff.id)),
              builder: (s) => AsyncViewInline(
                value: services,
                onRetry: () => ref.invalidate(servicesProvider),
                builder: (all) {
                  final active = all.where((x) => x.isActive).toList();
                  if (active.isEmpty) {
                    return Text('Add a service first.', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant));
                  }
                  final saved = (s?.serviceIds ?? const <String>[]).toSet();
                  final current = _draft ?? saved;
                  final dirty = !(current.length == saved.length && current.containsAll(saved));
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        current.isEmpty ? 'Everything you offer (no restriction).' : 'Only the services ticked below.',
                        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                      ),
                      for (final svc in active)
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          dense: true,
                          title: Text(svc.name),
                          subtitle: Text('${svc.price.format()} · ${formatDuration(svc.durationMin)}'),
                          value: current.contains(svc.id),
                          onChanged: _busy
                              ? null
                              : (v) => setState(() {
                                  final next = {...current};
                                  if (v == true) {
                                    next.add(svc.id);
                                  } else {
                                    next.remove(svc.id);
                                  }
                                  _draft = next;
                                }),
                        ),
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: Gap.sm),
                          child: Text(_error!, style: TextStyle(color: t.colorScheme.error)),
                        ),
                      if (dirty || current.isNotEmpty)
                        Wrap(
                          alignment: WrapAlignment.spaceBetween,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            if (current.isNotEmpty)
                              TextButton(
                                onPressed: _busy ? null : () => setState(() => _draft = <String>{}),
                                child: const Text('Clear (all services)'),
                              ),
                            FilledButton(
                              style: FilledButton.styleFrom(minimumSize: const Size(120, 44)),
                              onPressed: (!dirty || _busy) ? null : () => _save(current),
                              child: _busy
                                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2.5))
                                  : const Text('Save'),
                            ),
                          ],
                        ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Like [AsyncView] but sized to its content (for use inside a card).
class AsyncViewInline<T> extends StatelessWidget {
  const AsyncViewInline({super.key, required this.value, required this.onRetry, required this.builder});

  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) builder;

  @override
  Widget build(BuildContext context) => value.when(
    skipLoadingOnReload: true,
    loading: () => const Padding(
      padding: EdgeInsets.all(Gap.md),
      child: Center(child: CircularProgressIndicator()),
    ),
    error: (e, _) => Row(
      children: [
        Expanded(child: Text(errorMessage(e))),
        TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
    data: builder,
  );
}
