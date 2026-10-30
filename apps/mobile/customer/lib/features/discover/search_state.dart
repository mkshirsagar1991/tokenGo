import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';
import 'place.dart';

/// The categories an administrator has enabled (initially only Salon).
final categoriesProvider = FutureProvider<List<ServiceCategory>>((ref) => ref.watch(discoveryRepositoryProvider).categories());

@immutable
class SearchFilters {
  const SearchFilters({this.category = 'salon', this.sort = 'distance', this.openNow = false});

  final String category;

  /// distance | price | rating | next_available
  final String sort;
  final bool openNow;

  SearchFilters copyWith({String? category, String? sort, bool? openNow}) =>
      SearchFilters(category: category ?? this.category, sort: sort ?? this.sort, openNow: openNow ?? this.openNow);

  static const sortLabels = {'distance': 'Nearest', 'price': 'Lowest price', 'rating': 'Top rated', 'next_available': 'Soonest available'};
}

class FiltersNotifier extends Notifier<SearchFilters> {
  @override
  SearchFilters build() => const SearchFilters();

  void update(SearchFilters Function(SearchFilters) change) => state = change(state);
}

final filtersProvider = NotifierProvider<FiltersNotifier, SearchFilters>(FiltersNotifier.new);

@immutable
class SearchResults {
  const SearchResults(this.items, this.nextCursor, {this.loadingMore = false});

  final List<ProviderCard> items;
  final String? nextCursor;
  final bool loadingMore;

  bool get hasMore => nextCursor != null;
  SearchResults copyWith({List<ProviderCard>? items, String? nextCursor, bool? loadingMore, bool clearCursor = false}) => SearchResults(
    items ?? this.items,
    clearCursor ? null : (nextCursor ?? this.nextCursor),
    loadingMore: loadingMore ?? this.loadingMore,
  );
}

/// Nearby providers for the chosen place and filters. Changing either reloads from the first page.
class SearchResultsNotifier extends AsyncNotifier<SearchResults> {
  @override
  Future<SearchResults> build() async {
    final place = ref.watch(placeProvider);
    final filters = ref.watch(filtersProvider);
    final page = await ref
        .read(discoveryRepositoryProvider)
        .search(
          lat: place.lat,
          lng: place.lng,
          radiusMeters: 25000,
          category: filters.category,
          sort: filters.sort,
          openNow: filters.openNow ? true : null,
        );
    return SearchResults(page.items, page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(current.copyWith(loadingMore: true));
    try {
      final place = ref.read(placeProvider);
      final filters = ref.read(filtersProvider);
      final page = await ref
          .read(discoveryRepositoryProvider)
          .search(
            lat: place.lat,
            lng: place.lng,
            radiusMeters: 25000,
            category: filters.category,
            sort: filters.sort,
            openNow: filters.openNow ? true : null,
            cursor: current.nextCursor,
          );
      state = AsyncData(SearchResults([...current.items, ...page.items], page.nextCursor));
    } catch (_) {
      // Keep what we have; the person can scroll again to retry.
      state = AsyncData(current.copyWith(loadingMore: false));
    }
  }
}

final searchResultsProvider = AsyncNotifierProvider<SearchResultsNotifier, SearchResults>(SearchResultsNotifier.new);

/// One provider location's page. Refreshes when re-opened.
final locationProfileProvider = FutureProvider.autoDispose.family<LocationProfile, String>(
  (ref, locationId) => ref.watch(discoveryRepositoryProvider).profile(locationId),
);
