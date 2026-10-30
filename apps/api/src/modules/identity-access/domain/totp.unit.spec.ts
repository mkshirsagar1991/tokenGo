import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpStep, verifyTotp } from './totp';
import { passwordProblems } from './password-policy';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // RFC 4226 Appendix D: secret "12345678901234567890", HOTP counters 0..9
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');

  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(rfcSecret, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vector at T=59s (8 digits 94287082 -> 6 digits 287082)', () => {
    expect(hotp(rfcSecret, totpStep(59_000), 8)).toBe('94287082');
    expect(hotp(rfcSecret, totpStep(59_000))).toBe('287082');
    expect(hotp(rfcSecret, totpStep(1_111_111_109_000), 8)).toBe('07081804');
  });

  it('base32 round-trips and matches the RFC 4648 vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const s = generateTotpSecret();
    expect(base32Decode(base32Encode(s)).equals(s)).toBe(true);
    expect(() => base32Decode('NOT*BASE32')).toThrow();
  });

  describe('verifyTotp', () => {
    const at = 1_700_000_000_000;
    const code = (offsetSteps: number) => hotp(rfcSecret, totpStep(at) + offsetSteps);

    it('accepts the current step and ±1 step of drift, returning the matched step', () => {
      expect(verifyTotp(rfcSecret, code(0), at)).toBe(totpStep(at));
      expect(verifyTotp(rfcSecret, code(-1), at)).toBe(totpStep(at) - 1);
      expect(verifyTotp(rfcSecret, code(1), at)).toBe(totpStep(at) + 1);
    });

    it('rejects codes outside the window and malformed input', () => {
      expect(verifyTotp(rfcSecret, code(2), at)).toBeNull();
      expect(verifyTotp(rfcSecret, code(-2), at)).toBeNull();
      expect(verifyTotp(rfcSecret, '12345', at)).toBeNull();
      expect(verifyTotp(rfcSecret, 'abcdef', at)).toBeNull();
      expect(verifyTotp(rfcSecret, '', at)).toBeNull();
    });

    it('refuses to accept the same time-step twice (replay protection)', () => {
      const step = verifyTotp(rfcSecret, code(0), at);
      expect(step).not.toBeNull();
      expect(verifyTotp(rfcSecret, code(0), at, step)).toBeNull();
      expect(verifyTotp(rfcSecret, code(-1), at, step)).toBeNull(); // older than last accepted
      expect(verifyTotp(rfcSecret, code(1), at, step)).toBe(totpStep(at) + 1); // strictly newer is fine
    });
  });

  it('builds a standards-conformant otpauth URI', () => {
    const uri = otpauthUri(rfcSecret, 'admin@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/TokenGo%3Aadmin%40example\.com\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=TokenGo/);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    expect(passwordProblems('correct horse battery staple')).toEqual([]);
  });
  it('rejects short, repeated, common and e-mail-derived passwords', () => {
    expect(passwordProblems('short')).toContain('must be at least 12 characters');
    expect(passwordProblems('aaaaaaaaaaaaaa')).toContain('must not be a single repeated character');
    expect(passwordProblems('Password1234')).toContain('is too common');
    expect(passwordProblems('mukesh-is-here-1', { email: 'mukesh@valethi.com' })).toContain('must not contain your e-mail name');
    expect(passwordProblems('x'.repeat(129))).toContain('must be at most 128 characters');
  });
});
