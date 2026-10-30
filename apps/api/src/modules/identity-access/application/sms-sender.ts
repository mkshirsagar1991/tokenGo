import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { DomainError, LOGGER } from '../../../shared-kernel';
import { maskPhone } from '../domain/phone';

/** SMS/OTP provider abstraction (requirements §3). A real, DLT-registered adapter is added before launch. */
export abstract class SmsSender {
  abstract sendOtp(toE164: string, code: string, ttlSeconds: number): Promise<void>;
}

/**
 * DEVELOPMENT ONLY. Prints the OTP so a developer can log in without an SMS gateway. Config validation
 * refuses SMS_PROVIDER=console when NODE_ENV=production (see shared-kernel/config.ts).
 */
@Injectable()
export class ConsoleSmsSender extends SmsSender {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {
    super();
  }

  async sendOtp(toE164: string, code: string, ttlSeconds: number): Promise<void> {
    this.logger.warn(`[DEV SMS] OTP for ${maskedOnly(toE164)}: ${code} (valid ${ttlSeconds}s)`);
  }
}

/**
 * DEVELOPMENT ONLY. Sends everything through `real`, EXCEPT numbers on the log-only list, whose codes are printed in the log like the
 * console sender does. This keeps the seeded demo accounts usable while a real SMS gateway is configured, and (more importantly) stops
 * a tap on a demo number from texting whoever happens to own it. Config refuses a non-empty list in production.
 */
export class LogOnlyRoutingSmsSender extends SmsSender {
  constructor(
    private readonly real: SmsSender,
    private readonly console: SmsSender,
    private readonly logOnly: ReadonlySet<string>,
  ) {
    super();
  }

  sendOtp(toE164: string, code: string, ttlSeconds: number): Promise<void> {
    return (this.logOnly.has(toE164) ? this.console : this.real).sendOtp(toE164, code, ttlSeconds);
  }
}

@Injectable()
export class DisabledSmsSender extends SmsSender {
  async sendOtp(): Promise<void> {
    throw new DomainError('SMS_UNAVAILABLE', 'SMS delivery is not configured', 503);
  }
}

function maskedOnly(e164: string): string {
  return maskPhone(e164);
}
