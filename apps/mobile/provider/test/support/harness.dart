import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tokengo_core/tokengo_core.dart';

http.Response jsonResponse(int status, Object body) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

/// A booking exactly as the API sends it (see BookingView on the server).
Map<String, dynamic> bookingJson({String id = 'b1', String status = 'REQUESTED', String reference = 'TG-TEST0001'}) => {
  'id': id,
  'reference': reference,
  'status': status,
  'funds_status': 'HELD',
  'settlement_status': 'NONE',
  'customer_id': 'c1',
  'provider_id': 'p1',
  'location_id': 'l1',
  'location_name': 'ABC Salon — Koregaon Park',
  'staff_resource_id': 'r1',
  'service': {'id': 's1', 'name': 'Haircut', 'duration_min': 45, 'buffer_min': 0, 'version': 1},
  'price': {'amount_minor': 30000, 'currency': 'INR'},
  'schedule': {
    'start_at': '2026-10-08T04:30:00.000Z',
    'end_at': '2026-10-08T05:15:00.000Z',
    'local_start': '2026-10-08T10:00',
    'timezone': 'Asia/Kolkata',
  },
  'response_deadline_at': status == 'REQUESTED' ? '2026-10-07T12:00:00.000Z' : null,
  'timeline': {
    'requested_at': '2026-10-07T04:00:00.000Z',
    'confirmed_at': null,
    'arrived_at': null,
    'started_at': null,
    'completed_at': null,
    'closed_at': null,
  },
  'settle_after': null,
  'status_reason': null,
  'note': 'Please use the side entrance',
  'cancellation': {'policy': 'Standard', 'refund_if_cancelled_now': null},
};

/// A signed-in provider session whose API is [handler] (no network), showing [home].
Future<ProviderScope> providerScope({
  required MockClientHandler handler,
  required Widget home,
  bool signedIn = true,
  List<Override> overrides = const [],
}) async {
  final session = SessionManager(
    MemoryTokenStore(signedIn ? const StoredSession(accessToken: 'access', refreshToken: 'refresh', userId: 'owner-1') : null),
  );
  await session.load();
  final api = ApiClient(baseUrl: 'http://api.test/api/v1', sessions: session, httpClient: MockClient(handler));
  return ProviderScope(
    overrides: [sessionManagerProvider.overrideWithValue(session), apiClientProvider.overrideWithValue(api), ...overrides],
    child: MaterialApp(
      theme: TokenGoTheme.light(seed: TokenGoTheme.providerSeed),
      home: home,
    ),
  );
}
