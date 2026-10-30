import { randomInt } from 'node:crypto';
import { constantTimeEqualHex, hmacSha256Hex } from '../../../shared-kernel';

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * OTPs are low-entropy, so they are stored ONLY as a keyed hash (HMAC with a server-side secret),
 * bound to the challenge id so a hash cannot be replayed against another challenge.
 */
export function hashOtp(key: Buffer, challengeId: string, code: string): string {
  return hmacSha256Hex(key, `otp:${challengeId}:${code}`);
}

export function otpMatches(key: Buffer, challengeId: string, code: string, storedHash: string): boolean {
  return constantTimeEqualHex(hashOtp(key, challengeId, code), storedHash);
}
