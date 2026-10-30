import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { ValidationFailedError } from '../../../shared-kernel';
import { AdminAuthService } from '../application/admin-auth.service';
import { Public } from './auth.decorators';

class AdminLoginDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsString() @Length(1, 128) password!: string;
}

class MfaTokenDto {
  @IsString() @Length(20, 2000) mfa_token!: string;
}

class MfaCodeDto {
  @IsString() @Length(20, 2000) mfa_token!: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
  @IsOptional() @IsString() @MaxLength(100) device_id?: string;
}

class MfaVerifyDto {
  @IsString() @Length(20, 2000) mfa_token!: string;
  @IsOptional() @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-]{10,12}$/, { message: 'recovery_code has an invalid format' }) recovery_code?: string;
  @IsOptional() @IsString() @MaxLength(100) device_id?: string;
}

/**
 * Privileged-account sign-in: password -> TOTP. All routes are public (they ARE the login) but are
 * throttled per IP / e-mail / account, and return one generic error for every credential failure.
 */
@ApiTags('auth')
@Controller({ path: 'auth/admin', version: '1' })
export class AdminAuthController {
  constructor(private readonly admin: AdminAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.admin.login({ email: dto.email, password: dto.password, ip: req.ip ?? 'unknown' });
  }

  @Public()
  @Post('mfa/enroll')
  @HttpCode(200)
  enroll(@Body() dto: MfaTokenDto) {
    return this.admin.beginEnrollment(dto.mfa_token);
  }

  @Public()
  @Post('mfa/activate')
  @HttpCode(200)
  activate(@Body() dto: MfaCodeDto, @Req() req: Request) {
    return this.admin.activate({
      mfaToken: dto.mfa_token,
      code: dto.code,
      ip: req.ip ?? 'unknown',
      deviceId: dto.device_id,
      userAgent: req.header('user-agent'),
    });
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  verify(@Body() dto: MfaVerifyDto, @Req() req: Request) {
    if (!dto.code === !dto.recovery_code) {
      throw new ValidationFailedError('Provide exactly one of code or recovery_code');
    }
    return this.admin.verify({
      mfaToken: dto.mfa_token,
      code: dto.code,
      recoveryCode: dto.recovery_code,
      ip: req.ip ?? 'unknown',
      deviceId: dto.device_id,
      userAgent: req.header('user-agent'),
    });
  }
}
