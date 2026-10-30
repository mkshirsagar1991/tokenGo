import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tokengo_core/tokengo_core.dart';

import 'booking_state.dart';

/// "My bookings": what is coming up, and what is done.
class BookingsScreen extends ConsumerWidget {
  const BookingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signedIn = ref.watch(sessionUserProvider) != null;
    if (!signedIn) {
      return Scaffold(
        appBar: AppBar(title: const Text('Bookings')),
        body: SignInPrompt(
          title: 'Your bookings live here',
          message: 'Sign in to see your appointments and follow their progress.',
          onSignIn: () => context.push('/login'),
        ),
      );
    }
    final bookings = ref.watch(bookingsProvider);
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Bookings'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Upcoming'),
              Tab(text: 'Past'),
            ],
          ),
        ),
        body: bookings.when(
          loading: () => const BrandLoader(),
          error: (e, _) => ErrorState(error: e, onRetry: () => ref.invalidate(bookingsProvider)),
          data: (state) => TabBarView(
            children: [
              _BookingList(
                items: state.upcoming,
                state: state,
                emptyTitle: 'Nothing coming up',
                emptyMessage: 'Find a salon and book your next appointment.',
                emptyAction: FilledButton(
                  style: FilledButton.styleFrom(minimumSize: const Size(200, 48)),
                  onPressed: () => context.go('/'),
                  child: const Text('Find a salon'),
                ),
              ),
              _BookingList(
                items: state.past,
                state: state,
                emptyTitle: 'No past bookings yet',
                emptyMessage: 'Completed and cancelled bookings show up here.',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BookingList extends ConsumerWidget {
  const _BookingList({required this.items, required this.state, required this.emptyTitle, required this.emptyMessage, this.emptyAction});

  final List<Booking> items;
  final BookingsState state;
  final String emptyTitle;
  final String emptyMessage;
  final Widget? emptyAction;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () => ref.refresh(bookingsProvider.future),
      child: items.isEmpty && !state.hasMore
          ? ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                SizedBox(
                  height: 420,
                  child: EmptyState(icon: Icons.event_note_outlined, art: BrandArt.emptyBookings, title: emptyTitle, message: emptyMessage, action: emptyAction),
                ),
              ],
            )
          : ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(Gap.lg),
              itemCount: items.length + (state.hasMore ? 1 : 0),
              separatorBuilder: (_, _) => const SizedBox(height: Gap.md),
              itemBuilder: (context, i) {
                if (i >= items.length) {
                  // The last row: fetch the next page when it comes into view.
                  ref.read(bookingsProvider.notifier).loadMore();
                  return const Padding(
                    padding: EdgeInsets.all(Gap.lg),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                return BookingTile(booking: items[i], onTap: () => context.push('/bookings/${items[i].id}'));
              },
            ),
    );
  }
}

class BookingTile extends StatelessWidget {
  const BookingTile({super.key, required this.booking, required this.onTap});

  final Booking booking;
  final VoidCallback onTap;

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
              Text(booking.locationName ?? 'Salon', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
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
                  StatusPill(BookingStatus.label(booking.status), tone: bookingTone(booking.status)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
