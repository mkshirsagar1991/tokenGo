import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tokengo_core/tokengo_core.dart';

Map<String, dynamic> _live(String name) =>
    ((jsonDecode(File('test/fixtures/live/$name.json').readAsStringSync()) as Map<String, dynamic>)['body'] as Map<String, dynamic>)['data'] as Map<String, dynamic>;

Map<String, dynamic> _line(String id, String name, int paise, int minutes) => {
  'id': id,
  'name': name,
  'price': {'amount_minor': paise, 'currency': 'INR'},
  'duration_min': minutes,
  'buffer_min': 0,
  'version': 1,
};

void main() {
  group('Booking stylist', () {
    test('reads the stylist the server names, and copes with an older server that sends none', () {
      final json = Map<String, dynamic>.of(_live('appointment'));
      expect(Booking.fromJson(json).staffName, isNull, reason: 'recorded before the server named the stylist');
      expect(Booking.fromJson({...json, 'staff_name': 'Kabir'}).staffName, 'Kabir');
      expect(Booking.fromJson({...json, 'staff_name': null}).staffName, isNull);
    });
  });

  group('Booking with several services', () {
    test('reads the services one by one and the totals the server worked out', () {
      final json = Map<String, dynamic>.of(_live('appointment'))
        ..['service'] = {'id': 'a', 'name': 'Haircut + Shaving', 'duration_min': 55, 'buffer_min': 5, 'version': 1}
        ..['services'] = [_line('a', 'Haircut', 20000, 30), _line('b', 'Shaving', 10000, 20)]
        ..['price'] = {'amount_minor': 30000, 'currency': 'INR'};
      final b = Booking.fromJson(json);

      expect(b.serviceName, 'Haircut + Shaving');
      expect(b.durationMin, 55);
      expect(b.price.minor, 30000);
      expect(b.hasSeveralServices, isTrue);
      expect(b.services.map((s) => s.name), ['Haircut', 'Shaving']);
      expect(b.services.map((s) => s.price.minor), [20000, 10000]);
    });

    test('a booking from before several services existed still reads (no service list: one service, nothing breaks)', () {
      final b = Booking.fromJson(_live('appointment'));
      expect(b.services, isEmpty);
      expect(b.hasSeveralServices, isFalse);
      expect(b.serviceName, isNotEmpty);
    });
  });

  group('Slots for a visit', () {
    Map<String, dynamic> slots({bool withServices = true}) => {
      'location_id': 'loc',
      'timezone': 'Asia/Kolkata',
      'service': {'id': 'a', 'name': 'Facial + Haircut', 'duration_min': 75},
      if (withServices) 'services': [_line('a', 'Facial', 30000, 45), _line('b', 'Haircut', 20000, 30)],
      if (withServices) 'total': {'duration_min': 75, 'price': {'amount_minor': 50000, 'currency': 'INR'}},
      'slots': [
        {'start_at': '2026-10-13T04:30:00.000Z', 'end_at': '2026-10-13T05:45:00.000Z', 'local_start': '2026-10-13T10:00', 'resources': <Object>[]},
      ],
    };

    test('carries the services and what they cost together', () {
      final r = SlotsResult.fromJson(slots());
      expect(r.serviceName, 'Facial + Haircut');
      expect(r.durationMin, 75);
      expect(r.services.map((s) => s.name), ['Facial', 'Haircut']);
      expect(r.totalPrice?.minor, 50000);
      expect(r.slots, hasLength(1));
    });

    test('an answer without the service list (older server, or a recorded one) still reads', () {
      final r = SlotsResult.fromJson(slots(withServices: false));
      expect(r.services, isEmpty);
      expect(r.totalPrice, isNull);
      expect(r.slots, hasLength(1));
    });
  });
}
