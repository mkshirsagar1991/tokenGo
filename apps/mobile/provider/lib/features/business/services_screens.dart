import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

class ServicesScreen extends ConsumerWidget {
  const ServicesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final services = ref.watch(servicesProvider);
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Services & prices')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/manage/services/new'),
        icon: const Icon(Icons.add_rounded),
        label: const Text('Add service'),
      ),
      body: AsyncView(
        value: services,
        onRetry: () => ref.invalidate(servicesProvider),
        builder: (list) {
          if (list.isEmpty) {
            return EmptyState(
              icon: Icons.content_cut_rounded,
              art: BrandArt.emptyServicesAdded,
              title: 'No services yet',
              message: 'Add what you offer, with a price and how long it takes.',
              action: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(200, 52)),
                onPressed: () => context.push('/manage/services/new'),
                child: const Text('Add a service'),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () => ref.refresh(servicesProvider.future),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.lg, 100),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
              itemBuilder: (_, i) {
                final s = list[i];
                return Card(
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => context.push('/manage/services/${s.id}'),
                    child: Padding(
                      padding: const EdgeInsets.all(Gap.lg),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(s.name, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                                Text(
                                  '${formatDuration(s.durationMin)}${s.bufferMin > 0 ? ' + ${s.bufferMin} min between customers' : ''}',
                                  style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                                ),
                              ],
                            ),
                          ),
                          if (!s.isActive) ...[const StatusPill('Hidden', tone: Tone.warning), const SizedBox(width: Gap.sm)],
                          Text(s.price.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
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

/// Add (no [serviceId]) or edit a service. The price is typed in rupees and goes out as integer paise.
class ServiceFormScreen extends ConsumerWidget {
  const ServiceFormScreen({super.key, this.serviceId});

  final String? serviceId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final catalog = ref.watch(serviceCatalogProvider);
    final services = ref.watch(servicesProvider);
    return Scaffold(
      appBar: AppBar(title: Text(serviceId == null ? 'Add service' : 'Edit service')),
      body: AsyncView(
        value: catalog,
        onRetry: () => ref.invalidate(serviceCatalogProvider),
        builder: (groups) => AsyncView(
          value: services,
          onRetry: () => ref.invalidate(servicesProvider),
          builder: (list) {
            final types = [for (final g in groups) ...g.types];
            if (serviceId == null) return _ServiceForm(types: types, groups: groups);
            final found = list.where((s) => s.id == serviceId);
            if (found.isEmpty) return const EmptyState(icon: Icons.content_cut_rounded, title: 'This service no longer exists');
            return _ServiceForm(types: types, groups: groups, original: found.first);
          },
        ),
      ),
    );
  }
}

class _ServiceForm extends ConsumerStatefulWidget {
  const _ServiceForm({required this.types, required this.groups, this.original});

  /// What the server offers, grouped by category (Salon, Vehicle service, ...). [types] is the same list, flat.
  final List<({ServiceCategory category, List<ServiceType> types})> groups;

  final List<ServiceType> types;
  final OwnedService? original;

  @override
  ConsumerState<_ServiceForm> createState() => _ServiceFormState();
}

class _ServiceFormState extends ConsumerState<_ServiceForm> {
  late final _name = TextEditingController(text: widget.original?.name);
  late final _description = TextEditingController(text: widget.original?.description);
  late final _price = TextEditingController(text: widget.original == null ? '' : MoneyInput.toRupeesText(widget.original!.price.minor));
  late final _duration = TextEditingController(text: widget.original?.durationMin.toString());
  late final _buffer = TextEditingController(text: (widget.original?.bufferMin ?? 0).toString());
  late String? _typeId = widget.original?.serviceTypeId;
  late bool _active = widget.original?.isActive ?? true;
  String? _autoName;
  final _errors = ServerErrors();
  final _attempt = AttemptKey();
  bool _busy = false;

  static const _fields = {'service_type_id', 'name', 'description', 'price_minor', 'duration_min', 'buffer_min'};

  bool get _editing => widget.original != null;

  @override
  void dispose() {
    for (final c in [_name, _description, _price, _duration, _buffer]) {
      c.dispose();
    }
    super.dispose();
  }

  ServiceDraft _draft() => ServiceDraft(
    serviceTypeId: _typeId,
    name: _name.text,
    description: _description.text,
    priceRupees: _price.text,
    durationMin: int.tryParse(_duration.text.trim()),
    bufferMin: int.tryParse(_buffer.text.trim()) ?? 0,
    isActive: _active,
  );

  void _pickType(ServiceType type) {
    setState(() {
      _typeId = type.id;
      _errors.clearField('service_type_id');
      // Suggest the catalogue name, but never overwrite a name the owner typed.
      if (_name.text.trim().isEmpty || _name.text == _autoName) {
        _name.text = type.name;
        _autoName = type.name;
      }
    });
  }

  Future<void> _save() async {
    if (_busy) return;
    final draft = _draft();
    final problems = draft.validate(creating: !_editing);
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
    final repo = ref.read(setupRepositoryProvider);
    try {
      if (_editing) {
        final changes = draft.changesFrom(widget.original!);
        if (changes.isEmpty) {
          showSnack(context, 'Nothing to save.');
        } else {
          await repo.updateService(business.id, widget.original!.id, changes);
          if (mounted) showSnack(context, 'Service saved.');
        }
      } else {
        await repo.createService(business.id, draft, idempotencyKey: _attempt.keyFor(draft.toCreateJson()));
        _attempt.reset();
        refreshSetup(ref);
        if (!mounted) return;
        showSnack(context, 'Service added.');
        context.pop();
        return;
      }
    } catch (e) {
      if (mounted) setState(() => _errors.set(e));
    } finally {
      refreshSetup(ref);
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final ok = await confirmAction(
      context,
      title: 'Remove this service?',
      message: 'Customers will no longer see ${widget.original!.name}. Existing bookings are not affected.',
      confirmLabel: 'Remove',
      destructive: true,
    );
    if (!ok || !mounted || _busy) return;
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(setupRepositoryProvider).deleteService(business.id, widget.original!.id);
      refreshSetup(ref);
      if (!mounted) return;
      showSnack(context, 'Service removed.');
      context.pop();
    } catch (e) {
      refreshSetup(ref);
      if (mounted) {
        setState(() => _busy = false);
        showSnack(context, errorMessage(e), error: true);
      }
    }
  }

  Widget _number(TextEditingController c, String field, String label, {String? helper, String? suffix, String? prefix}) => TextField(
    controller: c,
    keyboardType: TextInputType.number,
    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
    onChanged: (_) => setState(() => _errors.clearField(field)),
    decoration: InputDecoration(
      labelText: label,
      helperText: helper,
      helperMaxLines: 3,
      suffixText: suffix,
      prefixText: prefix,
      errorText: _errors.field(field),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final minor = MoneyInput.parseRupees(_price.text);
    final typeName = widget.types.where((x) => x.id == _typeId).map((x) => x.name).firstOrNull;
    return ListView(
      padding: const EdgeInsets.all(Gap.lg),
      children: [
        FormBanner(_errors.banner(_fields)),
        if (_editing)
          Padding(
            padding: const EdgeInsets.only(bottom: Gap.md),
            child: Text('Type: ${typeName ?? 'Service'}', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          )
        else ...[
          Text('What kind of service is it?', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: Gap.sm),
          if (widget.types.isEmpty)
            Text(
              'No kinds of service are set up yet. Ask TokenGo support to add the kinds your business offers.',
              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
          // Every enabled category the server offers, each with its own kinds, so a garage sees "Car wash" next to "Tyre change" and
          // not a salon's "Haircut" mixed in. With a single category there is nothing to separate and no heading.
          for (final group in widget.groups.where((g) => g.types.isNotEmpty)) ...[
            if (widget.groups.where((g) => g.types.isNotEmpty).length > 1)
              Padding(
                padding: const EdgeInsets.only(top: Gap.sm, bottom: Gap.xs),
                child: Text(
                  group.category.name,
                  style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.primary, fontWeight: FontWeight.w700),
                ),
              ),
            Wrap(
              spacing: Gap.sm,
              runSpacing: Gap.sm,
              children: [
                for (final type in group.types)
                  ChoiceChip(label: Text(type.name), selected: _typeId == type.id, onSelected: (_) => _pickType(type)),
              ],
            ),
          ],
          if (_errors.field('service_type_id') != null)
            Padding(
              padding: const EdgeInsets.only(top: Gap.xs),
              child: Text(_errors.field('service_type_id')!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
            ),
          const SizedBox(height: Gap.lg),
        ],
        TextField(
          controller: _name,
          textCapitalization: TextCapitalization.words,
          maxLength: 120,
          onChanged: (_) => setState(() => _errors.clearField('name')),
          decoration: InputDecoration(labelText: 'Service name', errorText: _errors.field('name'), counterText: ''),
        ),
        const SizedBox(height: Gap.md),
        TextField(
          controller: _description,
          maxLines: 3,
          maxLength: 1000,
          onChanged: (_) => setState(() => _errors.clearField('description')),
          decoration: InputDecoration(
            labelText: 'Description (optional)',
            alignLabelWithHint: true,
            errorText: _errors.field('description'),
          ),
        ),
        const SizedBox(height: Gap.md),
        TextField(
          controller: _price,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,₹]')), LengthLimitingTextInputFormatter(14)],
          onChanged: (_) => setState(() => _errors.clearField('price_minor')),
          decoration: InputDecoration(
            labelText: 'Price',
            prefixText: '₹ ',
            helperText: minor == null ? 'In rupees, for example 250 or 249.50' : 'Customers pay ${Money(minor).format()}',
            errorText: _errors.field('price_minor'),
          ),
        ),
        const SizedBox(height: Gap.md),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: _number(_duration, 'duration_min', 'Duration', suffix: 'min')),
            const SizedBox(width: Gap.md),
            Expanded(
              child: _number(_buffer, 'buffer_min', 'Buffer after', suffix: 'min', helper: 'Time to reset between customers'),
            ),
          ],
        ),
        const SizedBox(height: Gap.sm),
        Wrap(
          spacing: Gap.sm,
          children: [
            for (final m in const [15, 30, 45, 60, 90, 120])
              ActionChip(
                label: Text(formatDuration(m)),
                onPressed: () => setState(() {
                  _duration.text = '$m';
                  _errors.clearField('duration_min');
                }),
              ),
          ],
        ),
        if (_editing)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Offered to customers'),
            subtitle: const Text('Turn off to hide it without deleting. Existing bookings are not affected.'),
            value: _active,
            onChanged: _busy ? null : (v) => setState(() => _active = v),
          ),
        const SizedBox(height: Gap.xl),
        BusyButton(label: _editing ? 'Save changes' : 'Add service', busy: _busy, onPressed: _save),
        if (_editing) ...[
          const SizedBox(height: Gap.lg),
          TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: t.colorScheme.error),
            onPressed: _busy ? null : _delete,
            icon: const Icon(Icons.delete_outline_rounded),
            label: const Text('Remove this service'),
          ),
        ],
      ],
    );
  }
}
