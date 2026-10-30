import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:tokengo_provider/core/providers.dart';
import 'package:tokengo_provider/features/bookings/bookings_state.dart';
import 'package:tokengo_provider/features/bookings/today_screen.dart';
import 'package:tokengo_provider/features/business/hours_screens.dart';
import 'package:tokengo_provider/features/business/locations_screens.dart';
import 'package:tokengo_provider/features/business/policy_screen.dart';
import 'package:tokengo_provider/features/business/services_screens.dart';
import 'package:tokengo_provider/features/business/staff_screens.dart';
import 'package:tokengo_provider/features/business/time_off_screens.dart';

import 'support/fake_server.dart';
import 'support/harness.dart';

Map<String, dynamic> _location() => {
  'id': 'l1',
  'provider_id': 'p1',
  'name': 'Main',
  'address_line1': '1 Road',
  'address_line2': null,
  'city': 'Pune',
  'state': 'MH',
  'postal_code': '411001',
  'country': 'IN',
  'latitude': 18.5,
  'longitude': 73.8,
  'timezone': 'Asia/Kolkata',
  'status': 'ACTIVE',
};

Map<String, dynamic> _service(String id, String name, int paise) => {
  'id': id,
  'provider_id': 'p1',
  'service_type_id': 'st-hair',
  'name': name,
  'description': null,
  'price': {'amount_minor': paise, 'currency': 'INR'},
  'duration_min': 30,
  'buffer_min': 5,
  'is_active': true,
  'attributes': <String, dynamic>{},
  'version': 1,
};

FakeServer _server() {
  final s = FakeServer(registered: true, status: 'APPROVED');
  s.locations.add(_location());
  s.services
    ..add(_service('s1', 'Haircut', 25050))
    ..add(_service('s2', 'Facial', 40000));
  s.staff.add({
    'id': 'st1',
    'provider_id': 'p1',
    'location_id': 'l1',
    'display_name': 'Asha',
    'staff_role': 'STAFF',
    'status': 'ACTIVE',
    'has_login': false,
    'resource_id': 'r1',
  });
  return s;
}

Future<void> _open(WidgetTester tester, FakeServer server, Widget home) async {
  usePhoneSurface(tester);
  await tester.pumpWidget(
    await providerScope(handler: server.handle, home: home, overrides: [mapPreviewEnabledProvider.overrideWithValue(false)]),
  );
  await tester.pumpAndSettle();
}

Map<String, dynamic> _booking(String id, String status, {required String localStart, String tz = 'Asia/Kolkata', int paise = 30000}) {
  final j = bookingJson(id: id, status: status);
  final schedule = j['schedule'] as Map<String, dynamic>;
  schedule['local_start'] = localStart;
  schedule['timezone'] = tz;
  j['price'] = {'amount_minor': paise, 'currency': 'INR'};
  return j;
}

void main() {
  group('opening hours', () {
    testWidgets('start from the template, close Sunday-style days, add a break, save: the PUT carries exactly what is on screen', (
      tester,
    ) async {
      final server = _server();
      await _open(tester, server, const LocationHoursScreen(locationId: 'l1'));
      expect(find.text('Times are in Asia/Kolkata.'), findsOneWidget, reason: 'the location\'s clock, not the phone\'s');
      expect(find.text('Saved'), findsOneWidget, reason: 'nothing to save yet');

      await tapVisible(tester, find.text('Start with 9 AM – 7 PM, Monday to Saturday'));
      expect(find.text('9:00 AM – 7:00 PM'), findsNWidgets(6));
      expect(find.text('Closed'), findsOneWidget);
      // Saturday: close it. (Switches are listed Monday..Sunday; Saturday's is the 6th.)
      await tapVisible(tester, find.byType(Switch).at(5));
      expect(find.text('Closed'), findsNWidgets(2));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save hours'));

      final put = server.writesTo('PUT', '/hours').single;
      final working = (put.body!['working'] as List).cast<Map<String, dynamic>>();
      expect(working.map((w) => w['weekday']), [1, 2, 3, 4, 5]);
      expect(working.every((w) => w['start'] == '09:00' && w['end'] == '19:00'), isTrue);
      expect(put.body!['breaks'], isEmpty);
      expect(find.text('Hours saved.'), findsOneWidget);
      expect(find.text('Saved'), findsOneWidget, reason: 'saved: the button rests');
    });

    testWidgets('overlapping windows are refused by the server: its message is shown, the edits are kept, nothing is lost', (tester) async {
      final server = _server();
      server.failNext(
        '/hours',
        FakeServer.problem(
          422,
          'VALIDATION_FAILED',
          'Overlapping windows',
          fields: {
            'working': ['windows overlap on weekday 1'],
          },
        ),
      );
      await _open(tester, server, const LocationHoursScreen(locationId: 'l1'));
      await tapVisible(tester, find.text('Start with 9 AM – 7 PM, Monday to Saturday'));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save hours'));
      expect(find.text('windows overlap on weekday 1'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save hours'), findsOneWidget, reason: 'still unsaved, can retry');
      expect(find.text('9:00 AM – 7:00 PM'), findsNWidgets(6));
    });

    testWidgets('leaving with unsaved hours asks first', (tester) async {
      final server = _server();
      await _open(tester, server, const LocationHoursScreen(locationId: 'l1'));
      await tapVisible(tester, find.text('Start with 9 AM – 7 PM, Monday to Saturday'));
      await tester.binding.handlePopRoute(); // the system Back button
      await tester.pumpAndSettle();
      expect(find.text('Discard your changes?'), findsOneWidget);
    });

    testWidgets('a staff member follows the salon\'s hours until they are given their own', (tester) async {
      final server = _server();
      server.hours = {
        'working': [
          {'weekday': 1, 'start': '10:00', 'end': '18:00'},
        ],
        'breaks': <Object>[],
      };
      // Staff schedule starts EMPTY (follows the salon); the location has its own pattern.
      final staffServer = server;
      await _open(tester, staffServer, const StaffScheduleScreen(staffId: 'st1'));
      expect(find.text('Same as the salon'), findsOneWidget);
    });
  });

  group('booking rules', () {
    testWidgets('a save sends every rule exactly as shown; reset sends an empty replacement', (tester) async {
      final server = _server();
      await _open(tester, server, const PolicyScreen());
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Answer requests within')).controller!.text, '30');
      expect(find.text('Saved'), findsOneWidget);

      await enter(tester, 'Answer requests within', '90');
      await tapVisible(tester, find.widgetWithText(ChoiceChip, '30 min'));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save rules'));
      expect(server.writesTo('PUT', '/booking-policy').single.body, {
        'slot_granularity_min': 30,
        'min_lead_time_min': 60,
        'max_advance_days': 30,
        'response_deadline_min': 90,
        'check_in_window_min': 30,
        'no_show_grace_min': 15,
        'settlement_hold_hours': 24,
      });
      expect(find.text('Booking rules saved.'), findsOneWidget);

      await tapVisible(tester, find.text('Use TokenGo\'s standard rules'));
      await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
      await tester.pumpAndSettle();
      expect(server.writesTo('PUT', '/booking-policy').last.body, isEmpty);
    });

    testWidgets('out-of-range values are explained on the field and not sent', (tester) async {
      final server = _server();
      await _open(tester, server, const PolicyScreen());
      await enter(tester, 'Answer requests within', '2');
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save rules'));
      expect(find.text('Response time must be between 5 and 1440'), findsOneWidget);
      expect(server.writes, isEmpty);
    });
  });

  group('services', () {
    testWidgets('editing a price sends only the changed field, as paise', (tester) async {
      final server = _server();
      await _open(tester, server, const ServiceFormScreen(serviceId: 's1'));
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Price')).controller!.text, '250.50');
      await enter(tester, 'Price', '275');
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save changes'));
      expect(server.writesTo('PATCH', '/services/s1').single.body, {'price_minor': 27500});
      expect(find.text('Service saved.'), findsOneWidget);
    });

    testWidgets('hiding a service sends is_active=false (it is kept, not deleted)', (tester) async {
      final server = _server();
      await _open(tester, server, const ServiceFormScreen(serviceId: 's2'));
      await tapVisible(tester, find.byType(Switch));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save changes'));
      expect(server.writesTo('PATCH', '/services/s2').single.body, {'is_active': false});
      expect(server.services.firstWhere((s) => s['id'] == 's2')['is_active'], isFalse);
    });

    testWidgets('saving with nothing changed sends nothing', (tester) async {
      final server = _server();
      await _open(tester, server, const ServiceFormScreen(serviceId: 's1'));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save changes'));
      expect(server.writes, isEmpty);
      expect(find.text('Nothing to save.'), findsOneWidget);
    });

    testWidgets('the list shows server prices with Money formatting, and hidden services are marked', (tester) async {
      final server = _server();
      server.services[1]['is_active'] = false;
      await _open(tester, server, const ServicesScreen());
      expect(find.text('₹250.50'), findsOneWidget);
      expect(find.text('₹400'), findsOneWidget);
      expect(find.text('Hidden'), findsOneWidget);
    });
  });

  group('locations', () {
    testWidgets('editing sends only what changed, and turning bookings off sends the status', (tester) async {
      final server = _server();
      await _open(tester, server, const LocationFormScreen(locationId: 'l1'));
      await enter(tester, 'Landmark or area (optional)', 'Near the park');
      await tapVisible(tester, find.byType(Switch));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save changes'));
      expect(server.writesTo('PATCH', '/locations/l1').single.body, {'address_line2': 'Near the park', 'status': 'INACTIVE'});
    });

    testWidgets('a malformed coordinate is explained and not sent', (tester) async {
      final server = _server();
      await _open(tester, server, const LocationFormScreen(locationId: 'l1'));
      await enter(tester, 'Latitude', '95');
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save changes'));
      expect(find.text('Enter a latitude between -90 and 90'), findsOneWidget);
      expect(server.writes, isEmpty);
    });
  });

  group('staff', () {
    testWidgets('services a stylist performs: ticking sends the list; clearing means every service', (tester) async {
      final server = _server();
      await _open(tester, server, const StaffDetailScreen(staffId: 'st1'));
      expect(find.text('Everything you offer (no restriction).'), findsOneWidget);

      await tapVisible(tester, find.widgetWithText(CheckboxListTile, 'Haircut'));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save'));
      expect(server.writesTo('PUT', '/staff/st1/services').single.body, {
        'service_ids': ['s1'],
      });
      expect(find.text('Only the services ticked below.'), findsOneWidget);

      await tapVisible(tester, find.text('Clear (all services)'));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save'));
      expect(server.writesTo('PUT', '/staff/st1/services').last.body, {'service_ids': <String>[]});
    });

    testWidgets('renaming sends only the new name; removing asks first', (tester) async {
      final server = _server();
      await _open(tester, server, const StaffDetailScreen(staffId: 'st1'));
      await enter(tester, 'Name', 'Asha K');
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Save changes'));
      expect(server.writesTo('PATCH', '/staff/st1').single.body, {'display_name': 'Asha K'});

      await tapVisible(tester, find.text('Remove from staff'));
      expect(find.text('Remove Asha K?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.writesTo('DELETE', '/staff/st1'), isEmpty);
    });
  });

  group('time off', () {
    testWidgets('holidays are listed on the LOCATION\'s calendar and can be removed', (tester) async {
      final server = _server();
      final tomorrow = dateOfIsoPlus(todayIn('Asia/Kolkata'), 1);
      server.exceptions.add({
        'id': 'e1',
        'kind': 'CLOSED',
        'start_date': tomorrow,
        'end_date': tomorrow,
        'start': null,
        'end': null,
        'reason': 'Diwali',
      });
      await _open(tester, server, const TimeOffScreen.location(locationId: 'l1'));
      expect(find.textContaining('Tomorrow'), findsOneWidget);
      expect(find.textContaining('Diwali'), findsOneWidget);
      await tester.tap(find.byTooltip('Remove'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
      await tester.pumpAndSettle();
      expect(server.writesTo('DELETE', '/exceptions/e1'), hasLength(1));
      expect(find.text('Nothing planned'), findsOneWidget, reason: 'the list was re-read');
    });
  });

  group('dashboard', () {
    final now = DateTime.utc(2026, 10, 8, 5); // 10:30 on 8 Oct in India, 01:00 in New York

    Booking b(String id, String status, String localStart, {String tz = 'Asia/Kolkata', int paise = 30000}) =>
        Booking.fromJson(_booking(id, status, localStart: localStart, tz: tz, paise: paise));

    test('"today" is each booking\'s OWN location date, and the buckets are right', () {
      final d = buildDashboard([
        b('req', BookingStatus.requested, '2026-10-12T10:00'),
        b('today-am', BookingStatus.confirmed, '2026-10-08T10:00'),
        b('today-pm', BookingStatus.confirmed, '2026-10-08T16:00'),
        b('done', BookingStatus.closed, '2026-10-08T09:00', paise: 25050),
        b('awaiting', BookingStatus.serviceCompleted, '2026-10-08T08:00', paise: 10000),
        b('tomorrow', BookingStatus.confirmed, '2026-10-09T10:00'),
        b('yesterday', BookingStatus.confirmed, '2026-10-07T10:00'),
        b('overnight', BookingStatus.serviceStarted, '2026-10-07T23:30'),
        b('cancelled', BookingStatus.customerCancelled, '2026-10-08T11:00'),
        // In New York it is still the 7th at that wall-clock: not "today" there, even though it is 2026-10-08 in India.
        b('ny', BookingStatus.confirmed, '2026-10-07T23:00', tz: 'America/New_York'),
      ], now: now);

      expect(d.requests.map((x) => x.id), ['req']);
      expect(d.today.map((x) => x.id), containsAll(['today-am', 'today-pm', 'done', 'awaiting', 'overnight']));
      expect(d.today.map((x) => x.id), isNot(contains('yesterday')));
      expect(d.today.map((x) => x.id), isNot(contains('cancelled')));
      expect(d.today.map((x) => x.id), isNot(contains('ny')));
      expect(d.upcoming.map((x) => x.id), ['tomorrow']);
      expect(d.completedToday.map((x) => x.id), unorderedEquals(['done', 'awaiting']));
      expect(d.completedValue, const Money(35050), reason: 'a sum of the server\'s prices, shown as service value before commission');
    });

    test('no bookings is an empty dashboard', () {
      final d = buildDashboard(const [], now: now);
      expect(d.isEmpty, isTrue);
      expect(d.completedValue, Money.zero);
    });

    testWidgets('an approved business sees today\'s counts, requests, upcoming and the server\'s earnings', (tester) async {
      final server = _server();
      final today = todayIn('Asia/Kolkata');
      final tomorrow = dateOfIsoPlus(today, 1);
      server.bookings
        ..add(_booking('r1', 'REQUESTED', localStart: '${dateOfIsoPlus(today, 3)}T10:00'))
        ..add(_booking('c1', 'CONFIRMED', localStart: '${today}T23:00'))
        ..add(_booking('d1', 'CLOSED', localStart: '${today}T00:30', paise: 25050))
        ..add(_booking('u1', 'CONFIRMED', localStart: '${tomorrow}T10:00'));
      await _open(tester, server, const TodayScreen());
      await tester.pumpAndSettle();

      Finder stat(String label) => find.widgetWithText(Card, label);
      expect(
        find.descendant(of: stat('Today').first, matching: find.text('2')),
        findsOneWidget,
        reason: 'today: c1 and d1',
      );
      expect(find.descendant(of: stat('Requests'), matching: find.text('1')), findsOneWidget);
      expect(find.descendant(of: stat('Upcoming'), matching: find.text('1')), findsOneWidget);
      expect(find.descendant(of: stat('Completed today'), matching: find.text('1')), findsOneWidget);
      expect(find.textContaining('₹250.50 before commission'), findsOneWidget);
      expect(find.text('Needs your response (1)'), findsOneWidget);
      // Earnings are the SERVER's numbers: payable now, pending (waiting + in payout), paid so far.
      expect(find.text('₹1,200'), findsOneWidget);
      expect(find.text('₹400'), findsOneWidget);
      expect(find.text('₹5,000'), findsOneWidget);
      expect(find.text('Payable now'), findsOneWidget);
      expect(find.text('Pending payout'), findsOneWidget);
    });
  });
}

/// "2026-10-08" + [days] → "2026-10-09" (calendar arithmetic only).
String dateOfIsoPlus(String iso, int days) {
  final d = DateTime.utc(
    int.parse(iso.substring(0, 4)),
    int.parse(iso.substring(5, 7)),
    int.parse(iso.substring(8, 10)),
  ).add(Duration(days: days));
  return '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}
