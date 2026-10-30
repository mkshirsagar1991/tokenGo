import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export interface Actor {
  userId: string;
  sessionId: string;
}

export const IS_PUBLIC = 'tokengo:is_public';
export const PLATFORM_PERMISSION = 'tokengo:platform_permission';

/** Opt a route OUT of authentication. Everything else is authenticated by default (secure by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Require a PLATFORM-scoped permission (e.g. `category:manage`) before the handler runs. */
export const RequirePlatformPermission = (permission: string) => SetMetadata(PLATFORM_PERMISSION, permission);

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
  if (!req.actor) throw new Error('CurrentActor used on an unauthenticated route');
  return req.actor;
});
