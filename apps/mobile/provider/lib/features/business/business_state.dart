import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tokengo_core/tokengo_core.dart';

import '../../core/providers.dart';

/// The businesses this person owns. Re-created when a different person signs in.
final myBusinessesProvider = FutureProvider.autoDispose<List<ProviderAccount>>((ref) {
  ref.watch(sessionUserProvider);
  return ref.watch(providerRepositoryProvider).mine();
});

/// The business the app works on: the first approved one, else the first one (so its review status can be shown).
/// null = this person has no business yet.
final currentBusinessProvider = FutureProvider.autoDispose<ProviderAccount?>((ref) async {
  final all = await ref.watch(myBusinessesProvider.future);
  if (all.isEmpty) return null;
  return all.firstWhere((b) => b.isApproved, orElse: () => all.first);
});

/// Reads [read] for the current business; an empty value when there is none. Everything below is per signed-in person.
Future<T> _forBusiness<T>(Ref ref, T empty, Future<T> Function(ProviderSetupRepository repo, String providerId) read) async {
  ref.watch(sessionUserProvider);
  final business = await ref.watch(currentBusinessProvider.future);
  if (business == null) return empty;
  return read(ref.watch(setupRepositoryProvider), business.id);
}

final locationsProvider = FutureProvider.autoDispose<List<OwnedLocation>>((ref) => _forBusiness(ref, const [], (r, id) => r.locations(id)));

final servicesProvider = FutureProvider.autoDispose<List<OwnedService>>((ref) => _forBusiness(ref, const [], (r, id) => r.services(id)));

final staffProvider = FutureProvider.autoDispose<List<OwnedStaff>>((ref) => _forBusiness(ref, const [], (r, id) => r.staff(id)));

final policyProvider = FutureProvider.autoDispose<BookingPolicy?>(
  (ref) => _forBusiness<BookingPolicy?>(ref, null, (r, id) => r.policy(id)),
);

/// A location's weekly opening hours.
final locationHoursProvider = FutureProvider.autoDispose.family<WeeklyHours, String>(
  (ref, locationId) => _forBusiness(ref, const WeeklyHours(), (r, id) => r.locationHours(id, locationId)),
);

final locationExceptionsProvider = FutureProvider.autoDispose.family<List<ScheduleException>, String>(
  (ref, locationId) => _forBusiness(ref, const [], (r, id) => r.locationExceptions(id, locationId)),
);

/// A staff member's own hours (no opening windows = they follow the location's).
final staffScheduleProvider = FutureProvider.autoDispose.family<WeeklyHours, String>(
  (ref, staffId) => _forBusiness(ref, const WeeklyHours(), (r, id) => r.staffSchedule(id, staffId)),
);

final staffExceptionsProvider = FutureProvider.autoDispose.family<List<ScheduleException>, String>(
  (ref, staffId) => _forBusiness(ref, const [], (r, id) => r.staffExceptions(id, staffId)),
);

final staffBlocksProvider = FutureProvider.autoDispose.family<List<StaffBlock>, String>(
  (ref, staffId) => _forBusiness(ref, const [], (r, id) => r.blocks(id, staffId)),
);

final staffSkillsProvider = FutureProvider.autoDispose.family<StaffSkills?, String>(
  (ref, staffId) => _forBusiness<StaffSkills?>(ref, null, (r, id) => r.staffSkills(id, staffId)),
);

/// The catalogue the owner picks a service from: each ENABLED category with its service types (today only Salon).
final serviceCatalogProvider = FutureProvider.autoDispose<List<({ServiceCategory category, List<ServiceType> types})>>((ref) async {
  final categories = await ref.watch(discoveryRepositoryProvider).categories();
  final repo = ref.watch(setupRepositoryProvider);
  return [for (final c in categories) (category: c, types: await repo.serviceTypes(c.code))];
});

/// Staff invitations addressed to the signed-in person's phone number.
final invitationsProvider = FutureProvider.autoDispose<List<StaffInvitation>>((ref) {
  ref.watch(sessionUserProvider);
  return ref.watch(setupRepositoryProvider).myInvitations();
});

/// Where the new-owner checklist stands, from what the server says exists.
final onboardingProvider = FutureProvider.autoDispose<OnboardingChecklist>((ref) async {
  final business = await ref.watch(currentBusinessProvider.future);
  if (business == null) {
    return OnboardingChecklist.compute(business: null, locations: const [], services: const [], staff: const [], hasHours: false);
  }
  final locations = await ref.watch(locationsProvider.future);
  final services = await ref.watch(servicesProvider.future);
  final staff = await ref.watch(staffProvider.future);
  var hasHours = false;
  for (final l in locations.where((l) => l.isActive)) {
    final hours = await ref.watch(locationHoursProvider(l.id).future);
    if (hours.working.isNotEmpty) hasHours = true;
  }
  return OnboardingChecklist.compute(business: business, locations: locations, services: services, staff: staff, hasHours: hasHours);
});

/// After ANY change to the business's setup, make every screen show the server's truth (called after success and after a
/// refusal alike).
void refreshSetup(WidgetRef ref) {
  ref.invalidate(myBusinessesProvider);
  ref.invalidate(locationsProvider);
  ref.invalidate(servicesProvider);
  ref.invalidate(staffProvider);
  ref.invalidate(onboardingProvider);
  ref.invalidate(policyProvider);
  ref.invalidate(locationHoursProvider);
  ref.invalidate(locationExceptionsProvider);
  ref.invalidate(staffScheduleProvider);
  ref.invalidate(staffExceptionsProvider);
  ref.invalidate(staffBlocksProvider);
  ref.invalidate(staffSkillsProvider);
}
