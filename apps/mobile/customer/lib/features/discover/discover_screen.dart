import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'place.dart';
import 'provider_card_tile.dart';
import 'providers_map.dart';
import 'search_state.dart';

/// Home: find a salon near you. List or map, filtered and sorted — no account needed.
class DiscoverScreen extends ConsumerStatefulWidget {
  const DiscoverScreen({super.key});

  @override
  ConsumerState<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends ConsumerState<DiscoverScreen> {
  bool _mapView = false;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.hasClients && _scroll.position.pixels > _scroll.position.maxScrollExtent - 300) {
        ref.read(searchResultsProvider.notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _open(ProviderCard c) => context.push('/provider/${c.locationId}');

  @override
  Widget build(BuildContext context) {
    final place = ref.watch(placeProvider);
    final filters = ref.watch(filtersProvider);
    final results = ref.watch(searchResultsProvider);
    final categories = ref.watch(categoriesProvider);

    return Scaffold(
      appBar: AppBar(
        titleSpacing: Gap.lg,
        title: InkWell(
          borderRadius: BorderRadius.circular(Corners.md),
          onTap: () => _pickPlace(context),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: Gap.xs),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(place.fromDevice ? Icons.my_location : Icons.place_outlined, size: 20, color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: Gap.sm),
                Flexible(child: Text(place.label, overflow: TextOverflow.ellipsis)),
                const Icon(Icons.keyboard_arrow_down),
              ],
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          // Categories configured by the administrator (initially only Salon).
          SizedBox(
            height: 52,
            child: categories.when(
              data: (list) => ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.sm),
                children: [
                  for (final c in list)
                    Padding(
                      padding: const EdgeInsets.only(right: Gap.sm),
                      child: ChoiceChip(
                        label: Text(c.name),
                        selected: filters.category == c.code,
                        onSelected: (_) => ref.read(filtersProvider.notifier).update((f) => f.copyWith(category: c.code)),
                      ),
                    ),
                ],
              ),
              loading: () => const SizedBox.shrink(),
              error: (_, _) => const SizedBox.shrink(),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.sm),
            child: Row(
              children: [
                PopupMenuButton<String>(
                  initialValue: filters.sort,
                  onSelected: (v) => ref.read(filtersProvider.notifier).update((f) => f.copyWith(sort: v)),
                  itemBuilder: (_) => [for (final e in SearchFilters.sortLabels.entries) PopupMenuItem(value: e.key, child: Text(e.value))],
                  child: Chip(avatar: const Icon(Icons.swap_vert, size: 18), label: Text(SearchFilters.sortLabels[filters.sort]!)),
                ),
                const SizedBox(width: Gap.sm),
                FilterChip(
                  label: const Text('Open now'),
                  selected: filters.openNow,
                  onSelected: (v) => ref.read(filtersProvider.notifier).update((f) => f.copyWith(openNow: v)),
                ),
                const Spacer(),
                SegmentedButton<bool>(
                  showSelectedIcon: false,
                  style: SegmentedButton.styleFrom(visualDensity: VisualDensity.compact),
                  segments: const [
                    ButtonSegment(value: false, icon: Icon(Icons.view_list_rounded, size: 20)),
                    ButtonSegment(value: true, icon: Icon(Icons.map_outlined, size: 20)),
                  ],
                  selected: {_mapView},
                  onSelectionChanged: (s) => setState(() => _mapView = s.first),
                ),
              ],
            ),
          ),
          Expanded(
            child: results.when(
              loading: () => const BrandLoader(),
              error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(searchResultsProvider)),
              data: (r) {
                if (r.items.isEmpty) {
                  return EmptyState(
                    icon: Icons.search_off_rounded,
                    art: BrandArt.emptySalons,
                    title: 'No salons found nearby',
                    message: filters.openNow
                        ? 'Nothing is open right now around ${place.label}. Try turning off "Open now".'
                        : 'We have not launched around ${place.label} yet. Try another city.',
                    action: OutlinedButton(
                      style: OutlinedButton.styleFrom(minimumSize: const Size(200, 48)),
                      onPressed: () => _pickPlace(context),
                      child: const Text('Change location'),
                    ),
                  );
                }
                if (_mapView) return ProvidersMap(cards: r.items, center: LatLng(place.lat, place.lng), onOpen: _open);
                return RefreshIndicator(
                  onRefresh: () => ref.refresh(searchResultsProvider.future),
                  child: ListView.separated(
                    controller: _scroll,
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.xs, Gap.lg, Gap.xl),
                    itemCount: r.items.length + (r.hasMore ? 1 : 0),
                    separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
                    itemBuilder: (context, i) {
                      if (i >= r.items.length) {
                        return const Padding(
                          padding: EdgeInsets.all(Gap.lg),
                          child: Center(child: CircularProgressIndicator()),
                        );
                      }
                      return ProviderCardTile(card: r.items[i], onTap: () => _open(r.items[i]));
                    },
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pickPlace(BuildContext context) async {
    final current = ref.read(placeProvider);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Where are you looking?', style: Theme.of(sheet).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: Gap.md),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const CircleAvatar(child: Icon(Icons.my_location)),
                title: const Text('Use my current location'),
                subtitle: const Text('Only used to find salons near you'),
                onTap: () async {
                  final navigator = Navigator.of(sheet);
                  final messenger = ScaffoldMessenger.of(context);
                  final result = await locateDevice();
                  navigator.pop();
                  switch (result) {
                    case DeviceLocationFound(:final place):
                      await ref.read(placeProvider.notifier).select(place);
                    case DeviceLocationUnavailable(:final message, :final canOpenSettings):
                      messenger.showSnackBar(
                        SnackBar(
                          content: Text(message),
                          action: canOpenSettings ? SnackBarAction(label: 'Settings', onPressed: Geolocator.openAppSettings) : null,
                        ),
                      );
                  }
                },
              ),
              const Divider(),
              Wrap(
                spacing: Gap.sm,
                runSpacing: Gap.sm,
                children: [
                  for (final p in PlaceChoice.presets)
                    ChoiceChip(
                      label: Text(p.label),
                      selected: !current.fromDevice && current.label == p.label,
                      onSelected: (_) {
                        ref.read(placeProvider.notifier).select(p);
                        Navigator.of(sheet).pop();
                      },
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
