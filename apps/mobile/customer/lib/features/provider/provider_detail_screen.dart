import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../discover/search_state.dart';

/// A salon's page: who they are, when they are open, what they offer and what it costs.
/// Services are TICKED, one or more: a haircut + a facial, a car wash + a tyre change. They are done together in one visit.
class ProviderDetailScreen extends ConsumerStatefulWidget {
  const ProviderDetailScreen({super.key, required this.locationId});

  final String locationId;

  @override
  ConsumerState<ProviderDetailScreen> createState() => _ProviderDetailScreenState();
}

class _ProviderDetailScreenState extends ConsumerState<ProviderDetailScreen> {
  /// The ticked services, in the order they were ticked.
  final _selected = <String>[];

  void _toggle(String id) => setState(() => _selected.contains(id) ? _selected.remove(id) : _selected.add(id));

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(locationProfileProvider(widget.locationId));
    return Scaffold(
      body: profile.when(
        loading: () => const BrandLoader(),
        error: (e, _) => Scaffold(
          appBar: AppBar(),
          body: ErrorState(error: e, onRetry: () => ref.invalidate(locationProfileProvider(widget.locationId))),
        ),
        data: (p) => _Content(profile: p, selected: _selected.toSet(), onToggle: _toggle),
      ),
      bottomNavigationBar: profile.maybeWhen(
        data: (p) => p.services.isEmpty ? null : _BookBar(profile: p, selected: _selected),
        orElse: () => null,
      ),
    );
  }
}

/// The button at the bottom: "Book an appointment" until something is ticked, then what was ticked and what it costs together.
class _BookBar extends StatelessWidget {
  const _BookBar({required this.profile, required this.selected});

  final LocationProfile profile;
  final List<String> selected;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final chosen = [for (final id in selected) ?profile.services.where((s) => s.id == id).firstOrNull];
    final total = chosen.fold(Money.zero, (sum, s) => sum + s.price);
    final minutes = chosen.fold(0, (sum, s) => sum + s.durationMin);
    final label = switch (chosen.length) {
      0 => 'Book an appointment',
      1 => 'Book ${chosen.first.name}',
      _ => 'Book ${chosen.length} services',
    };
    return Material(
      elevation: 8,
      color: t.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(Gap.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (chosen.isNotEmpty) ...[
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${chosen.length} selected · about ${formatDuration(minutes)}',
                        style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
                      ),
                    ),
                    Text(total.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                  ],
                ),
                const SizedBox(height: Gap.md),
              ],
              FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                onPressed: () => context.push(
                  chosen.isEmpty ? '/book/${profile.locationId}' : '/book/${profile.locationId}?services=${chosen.map((s) => s.id).join(',')}',
                ),
                child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Content extends StatelessWidget {
  const _Content({required this.profile, required this.selected, required this.onToggle});

  final LocationProfile profile;
  final Set<String> selected;
  final void Function(String serviceId) onToggle;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = t.colorScheme;
    return CustomScrollView(
      slivers: [
        SliverAppBar(
          pinned: true,
          expandedHeight: 170,
          backgroundColor: c.primary,
          foregroundColor: c.onPrimary,
          flexibleSpace: FlexibleSpaceBar(
            titlePadding: const EdgeInsetsDirectional.only(start: Gap.lg + 40, bottom: Gap.lg, end: Gap.lg),
            title: Text(
              profile.name,
              style: t.textTheme.titleLarge?.copyWith(color: c.onPrimary, fontWeight: FontWeight.w800),
            ),
            background: Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [c.primary, c.tertiary]),
              ),
              child: Align(
                alignment: Alignment.topRight,
                child: Padding(
                  padding: const EdgeInsets.all(Gap.xl),
                  child: Icon(Icons.content_cut_rounded, size: 72, color: c.onPrimary.withValues(alpha: 0.18)),
                ),
              ),
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Gap.lg, Gap.lg, Gap.lg, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    StatusPill(profile.openNow ? 'Open now' : 'Closed now', tone: profile.openNow ? Tone.success : Tone.neutral),
                    const SizedBox(width: Gap.md),
                    const Icon(Icons.star_rounded, size: 18, color: Color(0xFFF5A623)),
                    const SizedBox(width: Gap.xs),
                    Text(
                      profile.rating.hasRatings
                          ? '${profile.rating.average!.toStringAsFixed(1)} · ${profile.rating.count} reviews'
                          : 'New on TokenGo',
                      style: t.textTheme.labelLarge,
                    ),
                  ],
                ),
                const SizedBox(height: Gap.lg),
                if (profile.description != null && profile.description!.isNotEmpty) ...[
                  Text(profile.description!, style: t.textTheme.bodyLarge),
                  const SizedBox(height: Gap.lg),
                ],
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(Gap.lg),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(Icons.place_outlined, color: c.primary),
                        const SizedBox(width: Gap.md),
                        Expanded(
                          child: Text(
                            '${profile.locationName}\n${profile.address.oneLine}, ${profile.address.state} ${profile.address.postalCode}',
                            style: t.textTheme.bodyMedium,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: Gap.md),
                _HoursCard(hours: profile.hours),
              ],
            ),
          ),
        ),
        const SliverToBoxAdapter(child: SectionHeader('Services')),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.sm),
            child: Text(
              'Tick one or more. They are done together in one visit.',
              style: t.textTheme.bodyMedium?.copyWith(color: c.onSurfaceVariant),
            ),
          ),
        ),
        SliverList.separated(
          itemCount: profile.services.length,
          separatorBuilder: (_, _) => const SizedBox(height: Gap.sm),
          itemBuilder: (context, i) {
            final s = profile.services[i];
            final ticked = selected.contains(s.id);
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
              child: Card(
                color: ticked ? c.primaryContainer : null,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(Corners.lg),
                  side: BorderSide(color: ticked ? c.primary : c.outlineVariant, width: ticked ? 2 : 1),
                ),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: () => onToggle(s.id),
                  child: Padding(
                    padding: const EdgeInsets.all(Gap.lg),
                    child: Row(
                      children: [
                        Checkbox(value: ticked, onChanged: (_) => onToggle(s.id)),
                        const SizedBox(width: Gap.xs),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(s.name, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                              const SizedBox(height: Gap.xs),
                              Text(
                                '${formatDuration(s.durationMin)}${s.description != null && s.description!.isNotEmpty ? ' · ${s.description}' : ''}',
                                style: t.textTheme.bodyMedium?.copyWith(color: c.onSurfaceVariant),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: Gap.md),
                        Text(s.price.format(), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                ),
              ),
            );
          },
        ),
        if (profile.staff.isNotEmpty) ...[
          const SliverToBoxAdapter(child: SectionHeader('Stylists')),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Gap.lg),
              child: Wrap(
                spacing: Gap.sm,
                runSpacing: Gap.sm,
                children: [
                  for (final s in profile.staff)
                    Chip(
                      avatar: CircleAvatar(child: Text(s.displayName[0])),
                      label: Text(s.displayName),
                    ),
                ],
              ),
            ),
          ),
        ],
        const SliverToBoxAdapter(child: SizedBox(height: Gap.xl)),
      ],
    );
  }
}

class _HoursCard extends StatelessWidget {
  const _HoursCard({required this.hours});

  final List<OpeningDay> hours;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final today = DateTime.now().weekday;
    final todayHours = hours.where((h) => h.weekday == today).firstOrNull;
    final summary = todayHours == null || todayHours.closed
        ? 'Closed today'
        : 'Today ${todayHours.windows.map((w) => '${formatLocalTime(w.start)} – ${formatLocalTime(w.end)}').join(', ')}';
    return Card(
      child: Theme(
        data: t.copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          leading: Icon(Icons.schedule, color: t.colorScheme.primary),
          title: Text(summary, style: t.textTheme.bodyMedium),
          childrenPadding: const EdgeInsets.fromLTRB(Gap.lg, 0, Gap.lg, Gap.lg),
          children: [
            for (final h in hours)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: Gap.xs),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 110,
                      child: Text(
                        weekdayName(h.weekday),
                        style: t.textTheme.bodyMedium?.copyWith(fontWeight: h.weekday == today ? FontWeight.w800 : FontWeight.w400),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        h.closed
                            ? 'Closed'
                            : h.windows.map((w) => '${formatLocalTime(w.start)} – ${formatLocalTime(w.end)}').join(', ') +
                                  (h.breaks.isEmpty
                                      ? ''
                                      : '\nBreak ${h.breaks.map((b) => '${formatLocalTime(b.start)} – ${formatLocalTime(b.end)}').join(', ')}'),
                        style: t.textTheme.bodyMedium?.copyWith(color: h.closed ? t.colorScheme.outline : null),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
