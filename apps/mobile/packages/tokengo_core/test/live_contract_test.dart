import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';

/// CONTRACT test against REAL server output.
///
/// `test/fixtures/live/*.json` are responses captured from the running dev API (demo data; no tokens, no secrets — the Razorpay
/// key id is scrubbed). Every parser the apps use runs over them, so a model that disagrees with what the server really
/// sends fails here. This exists because a hand-written fixture only proves the model agrees with the author's assumption: the
/// wallet model once compared the statement's `account` against `CUSTOMER_HELD` while the server sends `HELD`, and every
/// hand-written test passed.
///
/// Re-capture after an API change by re-running the capture script against the dev server (see apps/mobile/README.md).
Map<String, dynamic> fixture(String name) {
  final file = File('test/fixtures/live/$name.json');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

Map<String, dynamic> body(String name) => fixture(name)['body'] as Map<String, dynamic>;
List<Map<String, dynamic>> items(String name) => (body(name)['data'] as List).cast<Map<String, dynamic>>();

void main() {
  test('every fixture was captured from a successful (or expected-error) response', () {
    // A fixture is named for what it captured: `*_created` is a 201, `*_declined` a 204, `*_refused` a problem+json refusal.
    const refusals = {
      'arrival_code_outside_window': 409,
      'setup_submit_incomplete_refused': 409,
      'setup_submit_again_refused': 409,
      'setup_location_invalid_refused': 422,
      'setup_service_invalid_refused': 422,
      'setup_hours_overlap_refused': 422,
      'setup_staff_invalid_phone_refused': 422,
    };
    for (final f in Directory('test/fixtures/live').listSync().whereType<File>()) {
      final name = f.uri.pathSegments.last.replaceAll('.json', '');
      final status = (jsonDecode(f.readAsStringSync()) as Map<String, dynamic>)['status'] as int;
      final expected = refusals[name] ?? (name.endsWith('_created') ? 201 : (name == 'setup_invitation_declined' ? 204 : 200));
      expect(status, expected, reason: name);
    }
  });

  group('discovery', () {
    test('categories', () {
      final cats = items('categories').map(ServiceCategory.fromJson).toList();
      expect(cats, isNotEmpty);
      expect(cats.first.code, 'salon');
    });

    test('search results', () {
      final cards = items('search_providers').map(ProviderCard.fromJson).toList();
      expect(cards, isNotEmpty);
      expect(cards.first.distanceM, greaterThan(0));
      expect(cards.first.priceFrom?.minor, greaterThan(0));
    });

    test('map pins', () {
      expect(items('search_map').map(MapPin.fromJson), isNotEmpty);
    });

    test('location profile (hours, services, staff)', () {
      final p = LocationProfile.fromJson(body('location_profile')['data'] as Map<String, dynamic>);
      expect(p.services, isNotEmpty);
      expect(p.services.first.price.minor, greaterThan(0));
    });

    test('availability slots carry resource ids for booking', () {
      final r = SlotsResult.fromJson(body('slots')['data'] as Map<String, dynamic>);
      expect(r.slots, isNotEmpty);
      expect(r.slots.first.resources, isNotEmpty);
      expect(r.timezone, 'Asia/Kolkata');
    });
  });

  group('customer', () {
    test('profile (masked phone, permissions)', () {
      final me = UserProfile.fromJson(body('customer_me')['data'] as Map<String, dynamic>);
      expect(me.phoneMasked, contains('•'));
      expect(me.phoneMasked, isNot(contains('9000000021')));
    });

    test('wallet balance: available + held', () {
      final w = WalletBalance.fromJson(body('wallet')['data'] as Map<String, dynamic>);
      expect(w.available.minor + w.held.minor, greaterThan(0));
    });

    test('wallet statement: the server names the pockets AVAILABLE / HELD (not CUSTOMER_*)', () {
      final entries = items('wallet_transactions').map(WalletEntry.fromJson).toList();
      expect(entries, isNotEmpty);
      expect(entries.any((e) => e.touchesHeld), isTrue, reason: 'a hold has a HELD leg');
      expect(entries.any((e) => !e.touchesHeld), isTrue);
      expect(entries.map((e) => e.account).toSet(), everyElement(anyOf('AVAILABLE', 'HELD')));
    });

    test('bookings list, one booking, its events', () {
      final list = items('appointments_list').map(Booking.fromJson).toList();
      expect(list, isNotEmpty);
      final one = Booking.fromJson(body('appointment')['data'] as Map<String, dynamic>);
      expect(one.reference, startsWith('TG-'));
      expect(one.localStart, matches(RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$')), reason: 'location wall-clock, no zone');
      final events = items('appointment_events').map(BookingEvent.fromJson).toList();
      expect(events, isNotEmpty);
    });

    test('a refused arrival code is a stable, readable problem (code + detail)', () {
      final f = fixture('arrival_code_outside_window');
      final e = ApiException.fromProblem(f['status'] as int, f['body'] as Map<String, dynamic>);
      expect(e.code, 'OUTSIDE_CHECK_IN_WINDOW');
      expect(e.isConflict, isTrue);
      expect(e.userMessage, isNotEmpty);
    });

    test('payment intent: Razorpay checkout needs the order id and a key id', () {
      final i = PaymentIntent.fromJson(body('payment_intent')['data'] as Map<String, dynamic>);
      expect(i.provider, 'razorpay');
      expect(i.isPending, isTrue);
      expect(i.razorpayOrderId, startsWith('order_'));
      expect(i.razorpayKeyId, startsWith('rzp_test_'));
      expect(i.amount.minor, greaterThan(0));
    });
  });

  group('provider', () {
    test('owner profile and businesses', () {
      UserProfile.fromJson(body('owner_me')['data'] as Map<String, dynamic>);
      final mine = items('providers_mine').map(ProviderAccount.fromJson).toList();
      expect(mine, isNotEmpty);
      expect(mine.first.isApproved, isTrue);
    });

    test('provider bookings list parses with the same Booking model', () {
      expect(items('provider_appointments').map(Booking.fromJson), isNotEmpty);
    });

    test('earnings, payables, payouts and a missing bank account', () {
      final e = Earnings.fromJson(body('provider_earnings')['data'] as Map<String, dynamic>);
      expect(e.minimumPayout.minor, greaterThan(0));
      expect(PayoutBlocker.explain(e.blocker), anyOf(isNull, isNotEmpty));
      items('provider_payables').map(Payable.fromJson).toList();
      items('provider_payouts').map(Payout.fromJson).toList();
      expect(body('provider_payout_account')['data'], isNull, reason: 'no account yet is `null`, not an error');
    });
  });

  group('provider setup (every parser over what the real API sent)', () {
    Map<String, dynamic> data(String name) => body(name)['data'] as Map<String, dynamic>;
    ApiException problem(String name) => ApiException.fromProblem(fixture(name)['status'] as int, body(name));

    test('the business: DRAFT after registering, SUBMITTED after submitting, with its description and timestamps', () {
      final registered = ProviderAccount.fromJson(data('setup_register_created'));
      expect(registered.status, ProviderAccount.draft);
      expect(registered.canSubmit, isTrue);
      expect(registered.description, isNotEmpty);
      expect(registered.submittedAt, isNull);
      final submitted = ProviderAccount.fromJson(data('setup_submit'));
      expect(submitted.isInReview, isTrue);
      expect(submitted.canSubmit, isFalse);
      expect(submitted.submittedAt, isNotNull);
      expect(ProviderAccount.fromJson(data('setup_provider_get')).isApproved, isTrue);
      expect(items('setup_providers_mine_new_owner').map(ProviderAccount.fromJson), isNotEmpty);
    });

    test('submitting before there is a location is a stable PROVIDER_INCOMPLETE refusal; twice is INVALID_STATE_TRANSITION', () {
      final incomplete = problem('setup_submit_incomplete_refused');
      expect(incomplete.code, 'PROVIDER_INCOMPLETE');
      expect(incomplete.isConflict, isTrue);
      expect(incomplete.userMessage, contains('location'));
      expect(problem('setup_submit_again_refused').code, 'INVALID_STATE_TRANSITION');
    });

    test('locations: the seeded one and a freshly created one (coordinates come back as numbers)', () {
      final seeded = items('setup_locations').map(OwnedLocation.fromJson).toList();
      expect(seeded.first.timezone, 'Asia/Kolkata');
      expect(seeded.first.latitude, closeTo(18.5, 0.5));
      final created = OwnedLocation.fromJson(data('setup_location_created'));
      expect(created.isActive, isTrue);
      expect(created.addressLine2, isNull);
      expect(created.latitude, 18.559);
      expect(OwnedLocation.fromJson(data('setup_location_updated')).addressLine2, 'Near the fixture park');
    });

    test('a LocationDraft produces the very body the server accepted for that location', () {
      const draft = LocationDraft(
        name: 'Fixture Salon - Baner',
        addressLine1: '12 Test Road',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411045',
        latitude: 18.559,
        longitude: 73.7868,
      );
      final created = OwnedLocation.fromJson(data('setup_location_created'));
      expect(draft.validate(), isEmpty);
      expect(draft.toCreateJson(), {
        'name': created.name,
        'address_line1': created.addressLine1,
        'city': created.city,
        'state': created.state,
        'postal_code': created.postalCode,
        'country': created.country,
        'latitude': created.latitude,
        'longitude': created.longitude,
        'timezone': created.timezone,
      });
    });

    test('field-level validation errors keep the server\'s field names and messages', () {
      final loc = problem('setup_location_invalid_refused');
      expect(loc.code, 'VALIDATION_FAILED');
      expect(loc.isValidation, isTrue);
      expect(loc.fields.keys, containsAll(['name', 'postal_code', 'latitude']));
      expect(loc.fields['postal_code']!.single, contains('invalid'));
      // The names the local validators use are the names the server uses, so an error lands on the right field.
      expect(const LocationDraft(postalCode: '!!', latitude: 200).validate().keys, containsAll(loc.fields.keys));
      final svc = problem('setup_service_invalid_refused');
      expect(svc.fields.keys, containsAll(['price_minor', 'duration_min']));
      expect(const ServiceDraft(priceRupees: '-1', durationMin: 2).validate(creating: false).keys, containsAll(svc.fields.keys));
      expect(problem('setup_staff_invalid_phone_refused').fields.keys, ['phone']);
      expect(const StaffDraft(locationId: 'l', displayName: 'x', phone: '12345').validate().keys, ['phone']);
      expect(problem('setup_hours_overlap_refused').fields.keys, ['working'], reason: 'the weekly editor shows it under the opening hours');
    });

    test('service types and services: price is {amount_minor,currency}, and a ServiceDraft sends the same paise', () {
      final types = items('setup_service_types').map(ServiceType.fromJson).toList();
      expect(types.map((t) => t.code), containsAll(['haircut', 'facial']));
      final seeded = items('setup_services').map(OwnedService.fromJson).toList();
      expect(seeded, isNotEmpty);
      expect(seeded.first.price.minor, greaterThan(0));
      final created = OwnedService.fromJson(data('setup_service_created'));
      expect(created.price, const Money(25050));
      expect(created.durationMin, 30);
      expect(created.bufferMin, 5);
      expect(created.isActive, isTrue);
      expect(ServiceDraft.from(created).priceRupees, '250.50');
      expect(
        ServiceDraft(
          serviceTypeId: created.serviceTypeId,
          name: 'Fixture haircut',
          priceRupees: '250.50',
          durationMin: 30,
          bufferMin: 5,
        ).toCreateJson(),
        {
          'service_type_id': created.serviceTypeId,
          'name': 'Fixture haircut',
          'price_minor': 25050,
          'currency': 'INR',
          'duration_min': 30,
          'buffer_min': 5,
        },
      );
      expect(OwnedService.fromJson(data('setup_service_updated')).price, const Money(27500));
    });

    test('staff: active, invited (no login yet), and the skills list', () {
      final seeded = items('setup_staff').map(OwnedStaff.fromJson).toList();
      expect(seeded, isNotEmpty);
      expect(seeded.first.status, 'ACTIVE');
      expect(seeded.first.resourceId, isNotNull);
      final created = OwnedStaff.fromJson(data('setup_staff_created'));
      expect(created.status, 'ACTIVE');
      expect(created.hasLogin, isFalse);
      final invited = OwnedStaff.fromJson(data('setup_staff_invited_created'));
      expect(invited.isInvited, isTrue);
      expect(invited.roleLabel, 'Manager');
      expect(items('setup_staff_list_with_invite').map(OwnedStaff.fromJson).where((s) => s.isInvited), isNotEmpty);
      final skills = StaffSkills.fromJson(data('setup_staff_skills'));
      expect(skills.restricted, isTrue);
      expect(skills.serviceIds, isNotEmpty);
      expect(StaffSkills.fromJson(data('setup_staff_skills_set')).serviceIds, hasLength(1));
    });

    test('the invitee\'s side: pending invitations, accepting returns the business, declining is a bodiless 204', () {
      final pending = items('setup_invitations').map(StaffInvitation.fromJson).toList();
      expect(pending, hasLength(2));
      expect(pending.map((i) => i.invitedAs), containsAll(['Fixture Invitee', 'Fixture Decliner']));
      final accepted = InvitationAccepted.fromJson(data('setup_invitation_accepted'));
      expect(accepted.id, pending.firstWhere((i) => i.invitedAs == 'Fixture Invitee').id);
      expect(accepted.staffRole, 'MANAGER');
      expect(fixture('setup_invitation_declined')['body'], isNull);
    });

    test('weekly hours: breaks and windows, 24h strings, and the saved pattern echoes what was sent', () {
      final seeded = WeeklyHours.fromJson(data('setup_location_hours'));
      expect(seeded.working, isNotEmpty);
      expect(seeded.validate(), isEmpty);
      final set = WeeklyHours.fromJson(data('setup_location_hours_set'));
      expect(set.working, WeeklyHours.uniform(weekdays: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00').working);
      expect(set.breaks, hasLength(6));
      expect(set.breaksOn(3).single, const HoursWindow(3, '13:00', '14:00'));
      expect(set.isOpenOn(7), isFalse);
      expect(WeeklyHours.fromJson(data('setup_staff_schedule_set')).workingOn(1).single, const HoursWindow(1, '10:00', '17:00'));
      expect(WeeklyHours.fromJson(data('setup_staff_schedule')).validate(), isEmpty);
    });

    test('time off and walk-in blocks: the dates are the location\'s, the block is an instant', () {
      expect(items('setup_location_exceptions').map(ScheduleException.fromJson).toList(), isA<List<ScheduleException>>());
      final opening = ScheduleException.fromJson(data('setup_staff_exception_created'));
      expect(opening.kind, 'OPEN');
      expect(opening.isClosed, isFalse);
      expect(opening.wholeDay, isFalse);
      expect(opening.start, '10:00');
      expect(opening.end, '14:00');
      final closed = ScheduleException.fromJson(data('setup_location_exception_created'));
      expect(closed.isClosed, isTrue);
      expect(closed.wholeDay, isTrue);
      expect(closed.reason, 'Fixture holiday');
      final block = StaffBlock.fromJson(data('setup_block_created'));
      expect(block.endAt.difference(block.startAt), const Duration(hours: 1));
      expect(block.startAt.isUtc, isTrue);
      expect(items('setup_staff_blocks').map(StaffBlock.fromJson).toList(), isA<List<StaffBlock>>());
      // The wire format the draft produces is the same shape the server echoed.
      final echoed = BlockDraft(startAt: block.startAt, endAt: block.endAt, reason: 'Fixture walk-in').toJson();
      expect(echoed['start_at'], data('setup_block_created')['start_at']);
      expect(echoed['end_at'], data('setup_block_created')['end_at']);
    });

    test('booking rules: the server returns the EFFECTIVE values under `effective`', () {
      final p = BookingPolicy.fromJson(data('setup_booking_policy').cast<String, dynamic>()['effective'] as Map<String, dynamic>);
      expect(p.validate(), isEmpty);
      expect(p.slotGranularityMin, anyOf(BookingPolicy.granularities));
      final set = BookingPolicy.fromJson(data('setup_booking_policy_set')['effective'] as Map<String, dynamic>);
      expect(set.responseDeadlineMin, 120);
      expect(set.minLeadTimeMin, 60);
    });
  });
}
