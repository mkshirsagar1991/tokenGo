import { Inject, Injectable } from '@nestjs/common';
import { PII_HASH_KEY, hmacSha256Hex } from '../../../shared-kernel';

/**
 * Deterministic keyed blind index of an E.164 phone number. Lets other modules match "this invited
 * phone" to "this logged-in user" without ever storing the raw number (docs §M.1, §N).
 */
@Injectable()
export class PhoneHasher {
  constructor(@Inject(PII_HASH_KEY) private readonly key: Buffer) {}

  hash(e164: string): string {
    return hmacSha256Hex(this.key, `phone:${e164}`);
  }
}
