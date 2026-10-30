import { Injectable } from '@nestjs/common';
import {
  Clock,
  ConflictError,
  NotFoundError,
  PG_UNIQUE_VIOLATION,
  UnitOfWork,
  ValidationFailedError,
  pgErrorCode,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { AuthorizationService, PhoneHasher, normalizePhone } from '../../identity-access';
import { ProviderRepository } from '../infrastructure/provider.repository';
import { ProviderAccessService } from './provider-access.service';

type StaffRole = 'MANAGER' | 'STAFF';
const ROLE_CODE: Record<StaffRole, string> = { MANAGER: 'PROVIDER_MANAGER', STAFF: 'PROVIDER_STAFF' };

type StaffRow = NonNullable<Awaited<ReturnType<ProviderRepository['findStaff']>>>;

export function toStaffView(s: StaffRow) {
  return {
    id: s.id,
    provider_id: s.provider_id,
    location_id: s.location_id,
    display_name: s.display_name,
    staff_role: s.staff_role,
    status: s.status,
    has_login: s.user_id !== null,
    resource_id: s.resource_id,
  };
}

@Injectable()
export class StaffService {
  constructor(
    private readonly repo: ProviderRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly access: ProviderAccessService,
    private readonly authz: AuthorizationService,
    private readonly phones: PhoneHasher,
    private readonly audit: AuditService,
  ) {}

  /**
   * Adds a staff member (and the schedulable STAFF resource behind them). If a phone is supplied they
   * are INVITED; no account is created for them — they must log in themselves and accept (consent).
   */
  async create(
    userId: string,
    providerId: string,
    input: { locationId: string; displayName: string; staffRole: StaffRole; phone?: string },
  ) {
    await this.access.require(userId, 'staff:manage', providerId);
    if (!(await this.repo.findLocation(providerId, input.locationId))) throw new NotFoundError('Location');

    let invitedPhoneHash: string | null = null;
    if (input.phone !== undefined) {
      const e164 = normalizePhone(input.phone);
      if (!e164) throw new ValidationFailedError('Invalid phone number', { fields: { phone: ['must be a valid mobile number'] } });
      invitedPhoneHash = this.phones.hash(e164);
    }

    return this.uow.run(async () => {
      const resourceId = await this.repo.insertResource(input.locationId, input.displayName);
      const id = await this.repo.insertStaff({
        providerId,
        locationId: input.locationId,
        resourceId,
        displayName: input.displayName,
        staffRole: input.staffRole,
        invitedPhoneHash,
      });
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.staff_created',
        entityType: 'provider_staff',
        entityId: id,
        after: { provider_id: providerId, location_id: input.locationId, staff_role: input.staffRole, invited: invitedPhoneHash !== null },
      });
      const created = await this.repo.findStaff(providerId, id);
      if (!created) throw new NotFoundError('Staff');
      return toStaffView(created);
    });
  }

  /** With `locationId`: needs `staff:read` at that location (managers/staff). Without: provider-wide. */
  async list(userId: string, providerId: string, locationId?: string) {
    await this.access.require(userId, 'staff:read', providerId, locationId);
    return (await this.repo.listStaff(providerId, locationId)).map(toStaffView);
  }

  async update(userId: string, providerId: string, staffId: string, patch: { displayName?: string; staffRole?: StaffRole }) {
    await this.access.require(userId, 'staff:manage', providerId);
    return this.uow.run(async () => {
      const staff = await this.repo.findStaff(providerId, staffId);
      if (!staff) throw new NotFoundError('Staff');
      await this.repo.updateStaff(staffId, patch);
      if (patch.displayName !== undefined && staff.resource_id) await this.repo.renameResource(staff.resource_id, patch.displayName);

      // A role change must move the real authorization grant, not just the label.
      if (patch.staffRole && patch.staffRole !== staff.staff_role && staff.user_id) {
        await this.authz.revokeRole(staff.user_id, ROLE_CODE[staff.staff_role], { type: 'LOCATION', id: staff.location_id });
        await this.authz.grantRole(staff.user_id, ROLE_CODE[patch.staffRole], { type: 'LOCATION', id: staff.location_id }, userId);
      }
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.staff_updated',
        entityType: 'provider_staff',
        entityId: staffId,
        before: { staff_role: staff.staff_role },
        after: { staff_role: patch.staffRole ?? staff.staff_role },
      });
      const updated = await this.repo.findStaff(providerId, staffId);
      if (!updated) throw new NotFoundError('Staff');
      return toStaffView(updated);
    });
  }

  async remove(userId: string, providerId: string, staffId: string): Promise<void> {
    await this.access.require(userId, 'staff:manage', providerId);
    await this.uow.run(async () => {
      const staff = await this.repo.findStaff(providerId, staffId);
      if (!staff) throw new NotFoundError('Staff');
      await this.repo.softDeleteStaff(staffId, this.clock.now());
      if (staff.resource_id) await this.repo.deactivateResource(staff.resource_id);
      if (staff.user_id) {
        // Access is revoked in the SAME transaction: a removed stylist loses permissions immediately.
        await this.authz.revokeRole(staff.user_id, ROLE_CODE[staff.staff_role], { type: 'LOCATION', id: staff.location_id });
      }
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.staff_removed',
        entityType: 'provider_staff',
        entityId: staffId,
        metadata: { provider_id: providerId },
      });
    });
  }

  // --- invitations (invitee side) ----------------------------------------------------------------------
  async listMyInvitations(userId: string) {
    const phoneHash = await this.authz.getPhoneHash(userId);
    if (!phoneHash) return [];
    const rows = await this.repo.listInvitationsForPhone(phoneHash);
    return rows.map((r) => ({
      id: r.id,
      provider_name: r.provider_name,
      location_name: r.location_name,
      staff_role: r.staff_role,
      invited_as: r.display_name,
      invited_at: r.created_at,
    }));
  }

  async acceptInvitation(userId: string, staffId: string) {
    const phoneHash = await this.authz.getPhoneHash(userId);
    return this.uow.run(async () => {
      const invitation = phoneHash ? await this.repo.findInvitation(staffId, phoneHash, { forUpdate: true }) : undefined;
      if (!invitation) throw new NotFoundError('Invitation'); // not addressed to this user => indistinguishable from absent
      try {
        await this.repo.acceptInvitation(staffId, userId);
      } catch (err) {
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
          throw new ConflictError('STAFF_ALREADY_EXISTS', 'You are already staff at this location');
        }
        throw err;
      }
      await this.authz.grantRole(userId, ROLE_CODE[invitation.staff_role], { type: 'LOCATION', id: invitation.location_id }, userId);
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: 'provider.staff_invitation_accepted',
        entityType: 'provider_staff',
        entityId: staffId,
        after: { provider_id: invitation.provider_id, location_id: invitation.location_id, staff_role: invitation.staff_role },
      });
      return { id: staffId, provider_id: invitation.provider_id, location_id: invitation.location_id, staff_role: invitation.staff_role };
    });
  }

  async declineInvitation(userId: string, staffId: string): Promise<void> {
    const phoneHash = await this.authz.getPhoneHash(userId);
    await this.uow.run(async () => {
      const invitation = phoneHash ? await this.repo.findInvitation(staffId, phoneHash, { forUpdate: true }) : undefined;
      if (!invitation) throw new NotFoundError('Invitation');
      await this.repo.declineInvitation(staffId, this.clock.now());
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'provider.staff_invitation_declined', entityType: 'provider_staff', entityId: staffId });
    });
  }
}
