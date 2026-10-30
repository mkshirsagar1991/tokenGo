import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, AppConfig, LOGGER } from '../../shared-kernel';
import type { Logger } from 'pino';
import { AuditModule } from '../audit';
import { AccountDeletionService } from './application/account-deletion.service';
import { AdminAuthService } from './application/admin-auth.service';
import { AuthService } from './application/auth.service';
import { AuthorizationService } from './application/authorization.service';
import { AccountDeletionDueConsumer } from './application/identity.consumers';
import { PhoneHasher } from './application/phone-hasher';
import { RateLimiter } from './application/rate-limiter';
import { SmsSender } from './application/sms-sender';
import { buildSmsSender } from './application/sms-sender.factory';
import { TokenService } from './application/token.service';
import { UserAdminService } from './application/user-admin.service';
import { IdentityRepository } from './infrastructure/identity.repository';
import { AdminAuthController } from './presentation/admin-auth.controller';
import { AuthController, UsersController } from './presentation/auth.controller';
import { AuthGuard } from './presentation/auth.guard';
import { UserAdminController } from './presentation/user-admin.controller';

@Module({
  imports: [AuditModule],
  controllers: [AuthController, UsersController, AdminAuthController, UserAdminController],
  providers: [
    IdentityRepository,
    PhoneHasher,
    RateLimiter,
    TokenService,
    AuthService,
    AdminAuthService,
    AuthorizationService,
    AccountDeletionService,
    UserAdminService,
    AccountDeletionDueConsumer,
    {
      provide: SmsSender,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger) => buildSmsSender(config, logger),
    },
    // Secure by default: every route is authenticated unless it opts out with @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthorizationService, AdminAuthService, PhoneHasher, TokenService, SmsSender],
})
export class IdentityAccessModule {}
