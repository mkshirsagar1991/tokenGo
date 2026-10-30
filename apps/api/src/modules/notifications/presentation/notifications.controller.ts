import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Actor, CurrentActor } from '../../identity-access';
import { NotificationService } from '../application/notification.service';
import { CATEGORIES, Category } from '../domain/templates';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));
const bool = () => Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value));
const AUDIENCES = ['CUSTOMER', 'PROVIDER'] as const;

class ListDto {
  @IsIn(AUDIENCES) audience!: 'CUSTOMER' | 'PROVIDER';
  @IsOptional() @bool() @IsBoolean() unread?: boolean;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
}
class AudienceDto {
  @IsIn(AUDIENCES) audience!: 'CUSTOMER' | 'PROVIDER';
}
class RegisterDeviceDto {
  @IsIn(AUDIENCES) app!: 'CUSTOMER' | 'PROVIDER';
  @IsIn(['ANDROID', 'IOS']) platform!: 'ANDROID' | 'IOS';
  @IsString() @MaxLength(4096) token!: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
}
class UnregisterDeviceDto {
  @IsString() @MaxLength(4096) token!: string;
}
class PreferenceDto {
  @IsIn(CATEGORIES as unknown as string[]) category!: Category;
  @IsBoolean() push_enabled!: boolean;
}

/** The signed-in person's own notifications. Nothing here can read anyone else's. */
@ApiTags('notifications')
@Controller({ version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get('notifications')
  list(@CurrentActor() actor: Actor, @Query() q: ListDto) {
    return this.notifications.list(actor.userId, { audience: q.audience, unreadOnly: q.unread ?? false, cursor: q.cursor, limit: q.limit ?? 20 });
  }

  @Get('notifications/unread-count')
  async unreadCount(@CurrentActor() actor: Actor, @Query() q: AudienceDto) {
    return { data: { count: await this.notifications.unreadCount(actor.userId, q.audience) } };
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  async readAll(@CurrentActor() actor: Actor, @Body() dto: AudienceDto) {
    return { data: { updated: await this.notifications.markAllRead(actor.userId, dto.audience) } };
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  async read(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.notifications.markRead(actor.userId, id) };
  }

  @Get('notifications/preferences')
  async preferences(@CurrentActor() actor: Actor) {
    return { data: await this.notifications.preferences(actor.userId) };
  }

  @Put('notifications/preferences')
  @HttpCode(200)
  async setPreference(@CurrentActor() actor: Actor, @Body() dto: PreferenceDto) {
    return { data: await this.notifications.setPreference(actor.userId, dto.category, dto.push_enabled) };
  }

  @Post('devices')
  @HttpCode(200)
  async register(@CurrentActor() actor: Actor, @Body() dto: RegisterDeviceDto) {
    return { data: await this.notifications.registerDevice(actor.userId, dto) };
  }

  @Post('devices/unregister')
  @HttpCode(200)
  async unregister(@CurrentActor() actor: Actor, @Body() dto: UnregisterDeviceDto) {
    return { data: { unregistered: await this.notifications.unregisterDevice(actor.userId, dto.token) } };
  }
}
