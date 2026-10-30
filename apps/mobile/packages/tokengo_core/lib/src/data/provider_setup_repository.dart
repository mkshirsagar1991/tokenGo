import '../models/json_helpers.dart';
import '../models/provider_account.dart';
import '../models/provider_setup.dart';
import '../net/api_client.dart';
import 'guard.dart';

/// Setting up and managing a business: registration, locations, services, staff, hours, time off and booking rules. The
/// server decides who may do what and validates everything (its per-field messages arrive as [ApiException.fields]); the app
/// only builds the request and shows what comes back — and re-reads after every change.
///
/// Creating things sends an `Idempotency-Key` that the caller keeps for one attempt (see `AttemptKey`), so a retry after a
/// dropped connection cannot register a second business or add a second location.
class ProviderSetupRepository {
  ProviderSetupRepository(this._api);

  final ApiClient _api;

  // ---- the business -------------------------------------------------------------------------------------------------
  Future<ProviderAccount> register({required String displayName, String? description, required String idempotencyKey}) async {
    final body = <String, dynamic>{
      'display_name': displayName.trim(),
      if (description != null && description.trim().isNotEmpty) 'description': description.trim(),
    };
    final json = await _api.post('/providers', body: body, idempotencyKey: idempotencyKey);
    return parseResponse(() => ProviderAccount.fromJson(json.m('data')));
  }

  Future<ProviderAccount> business(String providerId) async {
    final json = await _api.get('/providers/$providerId');
    return parseResponse(() => ProviderAccount.fromJson(json.m('data')));
  }

  /// Changes the name and/or description (null = leave as is; a blank description clears it).
  Future<ProviderAccount> updateProfile(String providerId, {String? displayName, String? description}) async {
    final body = <String, dynamic>{
      'display_name': ?displayName?.trim(),
      if (description != null) 'description': description.trim().isEmpty ? null : description.trim(),
    };
    final json = await _api.patch('/providers/$providerId', body: body);
    return parseResponse(() => ProviderAccount.fromJson(json.m('data')));
  }

  /// Asks TokenGo to review the business. Only DRAFT and REJECTED businesses can be submitted; the server says why not.
  Future<ProviderAccount> submit(String providerId) async {
    final json = await _api.post('/providers/$providerId/submit');
    return parseResponse(() => ProviderAccount.fromJson(json.m('data')));
  }

  // ---- locations ----------------------------------------------------------------------------------------------------
  Future<List<OwnedLocation>> locations(String providerId) async {
    final json = await _api.get('/providers/$providerId/locations');
    return parseResponse(() => json.l('data').map(OwnedLocation.fromJson).toList());
  }

  Future<OwnedLocation> createLocation(String providerId, LocationDraft draft, {required String idempotencyKey}) async {
    final json = await _api.post('/providers/$providerId/locations', body: draft.toCreateJson(), idempotencyKey: idempotencyKey);
    return parseResponse(() => OwnedLocation.fromJson(json.m('data')));
  }

  /// [changes] is a PATCH body from [LocationDraft.changesFrom] (only what changed).
  Future<OwnedLocation> updateLocation(String providerId, String locationId, Map<String, dynamic> changes) async {
    final json = await _api.patch('/providers/$providerId/locations/$locationId', body: changes);
    return parseResponse(() => OwnedLocation.fromJson(json.m('data')));
  }

  Future<void> deleteLocation(String providerId, String locationId) async {
    await _api.delete('/providers/$providerId/locations/$locationId');
  }

  // ---- services -----------------------------------------------------------------------------------------------------
  /// The platform's service catalogue for a category (public).
  Future<List<ServiceType>> serviceTypes(String categoryCode) async {
    final json = await _api.get('/categories/$categoryCode/service-types', auth: false);
    return parseResponse(() => json.l('data').map(ServiceType.fromJson).toList());
  }

  Future<List<OwnedService>> services(String providerId) async {
    final json = await _api.get('/providers/$providerId/services');
    return parseResponse(() => json.l('data').map(OwnedService.fromJson).toList());
  }

  Future<OwnedService> createService(String providerId, ServiceDraft draft, {required String idempotencyKey}) async {
    final json = await _api.post('/providers/$providerId/services', body: draft.toCreateJson(), idempotencyKey: idempotencyKey);
    return parseResponse(() => OwnedService.fromJson(json.m('data')));
  }

  Future<OwnedService> updateService(String providerId, String serviceId, Map<String, dynamic> changes) async {
    final json = await _api.patch('/providers/$providerId/services/$serviceId', body: changes);
    return parseResponse(() => OwnedService.fromJson(json.m('data')));
  }

  Future<void> deleteService(String providerId, String serviceId) async {
    await _api.delete('/providers/$providerId/services/$serviceId');
  }

  // ---- staff --------------------------------------------------------------------------------------------------------
  Future<List<OwnedStaff>> staff(String providerId, {String? locationId}) async {
    final json = await _api.get('/providers/$providerId/staff', query: {'location_id': locationId});
    return parseResponse(() => json.l('data').map(OwnedStaff.fromJson).toList());
  }

  Future<OwnedStaff> createStaff(String providerId, StaffDraft draft, {required String idempotencyKey}) async {
    final json = await _api.post('/providers/$providerId/staff', body: draft.toCreateJson(), idempotencyKey: idempotencyKey);
    return parseResponse(() => OwnedStaff.fromJson(json.m('data')));
  }

  Future<OwnedStaff> updateStaff(String providerId, String staffId, {String? displayName, String? role}) async {
    final body = <String, dynamic>{'display_name': ?displayName?.trim(), 'staff_role': ?role};
    final json = await _api.patch('/providers/$providerId/staff/$staffId', body: body);
    return parseResponse(() => OwnedStaff.fromJson(json.m('data')));
  }

  Future<void> deleteStaff(String providerId, String staffId) async {
    await _api.delete('/providers/$providerId/staff/$staffId');
  }

  Future<StaffSkills> staffSkills(String providerId, String staffId) async {
    final json = await _api.get('/providers/$providerId/staff/$staffId/services');
    return parseResponse(() => StaffSkills.fromJson(json.m('data')));
  }

  /// Replaces the list. An empty list means "can do every service".
  Future<StaffSkills> setStaffSkills(String providerId, String staffId, List<String> serviceIds) async {
    final json = await _api.put('/providers/$providerId/staff/$staffId/services', body: {'service_ids': serviceIds});
    return parseResponse(() => StaffSkills.fromJson(json.m('data')));
  }

  // ---- invitations (the person who was invited) -----------------------------------------------------------------------
  Future<List<StaffInvitation>> myInvitations() async {
    final json = await _api.get('/users/me/staff-invitations');
    return parseResponse(() => json.l('data').map(StaffInvitation.fromJson).toList());
  }

  Future<InvitationAccepted> acceptInvitation(String staffId) async {
    final json = await _api.post('/users/me/staff-invitations/$staffId/accept');
    return parseResponse(() => InvitationAccepted.fromJson(json.m('data')));
  }

  Future<void> declineInvitation(String staffId) async {
    await _api.post('/users/me/staff-invitations/$staffId/decline');
  }

  // ---- weekly hours -------------------------------------------------------------------------------------------------
  Future<WeeklyHours> locationHours(String providerId, String locationId) async {
    final json = await _api.get('/providers/$providerId/locations/$locationId/hours');
    return parseResponse(() => WeeklyHours.fromJson(json.m('data')));
  }

  /// Replaces the whole weekly pattern.
  Future<WeeklyHours> setLocationHours(String providerId, String locationId, WeeklyHours hours) async {
    final json = await _api.put('/providers/$providerId/locations/$locationId/hours', body: hours.toJson());
    return parseResponse(() => WeeklyHours.fromJson(json.m('data')));
  }

  /// A staff member's own hours. With no opening windows they follow the location's hours.
  Future<WeeklyHours> staffSchedule(String providerId, String staffId) async {
    final json = await _api.get('/providers/$providerId/staff/$staffId/schedule');
    return parseResponse(() => WeeklyHours.fromJson(json.m('data')));
  }

  Future<WeeklyHours> setStaffSchedule(String providerId, String staffId, WeeklyHours hours) async {
    final json = await _api.put('/providers/$providerId/staff/$staffId/schedule', body: hours.toJson());
    return parseResponse(() => WeeklyHours.fromJson(json.m('data')));
  }

  // ---- time off (holidays, leave, special openings) -----------------------------------------------------------------
  Future<List<ScheduleException>> locationExceptions(String providerId, String locationId) async {
    final json = await _api.get('/providers/$providerId/locations/$locationId/exceptions');
    return parseResponse(() => json.l('data').map(ScheduleException.fromJson).toList());
  }

  Future<ScheduleException> addLocationException(
    String providerId,
    String locationId,
    ExceptionDraft draft, {
    required String idempotencyKey,
  }) async {
    final json = await _api.post(
      '/providers/$providerId/locations/$locationId/exceptions',
      body: draft.toJson(),
      idempotencyKey: idempotencyKey,
    );
    return parseResponse(() => ScheduleException.fromJson(json.m('data')));
  }

  Future<void> deleteLocationException(String providerId, String locationId, String exceptionId) async {
    await _api.delete('/providers/$providerId/locations/$locationId/exceptions/$exceptionId');
  }

  Future<List<ScheduleException>> staffExceptions(String providerId, String staffId) async {
    final json = await _api.get('/providers/$providerId/staff/$staffId/exceptions');
    return parseResponse(() => json.l('data').map(ScheduleException.fromJson).toList());
  }

  Future<ScheduleException> addStaffException(
    String providerId,
    String staffId,
    ExceptionDraft draft, {
    required String idempotencyKey,
  }) async {
    final json = await _api.post('/providers/$providerId/staff/$staffId/exceptions', body: draft.toJson(), idempotencyKey: idempotencyKey);
    return parseResponse(() => ScheduleException.fromJson(json.m('data')));
  }

  Future<void> deleteStaffException(String providerId, String staffId, String exceptionId) async {
    await _api.delete('/providers/$providerId/staff/$staffId/exceptions/$exceptionId');
  }

  // ---- walk-in blocks -----------------------------------------------------------------------------------------------
  Future<List<StaffBlock>> blocks(String providerId, String staffId) async {
    final json = await _api.get('/providers/$providerId/staff/$staffId/blocks');
    return parseResponse(() => json.l('data').map(StaffBlock.fromJson).toList());
  }

  /// Occupies the stylist exactly like a booking; the server refuses (409 SLOT_UNAVAILABLE) if something is already there.
  Future<StaffBlock> addBlock(String providerId, String staffId, BlockDraft draft, {required String idempotencyKey}) async {
    final json = await _api.post('/providers/$providerId/staff/$staffId/blocks', body: draft.toJson(), idempotencyKey: idempotencyKey);
    return parseResponse(() => StaffBlock.fromJson(json.m('data')));
  }

  Future<void> releaseBlock(String providerId, String staffId, String blockId) async {
    await _api.delete('/providers/$providerId/staff/$staffId/blocks/$blockId');
  }

  // ---- booking rules ------------------------------------------------------------------------------------------------
  Future<BookingPolicy> policy(String providerId) async {
    final json = await _api.get('/providers/$providerId/booking-policy');
    return parseResponse(() => BookingPolicy.fromJson(json.m('data').m('effective')));
  }

  /// Replaces this business's overrides with exactly [policy] (see [BookingPolicy.toJson]).
  Future<BookingPolicy> setPolicy(String providerId, BookingPolicy policy) => _putPolicy(providerId, policy.toJson());

  /// Removes every override: the platform defaults apply again.
  Future<BookingPolicy> resetPolicy(String providerId) => _putPolicy(providerId, <String, dynamic>{});

  Future<BookingPolicy> _putPolicy(String providerId, Map<String, dynamic> body) async {
    final json = await _api.put('/providers/$providerId/booking-policy', body: body);
    return parseResponse(() => BookingPolicy.fromJson(json.m('data').m('effective')));
  }
}
