import { Injectable } from '@nestjs/common';
import { Clock, TooManyRequestsError } from '../../../shared-kernel';
import { IdentityRepository } from '../infrastructure/identity.repository';

/**
 * Postgres-backed fixed-window limiter for correctness-critical, low-volume paths (OTP, login).
 * Coarse per-IP limiting for everything else lives at AWS WAF (docs §B.1: no Redis in v1).
 */
@Injectable()
export class RateLimiter {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly clock: Clock,
  ) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    const nowMs = this.clock.now().getTime();
    const windowMs = windowSeconds * 1000;
    const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
    const count = await this.repo.hitRateLimit(key, windowStart);
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - nowMs) / 1000));
      throw new TooManyRequestsError('Too many requests, please try again later', retryAfter);
    }
  }
}
