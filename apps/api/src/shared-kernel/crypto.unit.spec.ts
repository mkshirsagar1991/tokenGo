import { randomBytes } from 'node:crypto';
import { FieldCipher, constantTimeEqualHex, hmacSha256Hex, randomToken, sha256Hex } from './crypto';

describe('FieldCipher (AES-256-GCM)', () => {
  const cipher = new FieldCipher(randomBytes(32));

  it('round-trips and never repeats ciphertext for the same plaintext', () => {
    const a = cipher.encrypt('+919876543210');
    const b = cipher.encrypt('+919876543210');
    expect(cipher.decrypt(a)).toBe('+919876543210');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('utf8')).not.toContain('9876543210');
  });

  it('detects tampering and wrong keys', () => {
    const blob = cipher.encrypt('secret');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(tampered)).toThrow();
    expect(() => new FieldCipher(randomBytes(32)).decrypt(blob)).toThrow();
    expect(() => cipher.decrypt(Buffer.from([0x02, 1, 2, 3]))).toThrow(/Unsupported or corrupt/);
  });

  it('requires a 32-byte key', () => {
    expect(() => new FieldCipher(randomBytes(16))).toThrow();
  });
});

describe('hashing helpers', () => {
  it('HMAC is keyed and deterministic', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    expect(hmacSha256Hex(k1, '+91999')).toBe(hmacSha256Hex(k1, '+91999'));
    expect(hmacSha256Hex(k1, '+91999')).not.toBe(hmacSha256Hex(k2, '+91999'));
  });

  it('constant-time compare', () => {
    const h = sha256Hex('x');
    expect(constantTimeEqualHex(h, sha256Hex('x'))).toBe(true);
    expect(constantTimeEqualHex(h, sha256Hex('y'))).toBe(false);
    expect(constantTimeEqualHex(h, 'abcd')).toBe(false);
    expect(constantTimeEqualHex('', '')).toBe(false);
  });

  it('random tokens are long and distinct', () => {
    const a = randomToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(randomToken());
  });
});
