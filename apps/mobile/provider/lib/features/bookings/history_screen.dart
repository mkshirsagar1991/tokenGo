import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'booking_widgets.dart';
import 'bookings_state.dart';

/// Every booking, newest first, with a status filter.
class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  static const _filters = <(String?, String)>[
    (null, 'All'),
    (BookingStatus.requested, 'New'),
    (BookingStatus.confirmed, 'Confirmed'),
    (BookingStatus.serviceStarted, 'In progress'),
    (BookingStatus.closed, 'Completed'),
    (BookingStatus.customerCancelled, 'Cancelled'),
    (BookingStatus.providerRejected, 'Declined'),
    (BookingStatus.noShow, 'No-show'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final filter = ref.watch(historyFilterProvider);
    final history = ref.watch(historyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Bookings')),
      body: Column(
        children: [
          SizedBox(
            height: 52,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: Gap.lg, vertical: Gap.sm),
              itemCount: _filters.length,
              separatorBuilder: (_, _) => const SizedBox(width: Gap.sm),
              itemBuilder: (_, i) {
                final (status, label) = _filters[i];
                return ChoiceChip(
                  label: Text(label),
                  selected: filter == status,
                  onSelected: (_) => ref.read(historyFilterProvider.notifier).choose(status),
                );
              },
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => ref.refresh(historyProvider.future),
              child: history.when(
                loading: () => const BrandLoader(),
                error: (e, _) => ListView(
                  children: [
                    SizedBox(
                      height: 400,
                      child: ErrorState(error: e, onRetry: () => ref.invalidate(historyProvider)),
                    ),
                  ],
                ),
                data: (s) => s.items.isEmpty
                    ? ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        children: const [
                          SizedBox(
                            height: 420,
                            child: EmptyState(
                              icon: Icons.event_note_outlined,
                              art: BrandArt.emptyBookingsBusiness,
                              title: 'No bookings',
                              message: 'Bookings from customers show up here.',
                            ),
                          ),
                        ],
                      )
                    : ListView.separated(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.all(Gap.lg),
                        itemCount: s.items.length + (s.hasMore ? 1 : 0),
                        separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
                        itemBuilder: (context, i) {
                          if (i >= s.items.length) {
                            ref.read(historyProvider.notifier).loadMore();
                            return const Padding(
                              padding: EdgeInsets.all(Gap.lg),
                              child: Center(child: CircularProgressIndicator()),
                            );
                          }
                          return BookingTile(booking: s.items[i], onTap: () => context.push('/booking/${s.items[i].id}'));
                        },
                      ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
