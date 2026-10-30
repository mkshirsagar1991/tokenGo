import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../config/app_config.dart';
import '../../core/providers.dart';
import 'business_state.dart';
import 'form_support.dart';

class LocationsScreen extends ConsumerWidget {
  const LocationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locations = ref.watch(locationsProvider);
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Locations')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/manage/locations/new'),
        icon: const Icon(Icons.add_location_alt_outlined),
        label: const Text('Add location'),
      ),
      body: AsyncView(
        value: locations,
        onRetry: () => ref.invalidate(locationsProvider),
        builder: (list) {
          if (list.isEmpty) {
            return EmptyState(
              icon: Icons.place_outlined,
              title: 'No locations yet',
              message: 'Add the address customers come to. You need at least one to submit your business.',
              action: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(200, 52)),
                onPressed: () => context.push('/manage/locations/new'),
                child: const Text('Add a location'),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () => ref.refresh(locationsProvider.future),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.md, Gap.lg, 100),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
              itemBuilder: (_, i) {
                final l = list[i];
                return Card(
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => context.push('/manage/locations/${l.id}'),
                    child: Padding(
                      padding: const EdgeInsets.all(Gap.lg),
                      child: Row(
                        children: [
                          Icon(Icons.place_rounded, color: t.colorScheme.primary),
                          const SizedBox(width: Gap.md),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(l.name, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                                Text(
                                  '${l.oneLine}, ${l.state} ${l.postalCode}',
                                  style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
                                ),
                              ],
                            ),
                          ),
                          if (!l.isActive) const StatusPill('Not taking bookings', tone: Tone.warning),
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

/// Add (no [locationId]) or edit a location.
class LocationFormScreen extends ConsumerWidget {
  const LocationFormScreen({super.key, this.locationId});

  final String? locationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (locationId == null) return const _LocationForm();
    final locations = ref.watch(locationsProvider);
    return AsyncView(
      value: locations,
      onRetry: () => ref.invalidate(locationsProvider),
      builder: (list) {
        final found = list.where((l) => l.id == locationId);
        if (found.isEmpty) {
          return Scaffold(
            appBar: AppBar(title: const Text('Location')),
            body: const EmptyState(icon: Icons.place_outlined, title: 'This location no longer exists'),
          );
        }
        return _LocationForm(original: found.first);
      },
    );
  }
}

class _LocationForm extends ConsumerStatefulWidget {
  const _LocationForm({this.original});

  final OwnedLocation? original;

  @override
  ConsumerState<_LocationForm> createState() => _LocationFormState();
}

class _LocationFormState extends ConsumerState<_LocationForm> {
  late final _name = TextEditingController(text: widget.original?.name);
  late final _line1 = TextEditingController(text: widget.original?.addressLine1);
  late final _line2 = TextEditingController(text: widget.original?.addressLine2);
  late final _city = TextEditingController(text: widget.original?.city);
  late final _state = TextEditingController(text: widget.original?.state);
  late final _postal = TextEditingController(text: widget.original?.postalCode);
  late final _lat = TextEditingController(text: widget.original?.latitude.toString());
  late final _lng = TextEditingController(text: widget.original?.longitude.toString());
  late final _zone = TextEditingController(text: widget.original?.timezone ?? LocationDraft.defaultTimezone);
  late bool _active = widget.original?.isActive ?? true;
  final _errors = ServerErrors();
  final _attempt = AttemptKey();
  final _map = MapController();
  bool _mapReady = false;
  bool _busy = false;
  bool _locating = false;

  static const _fields = {'name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'latitude', 'longitude', 'timezone'};

  bool get _editing => widget.original != null;

  @override
  void dispose() {
    for (final c in [_name, _line1, _line2, _city, _state, _postal, _lat, _lng, _zone]) {
      c.dispose();
    }
    _map.dispose();
    super.dispose();
  }

  LocationDraft _draft() => LocationDraft(
    name: _name.text,
    addressLine1: _line1.text,
    addressLine2: _line2.text,
    city: _city.text,
    state: _state.text,
    postalCode: _postal.text,
    latitude: LocationDraft.parseCoordinate(_lat.text),
    longitude: LocationDraft.parseCoordinate(_lng.text),
    timezone: _zone.text,
  );

  void _setPoint(double lat, double lng) {
    _lat.text = LocationDraft.roundCoordinate(lat).toString();
    _lng.text = LocationDraft.roundCoordinate(lng).toString();
    _errors
      ..clearField('latitude')
      ..clearField('longitude');
    if (_mapReady) _map.move(LatLng(lat, lng), 16);
    setState(() {});
  }

  Future<void> _useMyLocation() async {
    if (_locating) return;
    setState(() => _locating = true);
    try {
      final fix = await ref.read(deviceLocatorProvider)();
      if (!mounted) return;
      switch (fix) {
        case DeviceFound(:final latitude, :final longitude):
          _setPoint(latitude, longitude);
          showSnack(context, 'Pin set to this phone\'s current position. Check it on the map.');
        case DeviceUnavailable(:final message, :final canOpenSettings):
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              SnackBar(
                content: Text(message),
                action: canOpenSettings ? SnackBarAction(label: 'Settings', onPressed: Geolocator.openAppSettings) : null,
              ),
            );
      }
    } finally {
      if (mounted) setState(() => _locating = false);
    }
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
    final repo = ref.read(setupRepositoryProvider);
    try {
      if (_editing) {
        final changes = draft.changesFrom(widget.original!);
        if (_active != widget.original!.isActive) changes['status'] = _active ? 'ACTIVE' : 'INACTIVE';
        if (changes.isEmpty) {
          showSnack(context, 'Nothing to save.');
        } else {
          await repo.updateLocation(business.id, widget.original!.id, changes);
          if (mounted) showSnack(context, 'Location saved.');
        }
      } else {
        final body = draft.toCreateJson();
        await repo.createLocation(business.id, draft, idempotencyKey: _attempt.keyFor(body));
        _attempt.reset();
        if (mounted) showSnack(context, 'Location added.');
        refreshSetup(ref);
        if (mounted) context.pop();
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
      title: 'Remove this location?',
      message: 'Customers will no longer be able to book at ${widget.original!.name}.',
      confirmLabel: 'Remove',
      destructive: true,
    );
    if (!ok || !mounted || _busy) return;
    final business = await ref.read(currentBusinessProvider.future);
    if (business == null || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(setupRepositoryProvider).deleteLocation(business.id, widget.original!.id);
      refreshSetup(ref);
      if (!mounted) return;
      showSnack(context, 'Location removed.');
      context.pop();
    } catch (e) {
      refreshSetup(ref);
      if (mounted) {
        setState(() => _busy = false);
        showSnack(context, errorMessage(e), error: true);
      }
    }
  }

  Widget _input(
    TextEditingController c,
    String field,
    String label, {
    TextInputType? keyboard,
    TextCapitalization caps = TextCapitalization.words,
    String? helper,
    List<TextInputFormatter>? formatters,
    int? maxLength,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: Gap.md),
    child: TextField(
      controller: c,
      keyboardType: keyboard,
      textCapitalization: caps,
      inputFormatters: formatters,
      maxLength: maxLength,
      onChanged: (_) => setState(() => _errors.clearField(field)),
      decoration: InputDecoration(
        labelText: label,
        helperText: helper,
        helperMaxLines: 3,
        errorText: _errors.field(field),
        counterText: '',
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final lat = LocationDraft.parseCoordinate(_lat.text);
    final lng = LocationDraft.parseCoordinate(_lng.text);
    final hasPoint = lat != null && lng != null && lat.abs() <= 90 && lng.abs() <= 180;
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? 'Edit location' : 'Add location')),
      body: ListView(
        padding: const EdgeInsets.all(Gap.lg),
        children: [
          FormBanner(_errors.banner(_fields)),
          _input(_name, 'name', 'Location name', helper: 'For example "Koregaon Park" or "Main salon"', maxLength: 120),
          _input(_line1, 'address_line1', 'Street address', maxLength: 200),
          _input(_line2, 'address_line2', 'Landmark or area (optional)', maxLength: 200),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _input(_city, 'city', 'City', maxLength: 100)),
              const SizedBox(width: Gap.md),
              Expanded(child: _input(_postal, 'postal_code', 'PIN code', caps: TextCapitalization.characters, maxLength: 10)),
            ],
          ),
          _input(_state, 'state', 'State', maxLength: 100),
          const SizedBox(height: Gap.sm),
          Text('Map pin', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: Gap.xs),
          Text(
            'Customers find you and get directions from this pin. Use this phone\'s position while you are at the salon, or type '
            'the coordinates.',
            style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: Gap.md),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            onPressed: _locating ? null : _useMyLocation,
            icon: _locating
                ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Icon(Icons.my_location_rounded),
            label: const Text('Use my current location'),
          ),
          const SizedBox(height: Gap.md),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: _input(
                  _lat,
                  'latitude',
                  'Latitude',
                  keyboard: const TextInputType.numberWithOptions(decimal: true, signed: true),
                  formatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,\-]'))],
                ),
              ),
              const SizedBox(width: Gap.md),
              Expanded(
                child: _input(
                  _lng,
                  'longitude',
                  'Longitude',
                  keyboard: const TextInputType.numberWithOptions(decimal: true, signed: true),
                  formatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,\-]'))],
                ),
              ),
            ],
          ),
          if (hasPoint && ref.watch(mapPreviewEnabledProvider))
            ClipRRect(
              borderRadius: BorderRadius.circular(Corners.md),
              child: SizedBox(
                height: 190,
                child: FlutterMap(
                  mapController: _map,
                  options: MapOptions(
                    initialCenter: LatLng(lat, lng),
                    initialZoom: 16,
                    // A map inside a scrolling form must not capture the scroll: it only shows the pin; tapping moves it.
                    interactionOptions: const InteractionOptions(flags: InteractiveFlag.none),
                    onMapReady: () => _mapReady = true,
                    onTap: (_, p) => _setPoint(p.latitude, p.longitude),
                  ),
                  children: [
                    TileLayer(urlTemplate: AppConfig.mapTileUrl, userAgentPackageName: AppConfig.mapUserAgentPackage),
                    MarkerLayer(
                      markers: [
                        Marker(
                          point: LatLng(lat, lng),
                          width: 40,
                          height: 40,
                          alignment: Alignment.topCenter,
                          child: Icon(Icons.location_on_rounded, size: 40, color: t.colorScheme.error),
                        ),
                      ],
                    ),
                    const SimpleAttributionWidget(source: Text('© OpenStreetMap contributors')),
                  ],
                ),
              ),
            ),
          if (hasPoint && ref.watch(mapPreviewEnabledProvider))
            Padding(
              padding: const EdgeInsets.only(top: Gap.xs),
              child: Text('Tap the map to move the pin.', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
            ),
          const SizedBox(height: Gap.lg),
          _input(
            _zone,
            'timezone',
            'Time zone',
            caps: TextCapitalization.none,
            helper: 'Opening hours and bookings use this zone\'s clock, whatever time zone this phone is in.',
            maxLength: 64,
          ),
          if (_editing)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Taking bookings here'),
              subtitle: const Text('Turn off to hide this location from customers without removing it.'),
              value: _active,
              onChanged: _busy ? null : (v) => setState(() => _active = v),
            ),
          const SizedBox(height: Gap.lg),
          BusyButton(label: _editing ? 'Save changes' : 'Add location', busy: _busy, onPressed: _save),
          if (_editing) ...[
            const SizedBox(height: Gap.xl),
            Card(
              child: Column(
                children: [
                  MenuTile(
                    icon: Icons.schedule_rounded,
                    title: 'Opening hours',
                    subtitle: 'Days, times and breaks',
                    onTap: () => context.push('/manage/locations/${widget.original!.id}/hours'),
                  ),
                  const Divider(height: 1),
                  MenuTile(
                    icon: Icons.event_busy_outlined,
                    title: 'Holidays & special openings',
                    onTap: () => context.push('/manage/locations/${widget.original!.id}/time-off'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: Gap.lg),
            TextButton.icon(
              style: TextButton.styleFrom(foregroundColor: t.colorScheme.error),
              onPressed: _busy ? null : _delete,
              icon: const Icon(Icons.delete_outline_rounded),
              label: const Text('Remove this location'),
            ),
          ],
        ],
      ),
    );
  }
}
