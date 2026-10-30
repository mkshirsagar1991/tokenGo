import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { Actor, CurrentActor, RequirePlatformPermission } from '../../identity-access';
import { DocumentService } from '../application/document.service';

const uuid = () => new ParseUUIDPipe();

/** A hard ceiling for the multipart parser; the configured (smaller) limit is enforced by the service with a clear message. */
const upload = () => FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 26_000_000, files: 1, fields: 4, parts: 6 } });

class UploadDto {
  @IsOptional() @IsString() @MaxLength(40) doc_type?: string;
}
class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Sends a stored file as a download. Never rendered inline: an uploaded file is untrusted content. */
function send(res: Response, f: { body: Buffer; contentType: string; fileName: string }) {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
  res.setHeader('Content-Length', String(f.body.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).end(f.body);
}

/** A business manages its own verification documents. */
@ApiTags('providers')
@Controller({ path: 'providers/:providerId/documents', version: '1' })
export class ProviderDocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Post()
  @UseInterceptors(upload())
  async upload(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Body() dto: UploadDto, @UploadedFile() file: Express.Multer.File | undefined) {
    return { data: await this.documents.upload(actor.userId, providerId, { docType: dto.doc_type, file }) };
  }

  @Get()
  async list(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string) {
    return { data: await this.documents.list(actor.userId, providerId) };
  }

  @Get(':documentId/file')
  async file(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Param('documentId', uuid()) documentId: string, @Res() res: Response) {
    send(res, await this.documents.download(actor.userId, providerId, documentId));
  }

  @Delete(':documentId')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('providerId', uuid()) providerId: string, @Param('documentId', uuid()) documentId: string): Promise<void> {
    await this.documents.remove(actor.userId, providerId, documentId);
  }
}

/** Administrators review the documents of a business before approving it. Every view and decision is audited. */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminDocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Get('providers/:providerId/documents')
  @RequirePlatformPermission('document:review')
  async list(@Param('providerId', uuid()) providerId: string) {
    return { data: await this.documents.adminList(providerId) };
  }

  @Get('documents/:documentId/file')
  @RequirePlatformPermission('document:review')
  async file(@CurrentActor() actor: Actor, @Param('documentId', uuid()) documentId: string, @Res() res: Response) {
    send(res, await this.documents.adminDownload(actor.userId, documentId));
  }

  @Post('documents/:documentId/verify')
  @HttpCode(200)
  @RequirePlatformPermission('document:review')
  async verify(@CurrentActor() actor: Actor, @Param('documentId', uuid()) documentId: string, @Body() dto: NoteDto) {
    return { data: await this.documents.decide(actor.userId, documentId, 'VERIFIED', dto.note) };
  }

  @Post('documents/:documentId/reject')
  @HttpCode(200)
  @RequirePlatformPermission('document:review')
  async reject(@CurrentActor() actor: Actor, @Param('documentId', uuid()) documentId: string, @Body() dto: NoteDto) {
    return { data: await this.documents.decide(actor.userId, documentId, 'REJECTED', dto.note) };
  }
}
