import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../../shared-kernel';
import { Actor, CurrentActor, RequirePlatformPermission } from '../../identity-access';
import { LocationService } from '../application/location.service';
import { ProviderService } from '../application/provider.service';
import { StaffService } from '../application/staff.service';
import {
  AdminProviderQueryDto,
  CreateStaffDto,
  LocationDto,
  ReasonDto,
  RegisterProviderDto,
  StaffQueryDto,
  UpdateLocationDto,
  UpdateProviderDto,
  UpdateStaffDto,
} from './provider.dto';

const uuid = () => new ParseUUIDPipe();

@ApiTags('providers')
@Controller({ path: 'providers', version: '1' })
export class ProviderController {
  constructor(
    private readonly providers: ProviderService,
    private readonly locations: LocationService,
    private readonly staff: StaffService,
  ) {}

  // --- business profile -------------------------------------------------------------------------------
  @Post()
  @Idempotent()
  async register(@CurrentActor() actor: Actor, @Body() dto: RegisterProviderDto) {
    return { data: await this.providers.register(actor.userId, { displayName: dto.display_name, description: dto.description ?? null }) };
  }

  @Get('mine')
  async mine(@CurrentActor() actor: Actor) {
    return { data: await this.providers.listMine(actor.userId) };
  }

  @Get(':providerId')
  async get(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.providers.get(actor.userId, providerId) };
  }

  @Patch(':providerId')
  async update(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: UpdateProviderDto) {
    return {
      data: await this.providers.update(actor.userId, providerId, { displayName: dto.display_name, description: dto.description }),
    };
  }

  /** Command endpoint: moves DRAFT/REJECTED -> SUBMITTED. There is no generic "set status". */
  @Post(':providerId/submit')
  @HttpCode(200)
  async submit(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.providers.submit(actor.userId, providerId) };
  }

  // --- locations -------------------------------------------------------------------------------------------
  @Post(':providerId/locations')
  @Idempotent()
  async createLocation(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: LocationDto) {
    return {
      data: await this.locations.create(actor.userId, providerId, {
        name: dto.name,
        addressLine1: dto.address_line1,
        addressLine2: dto.address_line2 ?? null,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postal_code,
        country: dto.country ?? 'IN',
        latitude: dto.latitude,
        longitude: dto.longitude,
        timezone: dto.timezone ?? 'Asia/Kolkata',
      }),
    };
  }

  @Get(':providerId/locations')
  async listLocations(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.locations.list(actor.userId, providerId) };
  }

  @Patch(':providerId/locations/:locationId')
  async updateLocation(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('locationId', uuid()) locationId: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return {
      data: await this.locations.update(actor.userId, providerId, locationId, {
        name: dto.name,
        addressLine1: dto.address_line1,
        addressLine2: dto.address_line2,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postal_code,
        latitude: dto.latitude,
        longitude: dto.longitude,
        timezone: dto.timezone,
        status: dto.status,
      }),
    };
  }

  @Delete(':providerId/locations/:locationId')
  @HttpCode(204)
  async deleteLocation(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('locationId', uuid()) locationId: string,
  ): Promise<void> {
    await this.locations.remove(actor.userId, providerId, locationId);
  }

  // --- staff --------------------------------------------------------------------------------------------------
  @Post(':providerId/staff')
  @Idempotent()
  async createStaff(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: CreateStaffDto) {
    return {
      data: await this.staff.create(actor.userId, providerId, {
        locationId: dto.location_id,
        displayName: dto.display_name,
        staffRole: dto.staff_role ?? 'STAFF',
        phone: dto.phone,
      }),
    };
  }

  @Get(':providerId/staff')
  async listStaff(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Query() q: StaffQueryDto) {
    return { data: await this.staff.list(actor.userId, providerId, q.location_id) };
  }

  @Patch(':providerId/staff/:staffId')
  async updateStaff(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('staffId', uuid()) staffId: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return { data: await this.staff.update(actor.userId, providerId, staffId, { displayName: dto.display_name, staffRole: dto.staff_role }) };
  }

  @Delete(':providerId/staff/:staffId')
  @HttpCode(204)
  async deleteStaff(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('staffId', uuid()) staffId: string,
  ): Promise<void> {
    await this.staff.remove(actor.userId, providerId, staffId);
  }
}

/** The invitee's side: staff are never silently attached to an account — they must accept. */
@ApiTags('providers')
@Controller({ path: 'users/me/staff-invitations', version: '1' })
export class StaffInvitationController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  async list(@CurrentActor() actor: Actor) {
    return { data: await this.staff.listMyInvitations(actor.userId) };
  }

  @Post(':staffId/accept')
  @HttpCode(200)
  async accept(@CurrentActor() actor: Actor, @Param('staffId', uuid()) staffId: string) {
    return { data: await this.staff.acceptInvitation(actor.userId, staffId) };
  }

  @Post(':staffId/decline')
  @HttpCode(204)
  async decline(@CurrentActor() actor: Actor, @Param('staffId', uuid()) staffId: string): Promise<void> {
    await this.staff.declineInvitation(actor.userId, staffId);
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/providers', version: '1' })
export class AdminProviderController {
  constructor(private readonly providers: ProviderService) {}

  @Get()
  @RequirePlatformPermission('provider:read_any')
  list(@Query() q: AdminProviderQueryDto) {
    return this.providers.adminList({ status: q.status, cursor: q.cursor, limit: q.limit ?? 20 });
  }

  @Get(':providerId')
  @RequirePlatformPermission('provider:read_any')
  async get(@Param('providerId', uuid()) providerId: string) {
    return { data: await this.providers.adminGet(providerId) };
  }

  @Post(':providerId/start-review')
  @HttpCode(200)
  @RequirePlatformPermission('provider:verify')
  async startReview(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.providers.decide(actor.userId, providerId, 'START_REVIEW') };
  }

  @Post(':providerId/approve')
  @HttpCode(200)
  @RequirePlatformPermission('provider:verify')
  async approve(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.providers.decide(actor.userId, providerId, 'APPROVE') };
  }

  @Post(':providerId/reject')
  @HttpCode(200)
  @RequirePlatformPermission('provider:verify')
  async reject(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: ReasonDto) {
    return { data: await this.providers.decide(actor.userId, providerId, 'REJECT', dto.reason) };
  }

  @Post(':providerId/suspend')
  @HttpCode(200)
  @RequirePlatformPermission('provider:suspend')
  async suspend(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: ReasonDto) {
    return { data: await this.providers.decide(actor.userId, providerId, 'SUSPEND', dto.reason) };
  }

  @Post(':providerId/reinstate')
  @HttpCode(200)
  @RequirePlatformPermission('provider:suspend')
  async reinstate(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.providers.decide(actor.userId, providerId, 'REINSTATE') };
  }
}

