import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';

http.Response _json(int status, Object? body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

class _Seen {
  _Seen(this.method, this.path, this.body, this.headers, this.query);
  final String method;
  final String path;
  final Map<String, dynamic>? body;
  final Map<String, String> headers;
  final Map<String, String> query;
}

/// A repository over a fake API; every request is recorded so the tests can assert the EXACT wire format.
({ProviderSetupRepository repo, List<_Seen> seen}) _repo(Future<http.Response> Function(http.Request r) handler) {
  final seen = <_Seen>[];
  final session = SessionManager(MemoryTokenStore(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'u')));
  final client = MockClient((r) async {
    seen.add(
      _Seen(
        r.method,
        r.url.path.replaceFirst('/api/v1', ''),
        r.body.isEmpty ? null : jsonDecode(r.body) as Map<String, dynamic>,
        r.headers,
        r.url.queryParameters,
      ),
    );
    return handler(r);
  });
  return (repo: ProviderSetupRepository(ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: client)), seen: seen);
}

const _loc = {
  'id': 'l1',
  'provider_id': 'p1',
  'name': 'Salon',
  'address_line1': '12 Test Road',
  'address_line2': null,
  'city': 'Pune',
  'state': 'Maharashtra',
  'postal_code': '411045',
  'country': 'IN',
  'latitude': 18.559,
  'longitude': 73.7868,
  'timezone': 'Asia/Kolkata',
  'status': 'ACTIVE',
};

OwnedLocation _location() => OwnedLocation.fromJson(_loc);

LocationDraft _validLocation() => const LocationDraft(
  name: 'Salon',
  addressLine1: '12 Test Road',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411045',
  latitude: 18.559,
  longitude: 73.7868,
);

void main() {
  group('money input: rupees typed by a person -> integer paise, never floating point', () {
    test('whole rupees, paise, grouping and a rupee sign', () {
      expect(MoneyInput.parseRupees('200'), 20000);
      expect(MoneyInput.parseRupees('249.5'), 24950);
      expect(MoneyInput.parseRupees('249.50'), 24950);
      expect(MoneyInput.parseRupees('1,250.05'), 125005);
      expect(MoneyInput.parseRupees('₹99.99'), 9999);
      expect(MoneyInput.parseRupees(' 0 '), 0);
    });

    test('amounts that floating point gets wrong are exact', () {
      // 0.29 * 100 == 28.999999999999996 and 1.15 * 100 == 114.99999999999999 in IEEE-754.
      expect(MoneyInput.parseRupees('0.29'), 29);
      expect(MoneyInput.parseRupees('1.15'), 115);
      expect(MoneyInput.parseRupees('19.99'), 1999);
      expect(MoneyInput.parseRupees('4.35'), 435);
    });

    test('anything that is not a plain non-negative amount with at most two decimals is rejected, not guessed at', () {
      for (final bad in ['', ' ', 'abc', '-5', '12.345', '1e3', '.5', '5.', '1.2.3', '12 34', '₹', '₹₹5', '1000000000']) {
        expect(MoneyInput.parseRupees(bad), isNull, reason: '"$bad"');
      }
    });

    test('paise -> the text put back into the field, and the round trip is lossless', () {
      expect(MoneyInput.toRupeesText(20000), '200');
      expect(MoneyInput.toRupeesText(24950), '249.50');
      expect(MoneyInput.toRupeesText(5), '0.05');
      expect(MoneyInput.toRupeesText(0), '0');
      for (final minor in [0, 1, 5, 99, 100, 101, 25050, 99999999, 100000000]) {
        expect(MoneyInput.parseRupees(MoneyInput.toRupeesText(minor)), minor);
      }
    });
  });

  group('time zones: the LOCATION\'s clock, never the phone\'s', () {
    test('a wall-clock time at the salon becomes the right instant', () {
      expect(instantAt('Asia/Kolkata', '2026-10-10', '09:00'), DateTime.utc(2026, 10, 10, 3, 30));
      // New York is UTC-4 in October (DST) and UTC-5 after the change: the zone's rules apply, not the machine's.
      expect(instantAt('America/New_York', '2026-10-10', '09:00'), DateTime.utc(2026, 10, 10, 13));
      expect(instantAt('America/New_York', '2026-11-10', '09:00'), DateTime.utc(2026, 11, 10, 14));
    });

    test('an instant is read back as the salon\'s wall-clock', () {
      final p = localParts('Asia/Kolkata', DateTime.utc(2026, 10, 10, 20, 15));
      expect(p.date, '2026-10-11', reason: 'past midnight in India already');
      expect(p.time, '01:45');
    });

    test('"today" depends on the zone', () {
      final now = DateTime.utc(2026, 10, 10, 20, 15);
      expect(todayIn('Asia/Kolkata', now: now), '2026-10-11');
      expect(todayIn('America/New_York', now: now), '2026-10-10');
    });

    test('only real zone names are valid', () {
      expect(isValidTimeZone('Asia/Kolkata'), isTrue);
      for (final bad in ['IST', 'Mars/Olympus', '', 'asia/nowhere']) {
        expect(isValidTimeZone(bad), isFalse, reason: bad);
      }
    });
  });

  group('AttemptKey (idempotency)', () {
    test('a retry of the same request re-sends the SAME key; a changed request gets a new one', () {
      var n = 0;
      final key = AttemptKey(generate: () => 'key-${++n}');
      expect(key.keyFor({'name': 'A'}), 'key-1');
      expect(key.keyFor({'name': 'A'}), 'key-1', reason: 'a retry after a lost connection');
      expect(key.keyFor({'name': 'B'}), 'key-2', reason: 'the person changed the form');
      key.reset();
      expect(key.keyFor({'name': 'B'}), 'key-3', reason: 'after a confirmed success the next create is a new intent');
    });
  });

  group('location form', () {
    test('a valid draft builds exactly the body the server accepts', () {
      expect(_validLocation().validate(), isEmpty);
      expect(_validLocation().toCreateJson(), {
        'name': 'Salon',
        'address_line1': '12 Test Road',
        'city': 'Pune',
        'state': 'Maharashtra',
        'postal_code': '411045',
        'country': 'IN',
        'latitude': 18.559,
        'longitude': 73.7868,
        'timezone': 'Asia/Kolkata',
      });
    });

    test('problems are keyed by the SERVER\'s field names', () {
      final p = const LocationDraft(postalCode: '!!', latitude: 200, timezone: 'IST').validate();
      expect(p.keys, containsAll(['name', 'address_line1', 'city', 'state', 'postal_code', 'latitude', 'longitude', 'timezone']));
    });

    test('a GPS fix is rounded to the 7 decimals the server accepts (it rejects more)', () {
      final d = _validLocation().copyWith(latitude: 18.55904321987654, longitude: 73.78681234567891);
      final json = d.toCreateJson();
      expect(json['latitude'], 18.559043);
      expect(json['longitude'], 73.786812);
      expect('${json['latitude']}'.split('.').last.length, lessThanOrEqualTo(7));
    });

    test('typed coordinates accept a comma and reject junk', () {
      expect(LocationDraft.parseCoordinate('18,5204'), 18.5204);
      expect(LocationDraft.parseCoordinate(' 73.8567 '), 73.8567);
      expect(LocationDraft.parseCoordinate('abc'), isNull);
      expect(LocationDraft.parseCoordinate('NaN'), isNull);
    });

    test('an edit sends only what changed, and coordinates always travel together', () {
      final o = _location();
      expect(LocationDraft.from(o).changesFrom(o), isEmpty);
      expect(LocationDraft.from(o).copyWith(addressLine2: 'Near the park').changesFrom(o), {'address_line2': 'Near the park'});
      expect(LocationDraft.from(o).copyWith(latitude: 18.6).changesFrom(o), {'latitude': 18.6, 'longitude': 73.7868});
      expect(LocationDraft.from(o).copyWith(name: ' New name ').changesFrom(o), {'name': 'New name'});
    });
  });

  group('service form', () {
    const draft = ServiceDraft(serviceTypeId: 'st1', name: ' Haircut ', priceRupees: '250.50', durationMin: 30, bufferMin: 5);

    test('rupees become integer paise in the request body (and nothing else the server owns is sent)', () {
      expect(draft.validate(creating: true), isEmpty);
      expect(draft.toCreateJson(), {
        'service_type_id': 'st1',
        'name': 'Haircut',
        'price_minor': 25050,
        'currency': 'INR',
        'duration_min': 30,
        'buffer_min': 5,
      });
    });

    test('validation mirrors the server: price, duration (5..1440) and buffer (0..240)', () {
      expect(draft.copyWith(priceRupees: '').validate(creating: true)['price_minor'], isNotNull);
      expect(draft.copyWith(priceRupees: '12.345').validate(creating: true)['price_minor'], isNotNull);
      expect(draft.copyWith(priceRupees: '1000001').validate(creating: true)['price_minor'], contains('10,00,000'));
      expect(draft.copyWith(priceRupees: '1000000').validate(creating: true), isEmpty);
      expect(draft.copyWith(durationMin: 4).validate(creating: true).keys, ['duration_min']);
      expect(draft.copyWith(durationMin: 1441).validate(creating: true).keys, ['duration_min']);
      expect(draft.copyWith(bufferMin: 241).validate(creating: true).keys, ['buffer_min']);
      expect(const ServiceDraft().validate(creating: true).keys, containsAll(['service_type_id', 'name', 'price_minor', 'duration_min']));
      expect(const ServiceDraft().validate(creating: false).keys, isNot(contains('service_type_id')));
    });

    test('an edit sends only the changed fields: a new price is sent as paise, deactivating sends is_active', () {
      final o = OwnedService.fromJson({
        'id': 's1',
        'provider_id': 'p1',
        'service_type_id': 'st1',
        'name': 'Haircut',
        'description': null,
        'price': {'amount_minor': 25050, 'currency': 'INR'},
        'duration_min': 30,
        'buffer_min': 5,
        'is_active': true,
        'attributes': {},
        'version': 1,
      });
      expect(ServiceDraft.from(o).changesFrom(o), isEmpty);
      expect(ServiceDraft.from(o).priceRupees, '250.50');
      expect(ServiceDraft.from(o).copyWith(priceRupees: '275').changesFrom(o), {'price_minor': 27500});
      expect(ServiceDraft.from(o).copyWith(isActive: false).changesFrom(o), {'is_active': false});
    });
  });

  group('staff form', () {
    test('an invitation needs a valid 10-digit mobile; no phone means a stylist without a login', () {
      const base = StaffDraft(locationId: 'l1', displayName: 'Asha');
      expect(base.validate(), isEmpty);
      expect(base.toCreateJson(), {'location_id': 'l1', 'display_name': 'Asha', 'staff_role': 'STAFF'});
      expect(const StaffDraft(locationId: 'l1', displayName: 'A', phone: '12345').validate().keys, ['phone']);
      expect(const StaffDraft(locationId: 'l1', displayName: 'A', phone: '5000000000').validate().keys, ['phone']);
      const invited = StaffDraft(locationId: 'l1', displayName: 'A', role: StaffRole.manager, phone: '9000000096');
      expect(invited.validate(), isEmpty);
      expect(invited.toCreateJson(), {'location_id': 'l1', 'display_name': 'A', 'staff_role': 'MANAGER', 'phone': '9000000096'});
      expect(const StaffDraft().validate().keys, containsAll(['location_id', 'display_name']));
    });
  });

  group('weekly hours', () {
    test('a template, then editing a day, copying it, closing it', () {
      var h = WeeklyHours.uniform(weekdays: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00');
      expect(h.isOpenOn(7), isFalse);
      expect(h.workingOn(3).single, const HoursWindow(3, '09:00', '19:00'));
      h = h.add(const HoursWindow(1, '13:00', '14:00'), isBreak: true);
      h = h.copyDay(1, [2, 7]);
      expect(h.breaksOn(2).single, const HoursWindow(2, '13:00', '14:00'));
      expect(h.isOpenOn(7), isTrue);
      h = h.closeDay(2);
      expect(h.isOpenOn(2), isFalse);
      expect(h.breaksOn(2), isEmpty, reason: 'closing a day also drops its breaks');
      expect(h.validate(), isEmpty);
    });

    test('overlapping or inverted windows are explained before saving', () {
      final overlap = WeeklyHours(working: [const HoursWindow(1, '09:00', '12:00'), const HoursWindow(1, '11:00', '13:00')]);
      expect(overlap.validate()['working'], contains('overlap'));
      expect(WeeklyHours(working: [const HoursWindow(1, '12:00', '09:00')]).validate()['working'], contains('end after'));
      // Two windows on one day that merely touch are fine, and so is closing at midnight.
      expect(WeeklyHours(working: [const HoursWindow(1, '09:00', '12:00'), const HoursWindow(1, '12:00', '24:00')]).validate(), isEmpty);
    });

    test('the request body is the server\'s shape, with 24:00 allowed as an end', () {
      final h = WeeklyHours(working: [const HoursWindow(7, '10:00', '24:00')], breaks: [const HoursWindow(7, '13:00', '14:00')]);
      expect(h.toJson(), {
        'working': [
          {'weekday': 7, 'start': '10:00', 'end': '24:00'},
        ],
        'breaks': [
          {'weekday': 7, 'start': '13:00', 'end': '14:00'},
        ],
      });
      expect(HoursWindow.minutesOf('24:00'), 1440);
      expect(HoursWindow.hhmmOf(570), '09:30');
      expect(HoursWindow.hhmmOf(1440), '24:00');
    });
  });

  group('time off and walk-in blocks', () {
    test('a closed day, a multi-day leave and a special opening are built the way the server validates them', () {
      expect(const ExceptionDraft(startDate: '2026-10-12').validate(), isEmpty);
      expect(const ExceptionDraft(startDate: '2026-10-12').toJson(), {'kind': 'CLOSED', 'start_date': '2026-10-12'});
      expect(const ExceptionDraft(startDate: '2026-10-12', endDate: '2026-10-14', reason: ' Diwali ').toJson(), {
        'kind': 'CLOSED',
        'start_date': '2026-10-12',
        'end_date': '2026-10-14',
        'reason': 'Diwali',
      });
      expect(const ExceptionDraft(kind: 'OPEN', startDate: '2026-10-12', start: '10:00', end: '14:00').validate(), isEmpty);
    });

    test('bad input is refused locally with the server\'s field names', () {
      expect(const ExceptionDraft().validate().keys, ['start_date']);
      expect(const ExceptionDraft(startDate: '2026-02-30').validate().keys, ['start_date'], reason: 'not a real date');
      expect(const ExceptionDraft(startDate: '2026-10-12', endDate: '2026-10-11').validate().keys, ['end_date']);
      expect(const ExceptionDraft(startDate: '2026-10-12', start: '10:00').validate().keys, ['start']);
      expect(const ExceptionDraft(startDate: '2026-10-12', start: '14:00', end: '10:00').validate().keys, ['end']);
      expect(const ExceptionDraft(kind: 'OPEN', startDate: '2026-10-12').validate().keys, ['start']);
    });

    test('a block typed in the salon\'s clock is sent as the right UTC instants', () {
      final b = BlockDraft.local(zone: 'Asia/Kolkata', date: '2026-10-10', start: '09:00', end: '10:30', reason: 'Walk-in');
      expect(b.validate(), isEmpty);
      expect(b.toJson(), {'start_at': '2026-10-10T03:30:00.000Z', 'end_at': '2026-10-10T05:00:00.000Z', 'reason': 'Walk-in'});
    });

    test('a walk-in starts now (to the whole minute, which the server insists on) and lasts as long as asked', () {
      final w = BlockDraft.walkIn(now: DateTime.utc(2026, 10, 10, 7, 44, 31, 912), minutes: 45);
      expect(w.toJson()['start_at'], '2026-10-10T07:44:00.000Z');
      expect(w.toJson()['end_at'], '2026-10-10T08:29:00.000Z');
    });

    test('an empty, inverted or longer-than-a-day block is refused', () {
      final t = DateTime.utc(2026, 10, 10, 10);
      expect(BlockDraft(startAt: t, endAt: t).validate().keys, ['end_at']);
      expect(BlockDraft(startAt: t, endAt: t.add(const Duration(hours: 25))).validate().keys, ['end_at']);
      expect(BlockDraft(startAt: t, endAt: t.add(const Duration(hours: 24))).validate(), isEmpty);
    });
  });

  group('booking rules', () {
    const policy = BookingPolicy(
      slotGranularityMin: 15,
      minLeadTimeMin: 60,
      maxAdvanceDays: 30,
      responseDeadlineMin: 30,
      checkInWindowMin: 30,
      noShowGraceMin: 15,
      settlementHoldHours: 24,
    );

    test('ranges mirror the server\'s', () {
      expect(policy.validate(), isEmpty);
      expect(policy.copyWith(slotGranularityMin: 25).validate().keys, ['slot_granularity_min']);
      expect(policy.copyWith(responseDeadlineMin: 4).validate().keys, ['response_deadline_min']);
      expect(policy.copyWith(maxAdvanceDays: 0).validate().keys, ['max_advance_days']);
      expect(policy.copyWith(settlementHoldHours: 169).validate().keys, ['settlement_hold_hours']);
    });

    test('a save sends EVERY field (the server replaces the overrides; a missing field would silently revert to the default)', () {
      expect(policy.toJson().keys, hasLength(7));
      expect(policy.copyWith(minLeadTimeMin: 90).toJson()['min_lead_time_min'], 90);
    });
  });

  group('onboarding checklist', () {
    ProviderAccount business(String status) => ProviderAccount(id: 'p1', displayName: 'ABC', status: status);
    OwnedLocation location({String status = 'ACTIVE'}) => OwnedLocation.fromJson({..._loc, 'status': status});
    OwnedService service({bool active = true}) => OwnedService(
      id: 's1',
      providerId: 'p1',
      serviceTypeId: 'st',
      name: 'Cut',
      price: const Money(10000),
      durationMin: 30,
      bufferMin: 0,
      isActive: active,
    );
    OwnedStaff staff({String status = 'ACTIVE'}) =>
        OwnedStaff(id: 'x', providerId: 'p1', locationId: 'l1', displayName: 'A', staffRole: 'STAFF', status: status, hasLogin: false);

    OnboardingChecklist compute({
      ProviderAccount? b,
      List<OwnedLocation> locations = const [],
      List<OwnedService> services = const [],
      List<OwnedStaff> staffList = const [],
      bool hours = false,
    }) => OnboardingChecklist.compute(business: b, locations: locations, services: services, staff: staffList, hasHours: hours);

    test('a brand-new owner starts at "register", and the steps come in the order that makes sense', () {
      final c = compute();
      expect(c.steps.map((s) => s.id), OnboardingStepId.values);
      expect(c.next!.id, OnboardingStepId.business);
      expect(c.doneCount, 0);
    });

    test('each completed step moves the next one along: location -> service -> hours -> staff -> submit', () {
      var c = compute(b: business('DRAFT'));
      expect(c.next!.id, OnboardingStepId.location);
      c = compute(b: business('DRAFT'), locations: [location()]);
      expect(c.next!.id, OnboardingStepId.service);
      c = compute(b: business('DRAFT'), locations: [location()], services: [service()]);
      expect(c.next!.id, OnboardingStepId.hours);
      c = compute(b: business('DRAFT'), locations: [location()], services: [service()], hours: true);
      expect(c.next!.id, OnboardingStepId.staff);
      c = compute(b: business('DRAFT'), locations: [location()], services: [service()], hours: true, staffList: [staff()]);
      expect(c.next!.id, OnboardingStepId.submit);
      expect(c.readyToSubmit, isTrue);
      expect(c.isComplete, isFalse);
    });

    test('submitting is offered only when everything before it is done', () {
      final c = compute(b: business('DRAFT'), locations: [location()], services: [service()]);
      expect(c.readyToSubmit, isFalse);
      expect(c.canStart(OnboardingStepId.submit), isFalse);
      expect(c.canStart(OnboardingStepId.staff), isTrue, reason: 'other steps stay reachable in any order');
    });

    test('inactive things do not count; an invited stylist does', () {
      final c = compute(
        b: business('DRAFT'),
        locations: [location(status: 'INACTIVE')],
        services: [service(active: false)],
        staffList: [staff(status: 'INACTIVE')],
      );
      expect(c.step(OnboardingStepId.location).done, isFalse);
      expect(c.step(OnboardingStepId.service).done, isFalse);
      expect(c.step(OnboardingStepId.staff).done, isFalse);
      expect(
        compute(
          b: business('DRAFT'),
          staffList: [staff(status: 'INVITED')],
        ).step(OnboardingStepId.staff).done,
        isTrue,
      );
    });

    test('once submitted (or approved) the submit step is done; a rejected business can submit again', () {
      for (final s in ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SUSPENDED']) {
        expect(compute(b: business(s)).step(OnboardingStepId.submit).done, isTrue, reason: s);
      }
      expect(compute(b: business('REJECTED')).step(OnboardingStepId.submit).done, isFalse);
      final all = compute(b: business('APPROVED'), locations: [location()], services: [service()], hours: true, staffList: [staff()]);
      expect(all.isComplete, isTrue);
      expect(all.next, isNull);
    });
  });

  group('ProviderSetupRepository (requests exactly as the server expects)', () {
    test('registering sends the name and description with an Idempotency-Key, and parses the DRAFT business', () async {
      final f = _repo(
        (_) async => _json(201, {
          'data': {
            'id': 'p1',
            'display_name': 'My Salon',
            'description': 'Hair',
            'status': 'DRAFT',
            'submitted_at': null,
            'decided_at': null,
            'decision_reason': null,
            'version': 1,
            'created_at': '2026-10-07T07:00:00.000Z',
          },
        }),
      );
      final b = await f.repo.register(displayName: ' My Salon ', description: ' Hair ', idempotencyKey: 'key-12345678');
      expect(f.seen.single.method, 'POST');
      expect(f.seen.single.path, '/providers');
      expect(f.seen.single.body, {'display_name': 'My Salon', 'description': 'Hair'});
      expect(f.seen.single.headers['Idempotency-Key'], 'key-12345678');
      expect(b.status, 'DRAFT');
      expect(b.canSubmit, isTrue);
      expect(b.canEdit, isTrue);
    });

    test('a blank description is not sent on registration, and clears the description on edit', () async {
      final f = _repo(
        (_) async => _json(200, {
          'data': {'id': 'p1', 'display_name': 'My Salon', 'description': null, 'status': 'DRAFT'},
        }),
      );
      await f.repo.register(displayName: 'My Salon', description: '  ', idempotencyKey: 'key-12345678');
      expect(f.seen.last.body, {'display_name': 'My Salon'});
      await f.repo.updateProfile('p1', displayName: 'New', description: '');
      expect(f.seen.last.method, 'PATCH');
      expect(f.seen.last.path, '/providers/p1');
      expect(f.seen.last.body, {'display_name': 'New', 'description': null});
    });

    test('submit is a command with no body, never a status update', () async {
      final f = _repo(
        (_) async => _json(200, {
          'data': {'id': 'p1', 'display_name': 'S', 'status': 'SUBMITTED'},
        }),
      );
      final b = await f.repo.submit('p1');
      expect(f.seen.single.method, 'POST');
      expect(f.seen.single.path, '/providers/p1/submit');
      expect(f.seen.single.body, isNull);
      expect(b.isInReview, isTrue);
    });

    test('the server\'s refusal reaches the caller with its code and per-field messages', () async {
      final f = _repo(
        (_) async => _json(422, {
          'title': 'ValidationFailedError',
          'status': 422,
          'code': 'VALIDATION_FAILED',
          'detail': 'Request validation failed',
          'errors': {
            'fields': {
              'postal_code': ['postal_code is invalid'],
              'name': ['name must be longer than or equal to 1 characters'],
            },
          },
        }),
      );
      try {
        await f.repo.createLocation('p1', _validLocation(), idempotencyKey: 'key-12345678');
        fail('should have thrown');
      } on ApiException catch (e) {
        expect(e.code, 'VALIDATION_FAILED');
        expect(e.isValidation, isTrue);
        expect(e.fields['postal_code'], ['postal_code is invalid']);
        expect(e.fields.keys, containsAll(['name', 'postal_code']));
      }
    });

    test('services, staff, skills, hours, time off, blocks and rules go to the right endpoints with the right bodies', () async {
      final f = _repo((r) async {
        if (r.method == 'DELETE') return http.Response('', 204);
        final path = r.url.path;
        if (path.endsWith('/hours') || path.endsWith('/schedule')) {
          return _json(200, {
            'data': {'working': <Object>[], 'breaks': <Object>[]},
          });
        }
        if (path.endsWith('/booking-policy')) {
          return _json(200, {
            'data': {
              'effective': {
                'slot_granularity_min': 15,
                'min_lead_time_min': 60,
                'max_advance_days': 30,
                'response_deadline_min': 30,
                'check_in_window_min': 30,
                'no_show_grace_min': 15,
                'settlement_hold_hours': 24,
              },
            },
          });
        }
        if (path.endsWith('/services') && r.method == 'PUT') {
          return _json(200, {
            'data': {
              'staff_id': 'x',
              'restricted': true,
              'service_ids': ['s1'],
            },
          });
        }
        if (path.endsWith('/blocks')) {
          return _json(201, {
            'data': {'id': 'b1', 'start_at': '2026-10-10T03:30:00.000Z', 'end_at': '2026-10-10T04:30:00.000Z', 'reason': null},
          });
        }
        if (path.endsWith('/exceptions')) {
          return _json(201, {
            'data': {
              'id': 'e1',
              'kind': 'CLOSED',
              'start_date': '2026-10-12',
              'end_date': '2026-10-12',
              'start': null,
              'end': null,
              'reason': null,
            },
          });
        }
        return _json(200, {'data': <Object>[]});
      });
      final r = f.repo;
      await r.serviceTypes('salon');
      expect(f.seen.last.path, '/categories/salon/service-types');
      await r.staff('p1', locationId: 'l1');
      expect(f.seen.last.query, {'location_id': 'l1'});
      await r.setStaffSkills('p1', 'x', ['s1']);
      expect(f.seen.last.method, 'PUT');
      expect(f.seen.last.path, '/providers/p1/staff/x/services');
      expect(f.seen.last.body, {
        'service_ids': ['s1'],
      });
      await r.setLocationHours('p1', 'l1', WeeklyHours.uniform(weekdays: [1], start: '09:00', end: '18:00'));
      expect(f.seen.last.path, '/providers/p1/locations/l1/hours');
      expect(f.seen.last.body!['working'], [
        {'weekday': 1, 'start': '09:00', 'end': '18:00'},
      ]);
      await r.setStaffSchedule('p1', 'x', const WeeklyHours());
      expect(f.seen.last.path, '/providers/p1/staff/x/schedule');
      await r.addLocationException('p1', 'l1', const ExceptionDraft(startDate: '2026-10-12'), idempotencyKey: 'key-12345678');
      expect(f.seen.last.path, '/providers/p1/locations/l1/exceptions');
      expect(f.seen.last.headers['Idempotency-Key'], 'key-12345678');
      await r.addStaffException('p1', 'x', const ExceptionDraft(startDate: '2026-10-12'), idempotencyKey: 'key-12345678');
      expect(f.seen.last.path, '/providers/p1/staff/x/exceptions');
      final block = await r.addBlock(
        'p1',
        'x',
        BlockDraft.local(zone: 'Asia/Kolkata', date: '2026-10-10', start: '09:00', end: '10:00'),
        idempotencyKey: 'key-12345678',
      );
      expect(f.seen.last.body, {'start_at': '2026-10-10T03:30:00.000Z', 'end_at': '2026-10-10T04:30:00.000Z'});
      expect(block.startAt, DateTime.utc(2026, 10, 10, 3, 30));
      await r.releaseBlock('p1', 'x', 'b1');
      expect(f.seen.last.method, 'DELETE');
      await r.deleteLocation('p1', 'l1');
      await r.deleteService('p1', 's1');
      await r.deleteStaff('p1', 'x');
      expect(f.seen.last.path, '/providers/p1/staff/x');
      final policy = await r.policy('p1');
      expect(policy.responseDeadlineMin, 30);
      await r.setPolicy('p1', policy.copyWith(minLeadTimeMin: 90));
      expect(f.seen.last.method, 'PUT');
      expect(f.seen.last.body!['min_lead_time_min'], 90);
      expect(f.seen.last.body!.keys, hasLength(7));
      await r.resetPolicy('p1');
      expect(f.seen.last.body, isEmpty, reason: 'an empty replacement removes every override');
    });

    test('invitations: list, accept, decline (a 204 with no body is fine)', () async {
      final f = _repo((r) async {
        if (r.url.path.endsWith('/decline')) return http.Response('', 204);
        if (r.url.path.endsWith('/accept')) {
          return _json(200, {
            'data': {'id': 'i1', 'provider_id': 'p1', 'location_id': 'l1', 'staff_role': 'STAFF'},
          });
        }
        return _json(200, {
          'data': [
            {
              'id': 'i1',
              'provider_name': 'ABC',
              'location_name': 'Main',
              'staff_role': 'STAFF',
              'invited_as': 'Asha',
              'invited_at': '2026-10-07T07:00:00.000Z',
            },
          ],
        });
      });
      final list = await f.repo.myInvitations();
      expect(list.single.providerName, 'ABC');
      expect(list.single.roleLabel, 'Stylist');
      final accepted = await f.repo.acceptInvitation('i1');
      expect(accepted.providerId, 'p1');
      expect(f.seen.last.path, '/users/me/staff-invitations/i1/accept');
      await f.repo.declineInvitation('i1');
      expect(f.seen.last.path, '/users/me/staff-invitations/i1/decline');
    });

    test('a malformed response is a bad-response error, not a crash', () async {
      final f = _repo(
        (_) async => _json(200, {
          'data': [
            {'id': 'l1'},
          ],
        }),
      );
      expect(() => f.repo.locations('p1'), throwsA(isA<ApiException>().having((e) => e.code, 'code', ApiException.badResponseCode)));
    });
  });
}
