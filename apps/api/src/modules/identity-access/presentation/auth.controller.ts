import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { NotFoundError } from '../../../shared-kernel';
import { AccountDeletionService } from '../application/account-deletion.service';
import { AuthService } from '../application/auth.service';
import { AuthorizationService } from '../application/authorization.service';
import { Actor, CurrentActor, Public } from './auth.decorators';
import { RefreshDto, RequestOtpDto, VerifyOtpDto } from './auth.dto';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(202)
  requestOtp(@Body() dto: RequestOtpDto, @Req() req: Request) {
    return this.auth.requestOtp({ phone: dto.phone, ip: req.ip ?? 'unknown', deviceId: dto.device_id, userAgent: req.header('user-agent') });
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.auth.verifyOtp({
      phone: dto.phone,
      code: dto.code,
      ip: req.ip ?? 'unknown',
      deviceId: dto.device_id,
      userAgent: req.header('user-agent'),
    });
  }

  @Public()
  @Post('token/refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: Actor): Promise<void> {
    await this.auth.logout(actor.userId, actor.sessionId);
  }

  @Get('sessions')
  async sessions(@CurrentActor() actor: Actor) {
    const rows = await this.auth.listSessions(actor.userId);
    return {
      data: rows.map((s) => ({
        id: s.id,
        device_id: s.device_id,
        created_at: s.created_at,
        last_used_at: s.last_used_at,
        current: s.id === actor.sessionId,
      })),
    };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    // Only the owner can revoke; a foreign/unknown id is indistinguishable (404) — no IDOR oracle.
    if (!(await this.auth.revokeSession(actor.userId, id))) throw new NotFoundError('Session');
  }
}

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private readonly auth: AuthService,
    private readonly authz: AuthorizationService,
    private readonly deletion: AccountDeletionService,
  ) {}

  /** The caller's own profile. Contains no raw PII: the phone number is masked. */
  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    const [phone, permissions] = await Promise.all([this.auth.getMaskedPhone(actor.userId), this.authz.listPermissions(actor.userId)]);
    return { data: { id: actor.userId, phone_masked: phone, permissions } };
  }

  /**
   * Ask to delete the account (requirements §5/§25). The account is deactivated immediately and the person is signed out
   * everywhere; signing in again within the grace period cancels the request, after which the account is anonymised. Refused,
   * with reasons, while anything still depends on it (an open booking, money in the wallet, an active business).
   */
  @Post('me/deletion-request')
  @HttpCode(200)
  async requestDeletion(@CurrentActor() actor: Actor) {
    return { data: await this.deletion.request(actor.userId) };
  }
}
