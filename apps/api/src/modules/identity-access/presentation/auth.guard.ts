import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Clock, DomainError, ForbiddenError, UnauthenticatedError, setActor } from '../../../shared-kernel';
import { AuthorizationService } from '../application/authorization.service';
import { TokenService } from '../application/token.service';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { Actor, IS_PUBLIC, PLATFORM_PERMISSION } from './auth.decorators';

/**
 * Global guard: every route requires a valid access token unless marked @Public().
 * Beyond verifying the JWT it checks, on EVERY request, that the session is not revoked and the user
 * is still ACTIVE — so logout, session revocation and account suspension take effect immediately
 * rather than after the access token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly repo: IdentityRepository,
    private readonly authz: AuthorizationService,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const header = req.header('authorization');
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) throw new UnauthenticatedError();

    const claims = this.tokens.verifyAccessToken(match[1]);
    const principal = await this.repo.getSessionPrincipal(claims.sid, this.clock.now());
    if (!principal || principal.revoked_at || principal.user_id !== claims.sub) {
      throw new UnauthenticatedError('Session is no longer valid', 'SESSION_REVOKED');
    }
    if (principal.status !== 'ACTIVE') throw new DomainError('ACCOUNT_DISABLED', 'This account is not active', 403);

    req.actor = { userId: claims.sub, sessionId: claims.sid };
    setActor(claims.sub, { mfaVerified: principal.mfa_verified_at !== null });

    const required = this.reflector.getAllAndOverride<string | undefined>(PLATFORM_PERMISSION, targets);
    if (required && !(await this.authz.can(claims.sub, required))) {
      // Distinguish "you are an admin but this session skipped MFA" from a plain lack of permission.
      if (await this.authz.isMissingMfa(claims.sub)) {
        throw new DomainError('MFA_REQUIRED', 'Multi-factor authentication is required for this action', 403);
      }
      throw new ForbiddenError();
    }
    return true;
  }
}
