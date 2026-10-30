// Captures REAL responses from the running dev API (demo data only) as fixtures for test/live_contract_test.dart.
// Logs in as the seeded demo users with the dev OTPs printed in the API log. Never stores tokens.
//
//   API_LOG=<file the API's stdout goes to> OUT_DIR=test/fixtures/live [INTENT_ID=<a pending payment intent id>] \
//     [CAPTURE_SETUP_WRITES=1] [SETUP_ONLY=1] node tool/capture_fixtures.mjs
//
// After capturing, scrub anything that is not demo data (the Razorpay key id in payment_intent.json is replaced by
// rzp_test_FIXTURE) and run `flutter test`. Requires `pnpm seed:dev` data and a running API.
//
// The provider-SETUP fixtures (setup_*.json) come in two groups:
//   * reads of the seeded ABC Salon (locations, services, staff, hours, booking rules, ...) — always captured;
//   * the WRITE responses (register a business, add a location/service/staff, hours, time off, a walk-in block, submit, the
//     invitee accepting/declining) — only with CAPTURE_SETUP_WRITES=1, because they create a throw-away business named
//     "Fixture Salon (delete me)" for a fresh owner phone (FIXTURE_OWNER_PHONE, default 9000000097) and an invitee phone
//     (FIXTURE_INVITEE_PHONE, default 9000000096) in the dev database. Re-running reuses that business.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3000/api/v1';
const LOG = process.env.API_LOG;
const OUT = process.env.OUT_DIR;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body, key } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  return { status: res.status, body: json };
}

async function login(phone) {
  const last3 = phone.slice(-3);
  const r = await call('POST', '/auth/otp/request', { body: { phone } });
  if (r.status >= 300) throw new Error(`otp request ${phone}: ${r.status} ${JSON.stringify(r.body)}`);
  await sleep(1500);
  const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`••${last3}:`));
  const code = /••\d{3}: (\d{6})/.exec(lines[lines.length - 1] ?? '')?.[1];
  if (!code) throw new Error('no OTP in log for ' + phone);
  const v = await call('POST', '/auth/otp/verify', { body: { phone, code } });
  if (v.status !== 200) throw new Error(`verify ${phone}: ${v.status}`);
  return v.body.access_token;
}

const saved = [];
function save(name, r) {
  // SETUP_ONLY=1: refresh only the provider-setup fixtures and leave the others as captured.
  if (process.env.SETUP_ONLY === '1' && !name.startsWith('setup_')) return;
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(r, null, 2));
  saved.push(`${name} (${r.status})`);
}

// ---- public discovery ----
save('categories', await call('GET', '/categories'));
const search = await call('GET', '/search/providers?lat=18.5204&lng=73.8567&radius_m=20000&limit=5');
save('search_providers', search);
save('search_map', await call('GET', '/search/map?bbox=73.7,18.4,74.0,18.7'));
const loc = search.body.data[0];
const profile = await call('GET', `/locations/${loc.location_id}`);
save('location_profile', profile);
const svc = profile.body.data.services?.[0];
const today = new Date().toISOString().slice(0, 10);
save('slots', await call('GET', `/availability/slots?location_id=${loc.location_id}&service_id=${svc.id}&date=${today}&days=3`));

// ---- customer ----
const cust = await login('9000000021');
save('customer_me', await call('GET', '/users/me', { token: cust }));
save('wallet', await call('GET', '/wallet', { token: cust }));
save('wallet_transactions', await call('GET', '/wallet/transactions?limit=30', { token: cust }));
const mine = await call('GET', '/appointments?limit=5', { token: cust });
save('appointments_list', mine);
const b = mine.body.data[0];
if (b) {
  save('appointment', await call('GET', `/appointments/${b.id}`, { token: cust }));
  save('appointment_events', await call('GET', `/appointments/${b.id}/events`, { token: cust }));
  save('arrival_code_outside_window', await call('GET', `/appointments/${b.id}/arrival-code`, { token: cust }));
}
const intentId = process.env.INTENT_ID;
if (intentId) save('payment_intent', await call('GET', `/payments/intents/${intentId}`, { token: cust }));

// ---- provider owner (ABC Salon) ----
const owner = await login('9000000011');
save('owner_me', await call('GET', '/users/me', { token: owner }));
const provs = await call('GET', '/providers/mine', { token: owner });
save('providers_mine', provs);
const pid = provs.body.data[0].id;
save('provider_appointments', await call('GET', `/providers/${pid}/appointments?limit=5`, { token: owner }));
save('provider_earnings', await call('GET', `/providers/${pid}/earnings`, { token: owner }));
save('provider_payables', await call('GET', `/providers/${pid}/payables?limit=5`, { token: owner }));
save('provider_payouts', await call('GET', `/providers/${pid}/payouts?limit=5`, { token: owner }));
save('provider_payout_account', await call('GET', `/providers/${pid}/payout-account`, { token: owner }));

// ---- provider SETUP: reads of the seeded ABC Salon ----
const setupBase = `/providers/${pid}`;
save('setup_service_types', await call('GET', '/categories/salon/service-types'));
const locs = await call('GET', `${setupBase}/locations`, { token: owner });
save('setup_locations', locs);
const abcLoc = locs.body.data[0];
save('setup_services', await call('GET', `${setupBase}/services`, { token: owner }));
const staffList = await call('GET', `${setupBase}/staff`, { token: owner });
save('setup_staff', staffList);
const abcStaff = staffList.body.data[0];
save('setup_location_hours', await call('GET', `${setupBase}/locations/${abcLoc.id}/hours`, { token: owner }));
save('setup_location_exceptions', await call('GET', `${setupBase}/locations/${abcLoc.id}/exceptions`, { token: owner }));
save('setup_booking_policy', await call('GET', `${setupBase}/booking-policy`, { token: owner }));
if (abcStaff) {
  save('setup_staff_skills', await call('GET', `${setupBase}/staff/${abcStaff.id}/services`, { token: owner }));
  save('setup_staff_schedule', await call('GET', `${setupBase}/staff/${abcStaff.id}/schedule`, { token: owner }));
  save('setup_staff_exceptions', await call('GET', `${setupBase}/staff/${abcStaff.id}/exceptions`, { token: owner }));
  save('setup_staff_blocks', await call('GET', `${setupBase}/staff/${abcStaff.id}/blocks`, { token: owner }));
}
save('setup_provider_get', await call('GET', setupBase, { token: owner }));

// ---- provider SETUP: writes, for a throw-away business ----
if (process.env.CAPTURE_SETUP_WRITES === '1') {
  const ownerPhone = process.env.FIXTURE_OWNER_PHONE ?? '9000000097';
  const inviteePhone = process.env.FIXTURE_INVITEE_PHONE ?? '9000000096';
  const newOwner = await login(ownerPhone);
  const mineNew = await call('GET', '/providers/mine', { token: newOwner });
  let fx = mineNew.body.data.find((p) => p.display_name === 'Fixture Salon (delete me)');
  const uid = () => crypto.randomUUID();
  if (!fx) {
    const reg = await call('POST', '/providers', {
      token: newOwner,
      key: uid(),
      body: { display_name: 'Fixture Salon (delete me)', description: 'Throw-away business used to capture API fixtures.' },
    });
    save('setup_register_created', reg);
    fx = reg.body.data;
    // Submitting before there is a location is refused: capture that refusal while it is still true.
    save('setup_submit_incomplete_refused', await call('POST', `/providers/${fx.id}/submit`, { token: newOwner }));
    const loc = await call('POST', `/providers/${fx.id}/locations`, {
      token: newOwner,
      key: uid(),
      body: {
        name: 'Fixture Salon - Baner',
        address_line1: '12 Test Road',
        city: 'Pune',
        state: 'Maharashtra',
        postal_code: '411045',
        country: 'IN',
        latitude: 18.559,
        longitude: 73.7868,
        timezone: 'Asia/Kolkata',
      },
    });
    save('setup_location_created', loc);
    const locId = loc.body.data.id;
    save(
      'setup_location_invalid_refused',
      await call('POST', `/providers/${fx.id}/locations`, {
        token: newOwner,
        body: { name: '', address_line1: 'x', city: 'Pune', state: 'MH', postal_code: '!!', latitude: 200, longitude: 73.1 },
      }),
    );
    save(
      'setup_location_updated',
      await call('PATCH', `/providers/${fx.id}/locations/${locId}`, { token: newOwner, body: { address_line2: 'Near the fixture park' } }),
    );
    const types = (await call('GET', '/categories/salon/service-types')).body.data;
    const svc = await call('POST', `/providers/${fx.id}/services`, {
      token: newOwner,
      key: uid(),
      body: { service_type_id: types[0].id, name: 'Fixture haircut', price_minor: 25050, currency: 'INR', duration_min: 30, buffer_min: 5 },
    });
    save('setup_service_created', svc);
    const svcId = svc.body.data.id;
    save(
      'setup_service_invalid_refused',
      await call('POST', `/providers/${fx.id}/services`, {
        token: newOwner,
        body: { service_type_id: types[0].id, name: 'Bad', price_minor: -1, duration_min: 2 },
      }),
    );
    save('setup_service_updated', await call('PATCH', `/providers/${fx.id}/services/${svcId}`, { token: newOwner, body: { price_minor: 27500 } }));
    const hours = {
      working: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '19:00' })),
      breaks: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '13:00', end: '14:00' })),
    };
    save('setup_location_hours_set', await call('PUT', `/providers/${fx.id}/locations/${locId}/hours`, { token: newOwner, body: hours }));
    save(
      'setup_hours_overlap_refused',
      await call('PUT', `/providers/${fx.id}/locations/${locId}/hours`, {
        token: newOwner,
        body: {
          working: [
            { weekday: 1, start: '09:00', end: '12:00' },
            { weekday: 1, start: '11:00', end: '13:00' },
          ],
        },
      }),
    );
    // The refusal above must not have changed anything: put the real pattern back.
    await call('PUT', `/providers/${fx.id}/locations/${locId}/hours`, { token: newOwner, body: hours });

    const staff = await call('POST', `/providers/${fx.id}/staff`, {
      token: newOwner,
      key: uid(),
      body: { location_id: locId, display_name: 'Fixture Owner Stylist', staff_role: 'STAFF' },
    });
    save('setup_staff_created', staff);
    const staffId = staff.body.data.id;
    save(
      'setup_staff_invited_created',
      await call('POST', `/providers/${fx.id}/staff`, {
        token: newOwner,
        key: uid(),
        body: { location_id: locId, display_name: 'Fixture Invitee', staff_role: 'MANAGER', phone: inviteePhone },
      }),
    );
    await call('POST', `/providers/${fx.id}/staff`, {
      token: newOwner,
      key: uid(),
      body: { location_id: locId, display_name: 'Fixture Decliner', phone: inviteePhone },
    });
    save(
      'setup_staff_invalid_phone_refused',
      await call('POST', `/providers/${fx.id}/staff`, { token: newOwner, body: { location_id: locId, display_name: 'Bad Phone', phone: '12345' } }),
    );
    save('setup_staff_updated', await call('PATCH', `/providers/${fx.id}/staff/${staffId}`, { token: newOwner, body: { display_name: 'Fixture Stylist' } }));
    save(
      'setup_staff_skills_set',
      await call('PUT', `/providers/${fx.id}/staff/${staffId}/services`, { token: newOwner, body: { service_ids: [svcId] } }),
    );
    save(
      'setup_staff_schedule_set',
      await call('PUT', `/providers/${fx.id}/staff/${staffId}/schedule`, {
        token: newOwner,
        body: { working: [{ weekday: 1, start: '10:00', end: '17:00' }], breaks: [] },
      }),
    );
    const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    save(
      'setup_location_exception_created',
      await call('POST', `/providers/${fx.id}/locations/${locId}/exceptions`, {
        token: newOwner,
        key: uid(),
        body: { kind: 'CLOSED', start_date: inTwoDays, end_date: inTwoDays, reason: 'Fixture holiday' },
      }),
    );
    save(
      'setup_staff_exception_created',
      await call('POST', `/providers/${fx.id}/staff/${staffId}/exceptions`, {
        token: newOwner,
        key: uid(),
        body: { kind: 'OPEN', start_date: inTwoDays, start: '10:00', end: '14:00' },
      }),
    );
    const blockStart = new Date(Math.ceil((Date.now() + 3 * 86400000) / 60000) * 60000);
    save(
      'setup_block_created',
      await call('POST', `/providers/${fx.id}/staff/${staffId}/blocks`, {
        token: newOwner,
        key: uid(),
        body: { start_at: blockStart.toISOString(), end_at: new Date(blockStart.getTime() + 3600000).toISOString(), reason: 'Fixture walk-in' },
      }),
    );
    save(
      'setup_booking_policy_set',
      await call('PUT', `/providers/${fx.id}/booking-policy`, {
        token: newOwner,
        body: {
          slot_granularity_min: 15,
          min_lead_time_min: 60,
          max_advance_days: 30,
          response_deadline_min: 120,
          check_in_window_min: 30,
          no_show_grace_min: 15,
          settlement_hold_hours: 24,
        },
      }),
    );
    save('setup_staff_list_with_invite', await call('GET', `/providers/${fx.id}/staff`, { token: newOwner }));
    save('setup_submit', await call('POST', `/providers/${fx.id}/submit`, { token: newOwner }));
    save('setup_submit_again_refused', await call('POST', `/providers/${fx.id}/submit`, { token: newOwner }));

    // The invitee's side.
    const invitee = await login(inviteePhone);
    const invs = await call('GET', '/users/me/staff-invitations', { token: invitee });
    save('setup_invitations', invs);
    const toAccept = invs.body.data.find((i) => i.invited_as === 'Fixture Invitee');
    if (toAccept) save('setup_invitation_accepted', await call('POST', `/users/me/staff-invitations/${toAccept.id}/accept`, { token: invitee }));
    const toDecline = invs.body.data.find((i) => i.invited_as === 'Fixture Decliner');
    if (toDecline) save('setup_invitation_declined', await call('POST', `/users/me/staff-invitations/${toDecline.id}/decline`, { token: invitee }));
  }
  save('setup_providers_mine_new_owner', await call('GET', '/providers/mine', { token: newOwner }));
}

console.log(saved.join('\n'));
