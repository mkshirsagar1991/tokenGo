import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../../shared-kernel';
import { Actor, CurrentActor, Public, RequirePlatformPermission } from '../../identity-access';
import { CategoryService } from '../application/category.service';
import { StaffSkillsService } from '../application/staff-skills.service';
import { ProviderCatalogService } from '../application/provider-catalog.service';
import {
  CreateCategoryDto,
  CreateProviderServiceDto,
  CreateServiceTypeDto,
  UpdateCategoryDto,
  UpdateProviderServiceDto,
  SetStaffSkillsDto,
  UpdateServiceTypeDto,
} from './catalog.dto';

const uuid = () => new ParseUUIDPipe();

/** Customer-facing, unauthenticated: the home screen can show categories before login. */
@ApiTags('categories')
@Controller({ path: 'categories', version: '1' })
export class PublicCatalogController {
  constructor(private readonly categories: CategoryService) {}

  @Public()
  @Get()
  async list() {
    return { data: await this.categories.listPublicCategories() };
  }

  @Public()
  @Get(':code/service-types')
  async serviceTypes(@Param('code') code: string) {
    return { data: await this.categories.listPublicServiceTypes(code) };
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/categories', version: '1' })
export class AdminCatalogController {
  constructor(private readonly categories: CategoryService) {}

  @Get()
  @RequirePlatformPermission('category:manage')
  async list() {
    return { data: await this.categories.adminList() };
  }

  @Post()
  @RequirePlatformPermission('category:manage')
  async create(@CurrentActor() actor: Actor, @Body() dto: CreateCategoryDto) {
    return {
      data: await this.categories.create(actor.userId, {
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        isActive: dto.is_active ?? false, // new verticals start DISABLED until an admin enables them
        bookingFlowType: dto.booking_flow_type ?? 'APPOINTMENT_SLOT',
        config: dto.config ?? {},
        sortOrder: dto.sort_order ?? 0,
      }),
    };
  }

  @Patch(':categoryId')
  @RequirePlatformPermission('category:manage')
  async update(@CurrentActor() actor: Actor, @Param('categoryId', uuid()) categoryId: string, @Body() dto: UpdateCategoryDto) {
    return {
      data: await this.categories.update(
        actor.userId,
        categoryId,
        { name: dto.name, description: dto.description, isActive: dto.is_active, config: dto.config, sortOrder: dto.sort_order },
        dto.expected_version,
      ),
    };
  }

  @Get(':categoryId/service-types')
  @RequirePlatformPermission('category:manage')
  async listServiceTypes(@Param('categoryId', uuid()) categoryId: string) {
    return { data: await this.categories.adminListServiceTypes(categoryId) };
  }

  @Post(':categoryId/service-types')
  @RequirePlatformPermission('category:manage')
  async createServiceType(@CurrentActor() actor: Actor, @Param('categoryId', uuid()) categoryId: string, @Body() dto: CreateServiceTypeDto) {
    return {
      data: await this.categories.createServiceType(actor.userId, categoryId, {
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        attributeSchema: dto.attribute_schema ?? {},
        sortOrder: dto.sort_order ?? 0,
      }),
    };
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/service-types', version: '1' })
export class AdminServiceTypeController {
  constructor(private readonly categories: CategoryService) {}

  @Patch(':serviceTypeId')
  @RequirePlatformPermission('category:manage')
  async update(@CurrentActor() actor: Actor, @Param('serviceTypeId', uuid()) serviceTypeId: string, @Body() dto: UpdateServiceTypeDto) {
    return {
      data: await this.categories.updateServiceType(actor.userId, serviceTypeId, {
        name: dto.name,
        description: dto.description,
        isActive: dto.is_active,
        sortOrder: dto.sort_order,
      }),
    };
  }
}

@ApiTags('providers')
@Controller({ path: 'providers/:providerId/services', version: '1' })
export class ProviderServicesController {
  constructor(private readonly services: ProviderCatalogService) {}

  @Post()
  @Idempotent()
  async create(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: CreateProviderServiceDto) {
    return {
      data: await this.services.create(actor.userId, providerId, {
        serviceTypeId: dto.service_type_id,
        name: dto.name,
        description: dto.description ?? null,
        priceMinor: dto.price_minor,
        currency: dto.currency ?? 'INR',
        durationMin: dto.duration_min,
        bufferMin: dto.buffer_min ?? 0,
        attributes: dto.attributes ?? {},
      }),
    };
  }

  @Get()
  async list(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.services.list(actor.userId, providerId) };
  }

  @Patch(':serviceId')
  async update(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('serviceId', uuid()) serviceId: string,
    @Body() dto: UpdateProviderServiceDto,
  ) {
    return {
      data: await this.services.update(actor.userId, providerId, serviceId, {
        name: dto.name,
        description: dto.description,
        priceMinor: dto.price_minor,
        durationMin: dto.duration_min,
        bufferMin: dto.buffer_min,
        isActive: dto.is_active,
        attributes: dto.attributes,
      }),
    };
  }

  @Delete(':serviceId')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('serviceId', uuid()) serviceId: string,
  ): Promise<void> {
    await this.services.remove(actor.userId, providerId, serviceId);
  }
}

@ApiTags('providers')
@Controller({ path: 'providers/:providerId/staff/:staffId/services', version: '1' })
export class StaffSkillsController {
  constructor(private readonly skills: StaffSkillsService) {}

  @Get()
  async get(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Param('staffId', uuid()) staffId: string) {
    return { data: await this.skills.get(actor.userId, providerId, staffId) };
  }

  /** Replaces the list. An empty list = generalist (can perform every service the provider offers). */
  @Put()
  async set(
    @CurrentActor() actor: Actor,
    @Param('providerId', uuid()) providerId: string,
    @Param('staffId', uuid()) staffId: string,
    @Body() dto: SetStaffSkillsDto,
  ) {
    return { data: await this.skills.set(actor.userId, providerId, staffId, dto.service_ids) };
  }
}
