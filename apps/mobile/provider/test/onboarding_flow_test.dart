import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:tokengo_provider/core/providers.dart';

import 'support/fake_server.dart';

Finder _button(String label) => find.widgetWithText(FilledButton, label);

/// A business that already has everything the checklist asks for.
FakeServer _readyBusiness({String status = 'DRAFT'}) {
  final s = FakeServer(registered: true, status: status);
  s.locations.add({
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
  });
  s.services.add({
    'id': 's1',
    'provider_id': 'p1',
    'service_type_id': 'st-hair',
    'name': 'Haircut',
    'description': null,
    'price': {'amount_minor': 25000, 'currency': 'INR'},
    'duration_min': 30,
    'buffer_min': 0,
    'is_active': true,
    'attributes': <String, dynamic>{},
    'version': 1,
  });
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
  s.hours = {
    'working': [
      {'weekday': 1, 'start': '09:00', 'end': '19:00'},
    ],
    'breaks': <Object>[],
  };
  return s;
}

void main() {
  testWidgets('a brand-new owner goes from nothing to "submitted for review", step by step, with the exact requests the server expects', (
    tester,
  ) async {
    final server = FakeServer();
    // 18.55904321987654 has more decimals than the server accepts: the app must round before sending.
    await pumpApp(tester, server, locator: () async => const DeviceFound(18.55904321987654, 73.78681234567891));

    // 1. A new number has no business: the way forward is right there.
    expect(find.text('No business yet'), findsOneWidget);
    await tapVisible(tester, _button('Register your business'));

    // 2. Register. The server creates a DRAFT and the checklist takes over.
    await enter(tester, 'Business name', ' Test salon (delete me) ');
    await tapVisible(tester, _button('Register business'));
    final register = server.writesTo('POST', '/providers').single;
    expect(register.body, {'display_name': 'Test salon (delete me)'});
    expect(register.headers['Idempotency-Key'], isNotEmpty);
    expect(find.text('Set up your business'), findsOneWidget);
    expect(find.text('1 of 6'), findsOneWidget);
    expect(find.text('Not submitted yet'), findsOneWidget);
    expect(_button('Submit for review'), findsNothing, reason: 'cannot submit before the setup steps are done');

    // 3. Location: use the phone's position (asked for only now), the rest by hand.
    await tapVisible(tester, _button('Add a location'));
    await enter(tester, 'Location name', 'Baner');
    await enter(tester, 'Street address', '12 Test Road');
    await enter(tester, 'City', 'Pune');
    await enter(tester, 'PIN code', '411045');
    await enter(tester, 'State', 'Maharashtra');
    await tapVisible(tester, find.text('Use my current location'));
    await tapVisible(tester, _button('Add location'));
    final location = server.writesTo('POST', '/locations').single;
    expect(location.body, {
      'name': 'Baner',
      'address_line1': '12 Test Road',
      'city': 'Pune',
      'state': 'Maharashtra',
      'postal_code': '411045',
      'country': 'IN',
      'latitude': 18.559043,
      'longitude': 73.786812,
      'timezone': 'Asia/Kolkata',
    });
    expect(location.headers['Idempotency-Key'], isNotEmpty);
    expect(find.text('2 of 6'), findsOneWidget);

    // 4. Service: the price is typed in rupees and goes out as integer paise.
    await tapVisible(tester, _button('Add a service'));
    await tapVisible(tester, find.widgetWithText(ChoiceChip, 'Haircut'));
    await enter(tester, 'Price', '249.50');
    await tapVisible(tester, find.widgetWithText(ActionChip, '30 min'));
    await tapVisible(tester, _button('Add service'));
    final service = server.writesTo('POST', '/services').single;
    expect(service.body, {
      'service_type_id': 'st-hair',
      'name': 'Haircut',
      'price_minor': 24950,
      'currency': 'INR',
      'duration_min': 30,
      'buffer_min': 0,
    });
    expect(find.text('3 of 6'), findsOneWidget);

    // 5. Hours: one tap for a sensible start, then save.
    await tapVisible(tester, _button('Set your opening hours'));
    await tapVisible(tester, find.text('Start with 9 AM – 7 PM, Monday to Saturday'));
    await tapVisible(tester, _button('Save hours'));
    final hours = server.writesTo('PUT', '/hours').single;
    expect((hours.body!['working'] as List), hasLength(6));
    expect((hours.body!['working'] as List).first, {'weekday': 1, 'start': '09:00', 'end': '19:00'});
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('4 of 6'), findsOneWidget);

    // 6. Staff: yourself, no invitation.
    await tapVisible(tester, _button('Add a staff member'));
    await enter(tester, 'Name', 'Asha');
    await tapVisible(tester, _button('Add staff member'));
    expect(server.writesTo('POST', '/staff').single.body, {
      'location_id': server.locations.single['id'],
      'display_name': 'Asha',
      'staff_role': 'STAFF',
    });
    expect(find.text('5 of 6'), findsOneWidget);

    // 7. Submit — only now offered — and the status banner follows what the server says.
    await tapVisible(tester, _button('Submit for review'));
    await tapVisible(tester, find.widgetWithText(FilledButton, 'Submit'));
    expect(server.writesTo('POST', '/submit'), hasLength(1));
    expect(server.writesTo('POST', '/submit').single.body, isNull, reason: 'a command, not a status update');
    expect(server.status, 'SUBMITTED');
    expect(find.text('Waiting for TokenGo review'), findsWidgets);
    expect(find.text('6 of 6'), findsOneWidget);
  });

  testWidgets('field errors from the server are shown under the right input, nothing is lost, and the lists are re-read', (tester) async {
    final server = _readyBusiness();
    await pumpApp(tester, server, locator: () async => const DeviceFound(18.5, 73.8));
    await tester.tap(find.text('Business'));
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Locations'));
    await tapVisible(tester, find.text('Add location'));
    await enter(tester, 'Location name', 'Second');
    await enter(tester, 'Street address', '5 Lane');
    await enter(tester, 'City', 'Pune');
    await enter(tester, 'PIN code', '411045');
    await enter(tester, 'State', 'Maharashtra');
    await enter(tester, 'Latitude', '18.52');
    await enter(tester, 'Longitude', '73.85');
    server.failNext(
      '/locations',
      FakeServer.problem(
        422,
        'VALIDATION_FAILED',
        'Request validation failed',
        fields: {
          'postal_code': ['postal_code is invalid'],
          'timezone': ['must be a valid IANA time zone, e.g. Asia/Kolkata'],
        },
      ),
    );
    final readsBefore = server.reads.where((p) => p.endsWith('/locations')).length;
    await tapVisible(tester, _button('Add location'));

    expect(find.text('postal_code is invalid'), findsOneWidget, reason: 'under the PIN code field');
    expect(find.text('must be a valid IANA time zone, e.g. Asia/Kolkata'), findsOneWidget, reason: 'under the time zone field');
    expect(find.widgetWithText(TextField, 'Location name'), findsOneWidget, reason: 'the form is still there');
    expect(
      tester.widget<TextField>(find.widgetWithText(TextField, 'Location name')).controller!.text,
      'Second',
      reason: 'nothing typed was lost',
    );
    expect(server.locations, hasLength(1), reason: 'nothing was created');
    // The list underneath is paused while the form is on top; it re-reads (it was invalidated) as soon as the form is left.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(server.reads.where((p) => p.endsWith('/locations')).length, greaterThan(readsBefore), reason: 're-read after the refusal');
  });

  testWidgets('a mistake caught on the phone is explained and nothing is sent', (tester) async {
    final server = FakeServer(registered: true);
    await pumpApp(tester, server);
    await tester.tap(find.text('Business'));
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Services & prices'));
    await tapVisible(tester, find.text('Add service'));
    await tapVisible(tester, find.widgetWithText(ChoiceChip, 'Facial'));
    await enter(tester, 'Price', '12.345');
    await tapVisible(tester, _button('Add service'));
    expect(find.text('Enter an amount like 250 or 249.50'), findsOneWidget);
    expect(find.text('Enter a duration between 5 and 1440 minutes'), findsOneWidget);
    expect(server.writes, isEmpty);
  });

  testWidgets('a retry after a lost connection re-sends the SAME Idempotency-Key; changing the form gets a new one', (tester) async {
    final server = FakeServer();
    await pumpApp(tester, server);
    await tapVisible(tester, _button('Register your business'));
    await enter(tester, 'Business name', 'Salon One');

    server.failNext('/providers', http.ClientException('connection lost'));
    await tapVisible(tester, _button('Register business'));
    expect(find.text('No connection. Check your internet and try again.'), findsOneWidget);
    server.failNext('/providers', http.ClientException('connection lost'));
    await tapVisible(tester, _button('Register business'));
    await enter(tester, 'Business name', 'Salon Two');
    await tapVisible(tester, _button('Register business'));

    final keys = server.writesTo('POST', '/providers').map((w) => w.headers['Idempotency-Key']).toList();
    expect(keys, hasLength(3));
    expect(keys[1], keys[0], reason: 'same request, same key: the server returns the original instead of creating a second business');
    expect(keys[2], isNot(keys[0]), reason: 'a different request is a new intent');
    expect(server.registered, isTrue);
  });

  testWidgets('a submit button cannot be pressed twice while its request is in flight', (tester) async {
    final server = FakeServer();
    await pumpApp(tester, server);
    await tapVisible(tester, _button('Register your business'));
    await enter(tester, 'Business name', 'Salon One');
    final release = server.hold('/providers');

    await tester.tap(_button('Register business'));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byType(FilledButton).first).onPressed, isNull, reason: 'disabled while in flight');
    await tester.tap(find.byType(FilledButton).first, warnIfMissed: false);
    await tester.pump();
    expect(server.writesTo('POST', '/providers'), hasLength(1));

    release.complete();
    await tester.pumpAndSettle();
    expect(server.writesTo('POST', '/providers'), hasLength(1));
    expect(find.text('Set up your business'), findsOneWidget);
  });

  testWidgets('registration refused by the server shows its message on the field', (tester) async {
    final server = FakeServer();
    await pumpApp(tester, server);
    await tapVisible(tester, _button('Register your business'));
    await enter(tester, 'Business name', 'Salon One');
    server.failNext(
      '/providers',
      FakeServer.problem(
        422,
        'VALIDATION_FAILED',
        'Request validation failed',
        fields: {
          'display_name': ['display_name must be longer than or equal to 2 characters'],
        },
      ),
    );
    await tapVisible(tester, _button('Register business'));
    expect(find.text('display_name must be longer than or equal to 2 characters'), findsOneWidget);
    expect(server.registered, isFalse);
    // Too short is caught before it is even sent.
    await enter(tester, 'Business name', 'A');
    final before = server.writes.length;
    await tapVisible(tester, _button('Register business'));
    expect(find.text('Enter your business name (at least 2 characters)'), findsOneWidget);
    expect(server.writes.length, before);
  });

  group('review status', () {
    testWidgets('a rejected business shows the reason and can be fixed and submitted again', (tester) async {
      final server = _readyBusiness(status: 'REJECTED')..decisionReason = 'The address could not be verified';
      await pumpApp(tester, server);
      expect(find.text('Not approved'), findsWidgets);
      expect(find.text('Reason: The address could not be verified'), findsOneWidget);
      expect(_button('Submit for review'), findsOneWidget, reason: 'every setup step is done: resubmitting is offered');

      await tapVisible(tester, _button('Submit for review'));
      expect(find.text('Submit again for review?'), findsOneWidget);
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Submit'));
      expect(server.writesTo('POST', '/submit'), hasLength(1));
      expect(server.status, 'SUBMITTED');
      expect(find.text('Reason: The address could not be verified'), findsNothing, reason: 'the server cleared it on resubmission');
    });

    testWidgets('a suspended business shows why, cannot be edited or resubmitted, and the server\'s refusal is shown if it is tried', (
      tester,
    ) async {
      final server = _readyBusiness(status: 'SUSPENDED')..decisionReason = 'Complaints under review';
      await pumpApp(tester, server);
      expect(find.text('Suspended'), findsWidgets);
      expect(find.text('Reason: Complaints under review'), findsOneWidget);
      expect(_button('Submit for review'), findsNothing);

      await tester.tap(find.text('Business'));
      await tester.pumpAndSettle();
      await tapVisible(tester, find.text('Business profile'));
      expect(find.text('A suspended business cannot be edited. Contact TokenGo support.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save changes'), findsNothing);
      expect(tester.widget<TextField>(find.widgetWithText(TextField, 'Business name')).enabled, isFalse);
    });

    testWidgets('if the server refuses a submission its reason is shown and the status is re-read', (tester) async {
      final server = _readyBusiness();
      await pumpApp(tester, server);
      server.failNext(
        '/submit',
        FakeServer.problem(409, 'PROVIDER_INCOMPLETE', 'Add at least one location before submitting for verification'),
      );
      final readsBefore = server.reads.where((p) => p == '/providers/mine').length;
      await tapVisible(tester, _button('Submit for review'));
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Submit'));
      expect(find.text('Add at least one location before submitting for verification'), findsOneWidget);
      expect(server.status, 'DRAFT');
      expect(server.reads.where((p) => p == '/providers/mine').length, greaterThan(readsBefore));
    });

    testWidgets('the status screen updates by itself when TokenGo approves (no manual refresh needed)', (tester) async {
      final server = _readyBusiness(status: 'SUBMITTED');
      await pumpApp(tester, server);
      expect(find.text('Waiting for TokenGo review'), findsWidgets);
      server.status = 'APPROVED';
      await tester.pump(const Duration(seconds: 31)); // the 30 s poll
      await tester.pumpAndSettle();
      expect(find.text('Approved'), findsNothing, reason: 'the approved dashboard replaces the review banner');
      expect(find.text('Completed today'), findsOneWidget);
    });
  });

  group('staff invitations (the invitee\'s side)', () {
    Map<String, dynamic> invitation(String id) => {
      'id': id,
      'provider_name': 'ABC Salon',
      'location_name': 'Koregaon Park',
      'staff_role': 'STAFF',
      'invited_as': 'Asha',
      'invited_at': '2026-10-07T07:00:00.000Z',
    };

    testWidgets('a person with a pending invitation can accept it', (tester) async {
      final server = FakeServer()..invitations.add(invitation('i1'));
      await pumpApp(tester, server);
      expect(find.text('You have an invitation'), findsOneWidget);
      expect(find.text('ABC Salon invited you to work at Koregaon Park'), findsOneWidget);

      await tapVisible(tester, _button('Accept'));
      expect(server.writesTo('POST', '/staff-invitations/i1/accept'), hasLength(1));
      expect(find.text('You have an invitation'), findsNothing, reason: 'the list was re-read');
      expect(find.textContaining('You joined ABC Salon as stylist'), findsOneWidget);
    });

    testWidgets('declining asks first, then declines', (tester) async {
      final server = FakeServer()..invitations.add(invitation('i1'));
      await pumpApp(tester, server);
      await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Decline'));
      expect(find.text('Decline this invitation?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.writes, isEmpty, reason: 'cancelled: nothing sent');

      await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Decline'));
      await tester.tap(find.widgetWithText(FilledButton, 'Decline'));
      await tester.pumpAndSettle();
      expect(server.writesTo('POST', '/staff-invitations/i1/decline'), hasLength(1));
      expect(find.text('You have an invitation'), findsNothing);
    });

    testWidgets('when the server refuses (the invitation is gone) its message is shown and the list is re-read', (tester) async {
      final server = FakeServer()..invitations.add(invitation('i1'));
      await pumpApp(tester, server);
      server.failNext('/accept', FakeServer.problem(404, 'NOT_FOUND', 'Invitation not found'));
      final readsBefore = server.reads.where((p) => p.endsWith('/staff-invitations')).length;
      await tapVisible(tester, _button('Accept'));
      expect(find.text('Invitation not found'), findsOneWidget);
      expect(server.reads.where((p) => p.endsWith('/staff-invitations')).length, greaterThan(readsBefore));
    });
  });
}
