import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Actor, CurrentActor, RequirePlatformPermission } from '../../identity-access';
import { SupportService } from '../application/support.service';

const uuid = () => new ParseUUIDPipe();
const num = () => Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));
const upload = () => FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 26_000_000, files: 1, fields: 2, parts: 4 } });

class DisputeDto {
  @IsDefined() category!: unknown;
  @IsDefined() message!: unknown;
}
class QuestionDto {
  @IsIn(['CUSTOMER', 'PROVIDER']) audience!: 'CUSTOMER' | 'PROVIDER';
  @IsOptional() @IsUUID() provider_id?: string;
  @IsOptional() @IsUUID() booking_id?: string;
  @IsDefined() category!: unknown;
  @IsDefined() subject!: unknown;
  @IsDefined() message!: unknown;
}
class MessageDto {
  @IsDefined() message!: unknown;
}
class MineQueryDto {
  @IsIn(['CUSTOMER', 'PROVIDER']) audience!: 'CUSTOMER' | 'PROVIDER';
  @IsOptional() @IsUUID() provider_id?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
}
class AdminQueryDto {
  @IsOptional() @IsIn(['OPEN', 'AWAITING_CUSTOMER', 'AWAITING_PROVIDER', 'IN_REVIEW', 'RESOLVED', 'CLOSED']) status?: string;
  @IsOptional() @IsIn(['QUESTION', 'DISPUTE']) kind?: string;
  @IsOptional() @IsIn(['me', 'none']) assigned?: 'me' | 'none';
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @num() @IsInt() @Min(1) @Max(50) limit?: number;
}
class AssignDto {
  @IsUUID() assignee_id!: string;
}
class AdminMessageDto {
  @IsDefined() message!: unknown;
  @IsOptional() internal?: boolean;
  @IsOptional() @IsIn(['CUSTOMER', 'PROVIDER', 'NONE']) awaiting?: 'CUSTOMER' | 'PROVIDER' | 'NONE';
}
class ResolveDto {
  @IsDefined() outcome!: unknown;
  @IsOptional() refund_minor?: unknown;
  @IsDefined() note!: unknown;
}
class CloseDto {
  @IsOptional() note?: unknown;
}

/** Sends evidence as a download; an uploaded file is untrusted content and is never rendered inline. */
function send(res: Response, f: { body: Buffer; contentType: string; fileName: string }) {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
  res.setHeader('Content-Length', String(f.body.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).end(f.body);
}

/** A customer disputes a completed booking. The booking's money is frozen until an administrator decides. */
@ApiTags('support')
@Controller({ path: 'appointments', version: '1' })
export class BookingDisputeController {
  constructor(private readonly support: SupportService) {}

  @Post(':id/dispute')
  async open(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: DisputeDto) {
    return { data: await this.support.openDispute(actor.userId, id, dto) };
  }
}

/** Cases as the people involved see them (customer, or the business). Staff-only notes are never included. */
@ApiTags('support')
@Controller({ path: 'support/cases', version: '1' })
export class SupportCaseController {
  constructor(private readonly support: SupportService) {}

  @Post()
  async open(@CurrentActor() actor: Actor, @Body() dto: QuestionDto) {
    return {
      data: await this.support.openQuestion(actor.userId, {
        audience: dto.audience,
        providerId: dto.provider_id,
        bookingId: dto.booking_id,
        category: dto.category,
        subject: dto.subject,
        message: dto.message,
      }),
    };
  }

  @Get()
  list(@CurrentActor() actor: Actor, @Query() q: MineQueryDto) {
    return this.support.listMine(actor.userId, { audience: q.audience, providerId: q.provider_id, status: q.status, cursor: q.cursor, limit: q.limit ?? 20 });
  }

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.support.get(actor.userId, id) };
  }

  @Post(':id/messages')
  async message(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: MessageDto) {
    return { data: await this.support.addMessage(actor.userId, id, dto.message) };
  }

  @Post(':id/attachments')
  @UseInterceptors(upload())
  async attach(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    return { data: await this.support.addAttachment(actor.userId, id, file) };
  }

  @Get(':id/attachments/:attachmentId')
  async download(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Param('attachmentId', uuid()) attachmentId: string, @Res() res: Response) {
    send(res, await this.support.downloadAttachment(actor.userId, id, attachmentId));
  }
}

/** The support workbench. Deciding a dispute needs `dispute:resolve`; above the operator limit it also needs `dispute:resolve_large`. */
@ApiTags('admin')
@Controller({ path: 'admin/support/cases', version: '1' })
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @RequirePlatformPermission('support:handle')
  list(@CurrentActor() actor: Actor, @Query() q: AdminQueryDto) {
    return this.support.adminList({ status: q.status, kind: q.kind, assigned: q.assigned, actorId: actor.userId, cursor: q.cursor, limit: q.limit ?? 25 });
  }

  @Get(':id')
  @RequirePlatformPermission('support:handle')
  async get(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string) {
    return { data: await this.support.adminGet(actor.userId, id) };
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePlatformPermission('support:handle')
  async assign(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: AssignDto) {
    return { data: await this.support.assign(actor.userId, id, dto.assignee_id) };
  }

  @Post(':id/messages')
  @RequirePlatformPermission('support:handle')
  async message(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: AdminMessageDto) {
    return { data: await this.support.adminMessage(actor.userId, id, { body: dto.message, internal: dto.internal, awaiting: dto.awaiting }) };
  }

  @Get(':id/attachments/:attachmentId')
  @RequirePlatformPermission('support:handle')
  async download(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Param('attachmentId', uuid()) attachmentId: string, @Res() res: Response) {
    send(res, await this.support.adminAttachment(actor.userId, id, attachmentId));
  }

  @Post(':id/resolve-dispute')
  @HttpCode(200)
  @RequirePlatformPermission('dispute:resolve')
  async resolve(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: ResolveDto) {
    return { data: await this.support.resolveDispute(actor.userId, id, { outcome: dto.outcome, refundMinor: dto.refund_minor, note: dto.note }) };
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePlatformPermission('support:handle')
  async close(@CurrentActor() actor: Actor, @Param('id', uuid()) id: string, @Body() dto: CloseDto) {
    return { data: await this.support.close(actor.userId, id, dto.note) };
  }
}
