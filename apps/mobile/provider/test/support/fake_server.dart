import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';
import 'package:tokengo_provider/core/providers.dart';
import 'package:tokengo_provider/main.dart';

import 'harness.dart';

typedef Write = ({String method, String path, Map<String, dynamic>? body, Map<String, String> headers});

/// An in-memory stand-in for the TokenGo API as a NEW owner experiences it: one business that moves DRAFT -> SUBMITTED, with
/// locations, services, staff, hours and rules. It answers with the same shapes (and the same problem+json refusals) as the
/// real server — the field names here were taken from the live responses captured under tokengo_core/test/fixtures/live.
class FakeServer {
  FakeServer({this.registered = false, this.status = 'DRAFT'});

  bool registered;
  String status;
  String? decisionReason;
  String displayName = 'My Salon';
  String? description;
  int version = 1;

  final locations = <Map<String, dynamic>>[];
  final services = <Map<String, dynamic>>[];
  final staff = <Map<String, dynamic>>[];
  final invitations = <Map<String, dynamic>>[];
  Map<String, dynamic> hours = {'working': <Object>[], 'breaks': <Object>[]};
  Map<String, dynamic> policy = {
    'slot_granularity_min': 15,
    'min_lead_time_min': 60,
    'max_advance_days': 30,
    'response_deadline_min': 30,
    'check_in_window_min': 30,
    'no_show_grace_min': 15,
    'settlement_hold_hours': 24,
  };
  final exceptions = <Map<String, dynamic>>[];
  final bookings = <Map<String, dynamic>>[];
  final writes = <Write>[];
  final reads = <String>[];
  int _n = 0;

  /// Makes the next write to a path containing [pathPart] fail: with a refusal (an `http.Response`), or by throwing.
  final _failures = <String, Object>{};
  void failNext(String pathPart, Object failure) => _failures[pathPart] = failure;

  /// Holds the response to the next write whose path contains [pathPart] until [release] is called.
  final _holds = <String, Completer<void>>{};
  Completer<void> hold(String pathPart) => _holds[pathPart] = Completer<void>();

  List<Write> writesTo(String method, String pathPart) => writes.where((w) => w.method == method && w.path.contains(pathPart)).toList();

  String get providerId => 'p1';

  Map<String, dynamic> get providerJson => {
    'id': providerId,
    'display_name': displayName,
    'description': description,
    'status': status,
    'submitted_at': status == 'DRAFT' ? null : '2026-10-07T07:00:00.000Z',
    'decided_at': null,
    'decision_reason': decisionReason,
    'version': version,
    'created_at': '2026-10-07T06:00:00.000Z',
  };

  static http.Response problem(int status, String code, String detail, {Map<String, List<String>>? fields}) => jsonResponse(status, {
    'type': 'urn:tokengo:problem:${code.toLowerCase()}',
    'title': 'Error',
    'status': status,
    'code': code,
    'detail': detail,
    if (fields != null) 'errors': {'fields': fields},
  });

  Future<http.Response> handle(http.Request r) async {
    final path = r.url.path.replaceFirst('/api/v1', '');
    final body = r.body.isEmpty ? null : jsonDecode(r.body) as Map<String, dynamic>;
    final isWrite = r.method != 'GET';
    if (isWrite) {
      writes.add((method: r.method, path: path, body: body, headers: r.headers));
      for (final e in _failures.entries.toList()) {
        if (path.contains(e.key)) {
          _failures.remove(e.key);
          final f = e.value;
          if (f is http.Response) return f;
          throw f;
        }
      }
      for (final e in _holds.entries.toList()) {
        if (path.contains(e.key)) {
          _holds.remove(e.key);
          await e.value.future;
        }
      }
    } else {
      reads.add(path);
    }
    return _route(r.method, path, body);
  }

  http.Response _route(String method, String path, Map<String, dynamic>? body) {
    String id() => 'id${++_n}';
    // ---- account / catalogue --------------------------------------------------------------------------------------------
    if (path == '/users/me') {
      return jsonResponse(200, {
        'data': {'id': 'owner-1', 'phone_masked': '+91 ••••• ••099', 'permissions': <String>[]},
      });
    }
    if (path == '/categories') {
      return jsonResponse(200, {
        'data': [
          {'id': 'c1', 'code': 'salon', 'name': 'Salon', 'description': null, 'booking_flow_type': 'APPOINTMENT_SLOT'},
          {'id': 'c6', 'code': 'vehicle_service', 'name': 'Vehicle service', 'description': null, 'booking_flow_type': 'APPOINTMENT_SLOT'},
        ],
      });
    }
    if (path == '/categories/vehicle_service/service-types') {
      return jsonResponse(200, {
        'data': [
          {'id': 'st-wash', 'code': 'car_wash', 'name': 'Car wash', 'description': null},
          {'id': 'st-tyre', 'code': 'tyre_change', 'name': 'Tyre change', 'description': null},
        ],
      });
    }
    if (path == '/categories/salon/service-types') {
      return jsonResponse(200, {
        'data': [
          {'id': 'st-hair', 'code': 'haircut', 'name': 'Haircut', 'description': null},
          {'id': 'st-facial', 'code': 'facial', 'name': 'Facial', 'description': null},
        ],
      });
    }
    if (path == '/users/me/staff-invitations') return jsonResponse(200, {'data': invitations});
    final inv = RegExp(r'^/users/me/staff-invitations/([^/]+)/(accept|decline)$').firstMatch(path);
    if (inv != null) {
      final found = invitations.where((i) => i['id'] == inv.group(1));
      if (found.isEmpty) return problem(404, 'NOT_FOUND', 'Invitation not found');
      invitations.removeWhere((i) => i['id'] == inv.group(1));
      if (inv.group(2) == 'decline') return http.Response('', 204);
      return jsonResponse(200, {
        'data': {'id': inv.group(1), 'provider_id': 'other', 'location_id': 'ol', 'staff_role': 'STAFF'},
      });
    }
    // ---- the business ---------------------------------------------------------------------------------------------------
    if (path == '/providers/mine') {
      return jsonResponse(200, {
        'data': registered ? [providerJson] : <Object>[],
      });
    }
    if (path == '/providers' && method == 'POST') {
      final name = (body?['display_name'] as String?) ?? '';
      if (name.trim().length < 2) {
        return problem(
          422,
          'VALIDATION_FAILED',
          'Request validation failed',
          fields: {
            'display_name': ['display_name must be longer than or equal to 2 characters'],
          },
        );
      }
      registered = true;
      displayName = name;
      description = body?['description'] as String?;
      return jsonResponse(201, {'data': providerJson});
    }
    if (path == '/providers/$providerId' && method == 'GET') return jsonResponse(200, {'data': providerJson});
    if (path == '/providers/$providerId' && method == 'PATCH') {
      if (status == 'SUSPENDED') return problem(409, 'PROVIDER_SUSPENDED', 'A suspended provider cannot be edited; contact support');
      if (body!.containsKey('display_name')) displayName = body['display_name'] as String;
      if (body.containsKey('description')) description = body['description'] as String?;
      version++;
      return jsonResponse(200, {'data': providerJson});
    }
    if (path == '/providers/$providerId/submit') {
      if (locations.where((l) => l['status'] == 'ACTIVE').isEmpty) {
        return problem(409, 'PROVIDER_INCOMPLETE', 'Add at least one location before submitting for verification');
      }
      if (status != 'DRAFT' && status != 'REJECTED') {
        return problem(409, 'INVALID_STATE_TRANSITION', 'Cannot submit a provider that is $status');
      }
      status = 'SUBMITTED';
      decisionReason = null;
      version++;
      return jsonResponse(200, {'data': providerJson});
    }
    // ---- locations ------------------------------------------------------------------------------------------------------
    if (path == '/providers/$providerId/locations') {
      if (method == 'GET') return jsonResponse(200, {'data': locations});
      final b = body!;
      final fields = <String, List<String>>{};
      if ((b['name'] as String).isEmpty) fields['name'] = ['name must be longer than or equal to 1 characters'];
      if (!RegExp(r'^[A-Za-z0-9 -]{3,10}$').hasMatch(b['postal_code'] as String)) fields['postal_code'] = ['postal_code is invalid'];
      if (fields.isNotEmpty) return problem(422, 'VALIDATION_FAILED', 'Request validation failed', fields: fields);
      final loc = {'id': id(), 'provider_id': providerId, 'address_line2': null, 'status': 'ACTIVE', ...b};
      locations.add(loc);
      return jsonResponse(201, {'data': loc});
    }
    final loc = RegExp(r'^/providers/p1/locations/([^/]+)$').firstMatch(path);
    if (loc != null) {
      final i = locations.indexWhere((l) => l['id'] == loc.group(1));
      if (i < 0) return problem(404, 'NOT_FOUND', 'Location not found');
      if (method == 'DELETE') {
        locations.removeAt(i);
        return http.Response('', 204);
      }
      locations[i] = {...locations[i], ...body!};
      return jsonResponse(200, {'data': locations[i]});
    }
    final locHours = RegExp(r'^/providers/p1/locations/([^/]+)/hours$').firstMatch(path);
    if (locHours != null) {
      if (method == 'PUT') {
        final working = (body!['working'] as List).cast<Map<String, dynamic>>();
        for (var a = 0; a < working.length; a++) {
          for (var c = a + 1; c < working.length; c++) {
            if (working[a]['weekday'] == working[c]['weekday'] &&
                (working[a]['start'] as String).compareTo(working[c]['end'] as String) < 0 &&
                (working[c]['start'] as String).compareTo(working[a]['end'] as String) < 0) {
              return problem(
                422,
                'VALIDATION_FAILED',
                'Overlapping windows',
                fields: {
                  'working': ['windows overlap on weekday ${working[a]['weekday']}'],
                },
              );
            }
          }
        }
        hours = {'working': working, 'breaks': body['breaks'] ?? <Object>[]};
      }
      return jsonResponse(200, {'data': hours});
    }
    final locEx = RegExp(r'^/providers/p1/locations/([^/]+)/exceptions(?:/([^/]+))?$').firstMatch(path);
    if (locEx != null) {
      if (method == 'GET') return jsonResponse(200, {'data': exceptions});
      if (method == 'DELETE') {
        exceptions.removeWhere((e) => e['id'] == locEx.group(2));
        return http.Response('', 204);
      }
      final e = {
        'id': id(),
        'kind': body!['kind'],
        'start_date': body['start_date'],
        'end_date': body['end_date'] ?? body['start_date'],
        'start': body['start'],
        'end': body['end'],
        'reason': body['reason'],
      };
      exceptions.add(e);
      return jsonResponse(201, {'data': e});
    }
    // ---- services -------------------------------------------------------------------------------------------------------
    if (path == '/providers/$providerId/services') {
      if (method == 'GET') return jsonResponse(200, {'data': services});
      final b = body!;
      final s = {
        'id': id(),
        'provider_id': providerId,
        'service_type_id': b['service_type_id'],
        'name': b['name'],
        'description': b['description'],
        'price': {'amount_minor': b['price_minor'], 'currency': 'INR'},
        'duration_min': b['duration_min'],
        'buffer_min': b['buffer_min'] ?? 0,
        'is_active': true,
        'attributes': <String, dynamic>{},
        'version': 1,
      };
      services.add(s);
      return jsonResponse(201, {'data': s});
    }
    final svc = RegExp(r'^/providers/p1/services/([^/]+)$').firstMatch(path);
    if (svc != null) {
      final i = services.indexWhere((s) => s['id'] == svc.group(1));
      if (i < 0) return problem(404, 'NOT_FOUND', 'Service not found');
      if (method == 'DELETE') {
        services.removeAt(i);
        return http.Response('', 204);
      }
      final s = {...services[i]};
      body!.forEach((k, v) {
        if (k == 'price_minor') {
          s['price'] = {'amount_minor': v, 'currency': 'INR'};
        } else {
          s[k] = v;
        }
      });
      services[i] = s;
      return jsonResponse(200, {'data': s});
    }
    // ---- staff ----------------------------------------------------------------------------------------------------------
    if (path == '/providers/$providerId/staff') {
      if (method == 'GET') return jsonResponse(200, {'data': staff});
      final b = body!;
      final st = {
        'id': id(),
        'provider_id': providerId,
        'location_id': b['location_id'],
        'display_name': b['display_name'],
        'staff_role': b['staff_role'] ?? 'STAFF',
        'status': b['phone'] != null ? 'INVITED' : 'ACTIVE',
        'has_login': false,
        'resource_id': id(),
      };
      staff.add(st);
      return jsonResponse(201, {'data': st});
    }
    final stf = RegExp(r'^/providers/p1/staff/([^/]+)(/.*)?$').firstMatch(path);
    if (stf != null) {
      final i = staff.indexWhere((s) => s['id'] == stf.group(1));
      if (i < 0) return problem(404, 'NOT_FOUND', 'Staff not found');
      final rest = stf.group(2);
      if (rest == null) {
        if (method == 'DELETE') {
          staff.removeAt(i);
          return http.Response('', 204);
        }
        staff[i] = {...staff[i], ...body!.map((k, v) => MapEntry(k, v))};
        return jsonResponse(200, {'data': staff[i]});
      }
      if (rest == '/services') {
        if (method == 'PUT') _skills[stf.group(1)!] = (body!['service_ids'] as List).cast<String>();
        final ids = _skills[stf.group(1)!] ?? <String>[];
        return jsonResponse(200, {
          'data': {'staff_id': stf.group(1), 'restricted': ids.isNotEmpty, 'service_ids': ids},
        });
      }
      if (rest == '/schedule') return jsonResponse(200, {'data': hours});
      if (rest == '/exceptions') return jsonResponse(200, {'data': <Object>[]});
      if (rest == '/blocks') return jsonResponse(200, {'data': <Object>[]});
    }
    if (path == '/providers/$providerId/appointments') {
      return jsonResponse(200, {
        'data': bookings,
        'meta': {'next_cursor': null},
      });
    }
    if (path == '/providers/$providerId/earnings') {
      Map<String, dynamic> m(int minor) => {'amount_minor': minor, 'currency': 'INR'};
      return jsonResponse(200, {
        'data': {
          'waiting': m(30000),
          'eligible': m(120000),
          'in_payout': m(10000),
          'paid_total': m(500000),
          'next_eligible_at': null,
          'payout': {'blocker': 'NO_VERIFIED_ACCOUNT', 'minimum': m(10000), 'account': null},
        },
      });
    }
    // ---- booking rules --------------------------------------------------------------------------------------------------
    if (path == '/providers/$providerId/booking-policy') {
      if (method == 'PUT') {
        policy = {
          'slot_granularity_min': 15,
          'min_lead_time_min': 60,
          'max_advance_days': 30,
          'response_deadline_min': 30,
          'check_in_window_min': 30,
          'no_show_grace_min': 15,
          'settlement_hold_hours': 24,
          ...?body,
        };
      }
      return jsonResponse(200, {
        'data': {'effective': policy},
      });
    }
    return problem(404, 'NOT_FOUND', 'Not found: $method $path');
  }

  final _skills = <String, List<String>>{};
}

/// A tall phone-sized surface, so forms and lists are laid out like on a real device.
void usePhoneSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
}

/// The whole app, signed in as a new owner, over [server].
Future<void> pumpApp(
  WidgetTester tester,
  FakeServer server, {
  List<Override> overrides = const [],
  Future<DeviceFix> Function()? locator,
}) async {
  usePhoneSurface(tester);
  final session = SessionManager(MemoryTokenStore(const StoredSession(accessToken: 'a', refreshToken: 'r', userId: 'owner-1')));
  await session.load();
  final api = ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient(server.handle));
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sessionManagerProvider.overrideWithValue(session),
        apiClientProvider.overrideWithValue(api),
        mapPreviewEnabledProvider.overrideWithValue(false),
        if (locator != null) deviceLocatorProvider.overrideWithValue(locator),
        ...overrides,
      ],
      child: const TokenGoBusinessApp(),
    ),
  );
  await tester.pumpAndSettle();
}

/// Scrolls [finder] into view (lists build lazily) and taps it.
Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  // A floating snack bar from the previous step would sit on top of the control (it does for a few seconds on a real phone too).
  final scaffold = find.byType(Scaffold);
  if (scaffold.evaluate().isNotEmpty) {
    ScaffoldMessenger.of(tester.element(scaffold.first)).removeCurrentSnackBar();
    await tester.pump();
  }
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(finder, 120, scrollable: find.byType(Scrollable).first, maxScrolls: 40);
  }
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> enter(WidgetTester tester, String label, String text) async {
  final field = find.widgetWithText(TextField, label);
  if (field.evaluate().isEmpty) {
    await tester.scrollUntilVisible(field, 120, scrollable: find.byType(Scrollable).first, maxScrolls: 40);
  }
  await tester.enterText(field, text);
  await tester.pump();
}
