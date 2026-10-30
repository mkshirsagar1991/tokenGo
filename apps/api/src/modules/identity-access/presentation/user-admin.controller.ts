import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Max, Min, MinLength } from 'class-validator';
import { UserAdminService, USER_STATUSES } from '../application/user-admin.service';
import { Actor, CurrentActor, RequirePlatformPermission } from './auth.decorators';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

class UserQueryDto {
  @IsOptional() @IsString() @MaxLength(40) query?: string;
  @IsOptional() @IsIn(USER_STATUSES) status?: string;
  @IsOptional() @IsString() @MaxLength(40) role?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(100) limit?: number;
}

class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

class RoleChangeDto {
  @IsString() @MaxLength(40) role_code!: string;
  @IsIn(['PLATFORM', 'PROVIDER', 'LOCATION']) scope_type!: 'PLATFORM' | 'PROVIDER' | 'LOCATION';
  @IsOptional() @IsUUID() scope_id?: string;
}

/** Account and role administration. Every route is permission-guarded server-side; all changes are audited. */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class UserAdminController {
  constructor(private readonly users: UserAdminService) {}

  @Get('users')
  @RequirePlatformPermission('user:read_any')
  list(@Query() q: UserQueryDto) {
    return this.users.list({ query: q.query, status: q.status, role: q.role, cursor: q.cursor, limit: q.limit ?? 25 });
  }

  @Get('users/:userId')
  @RequirePlatformPermission('user:read_any')
  async get(@Param('userId', uuid()) userId: string) {
    return { data: await this.users.get(userId) };
  }

  @Post('users/:userId/suspend')
  @HttpCode(200)
  @RequirePlatformPermission('user:suspend')
  async suspend(@CurrentActor() actor: Actor, @Param('userId', uuid()) userId: string, @Body() dto: ReasonDto) {
    return { data: await this.users.suspend(actor.userId, userId, dto.reason) };
  }

  @Post('users/:userId/reinstate')
  @HttpCode(200)
  @RequirePlatformPermission('user:suspend')
  async reinstate(@CurrentActor() actor: Actor, @Param('userId', uuid()) userId: string) {
    return { data: await this.users.reinstate(actor.userId, userId) };
  }

  @Get('roles')
  @RequirePlatformPermission('role:read')
  async roles() {
    return { data: await this.users.roleCatalog() };
  }

  @Post('users/:userId/roles')
  @HttpCode(200)
  @RequirePlatformPermission('role:assign')
  async assign(@CurrentActor() actor: Actor, @Param('userId', uuid()) userId: string, @Body() dto: RoleChangeDto) {
    return { data: await this.users.assignRole(actor.userId, userId, { roleCode: dto.role_code, scopeType: dto.scope_type, scopeId: dto.scope_id }) };
  }

  @Post('users/:userId/roles/revoke')
  @HttpCode(200)
  @RequirePlatformPermission('role:assign')
  async revoke(@CurrentActor() actor: Actor, @Param('userId', uuid()) userId: string, @Body() dto: RoleChangeDto) {
    return { data: await this.users.revokeRole(actor.userId, userId, { roleCode: dto.role_code, scopeType: dto.scope_type, scopeId: dto.scope_id }) };
  }
}
