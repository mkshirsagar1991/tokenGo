import 'package:flutter/foundation.dart';

import 'provider_account.dart';
import 'provider_setup.dart';

/// The steps that take a new owner from nothing to "submitted for review", in the order they make sense: a location comes
/// first because staff and hours belong to one, services before staff because staff are assigned services, and the
/// submission last. The server only insists on a location; the rest is what makes the business bookable.
enum OnboardingStepId { business, location, service, hours, staff, submit }

@immutable
class OnboardingStep {
  const OnboardingStep({required this.id, required this.title, required this.hint, required this.done});

  final OnboardingStepId id;
  final String title;

  /// One line saying what to do (or what was done).
  final String hint;
  final bool done;
}

@immutable
class OnboardingChecklist {
  const OnboardingChecklist._(this.steps, this.business);

  /// [hasHours]: at least one location has opening hours.
  factory OnboardingChecklist.compute({
    required ProviderAccount? business,
    required List<OwnedLocation> locations,
    required List<OwnedService> services,
    required List<OwnedStaff> staff,
    required bool hasHours,
  }) {
    final hasLocation = locations.any((l) => l.isActive);
    final hasService = services.any((s) => s.isActive);
    final hasStaff = staff.any((s) => s.status != 'INACTIVE');
    final submitted = business != null && !business.canSubmit;
    return OnboardingChecklist._([
      OnboardingStep(
        id: OnboardingStepId.business,
        title: 'Register your business',
        hint: business == null ? 'Tell us the name customers will see' : business.displayName,
        done: business != null,
      ),
      OnboardingStep(
        id: OnboardingStepId.location,
        title: 'Add a location',
        hint: hasLocation ? '${locations.where((l) => l.isActive).length} added' : 'Where customers come to you',
        done: hasLocation,
      ),
      OnboardingStep(
        id: OnboardingStepId.service,
        title: 'Add a service',
        hint: hasService ? '${services.where((s) => s.isActive).length} added' : 'What you offer, with a price and duration',
        done: hasService,
      ),
      OnboardingStep(
        id: OnboardingStepId.hours,
        title: 'Set your opening hours',
        hint: hasHours ? 'Opening hours are set' : 'The days and times you take bookings',
        done: hasHours,
      ),
      OnboardingStep(
        id: OnboardingStepId.staff,
        title: 'Add a staff member',
        hint: hasStaff
            ? '${staff.where((s) => s.status != 'INACTIVE').length} added'
            : 'Add yourself or a stylist: bookings are made with a person',
        done: hasStaff,
      ),
      OnboardingStep(
        id: OnboardingStepId.submit,
        title: 'Submit for review',
        hint: submitted ? 'Submitted' : 'TokenGo checks your business before it appears to customers',
        done: submitted,
      ),
    ], business);
  }

  final List<OnboardingStep> steps;
  final ProviderAccount? business;

  OnboardingStep step(OnboardingStepId id) => steps.firstWhere((s) => s.id == id);

  /// The first step not done yet; null once everything is done.
  OnboardingStep? get next {
    for (final s in steps) {
      if (!s.done) return s;
    }
    return null;
  }

  int get doneCount => steps.where((s) => s.done).length;
  bool get isComplete => steps.every((s) => s.done);

  /// Everything before the submission is done — only then is "Submit for review" offered. (The server itself would accept a
  /// submission with just a location; offering it earlier would send TokenGo a business customers could not book.)
  bool get readyToSubmit => steps.where((s) => s.id != OnboardingStepId.submit).every((s) => s.done);

  /// Whether [id] can be started now. Only the submission is gated (on [readyToSubmit]); every other step stays reachable so
  /// an owner can fix things in any order.
  bool canStart(OnboardingStepId id) => id != OnboardingStepId.submit || readyToSubmit;
}
