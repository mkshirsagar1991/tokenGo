import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import {
  Clock,
  ConflictError,
  FIELD_CIPHER,
  FieldCipher,
  PII_HASH_KEY,
  UnauthenticatedError,
  UnitOfWork,
  ValidationFailedError,
  hmacSha256Hex,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { passwordProblems } from '../domain/password-policy';
import { maskPhone, normalizePhone } from '../domain/phone';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '../domain/totp';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { AuthService, AuthTokens, ClientContext } from './auth.service';
import { AuthorizationService } from './authorization.service';
import { PhoneHasher } from './phone-hasher';
import { RateLimiter } from './rate-limiter';
import { TokenService } from './token.service';

const LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60_000;
const RECOVERY_CODE_COUNT = 8;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// Argon2id, OWASP-recommended minimum profile (m=19 MiB, t=2, p=1).
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface LoginChallenge {
  status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  mfa_token: string;
  expires_in: number;
}

/**
 * Privileged-account authentication (requirements §4/§24): Argon2id password, then TOTP (or a single-use
 * recovery code). Roles flagged `requires_mfa` only take effect in a session that passed this flow.
 */
@Injectable()
export class AdminAuthService {
  /** Verified against when the e-mail is unknown, so response time does not reveal which e-mails exist. */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(PII_HASH_KEY) private readonly hashKey: Buffer,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    private readonly repo: IdentityRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly limiter: RateLimiter,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly authz: AuthorizationService,
    private readonly phones: PhoneHasher,
    private readonly audit: AuditService,
  ) {}

  private emailHash(email: string): string {
    return hmacSha256Hex(this.hashKey, `email:${email.trim().toLowerCase()}`);
  }

  private ipHash(ip: string): string {
    return hmacSha256Hex(this.hashKey, `ip:${ip}`);
  }

  private invalidCredentials(): UnauthenticatedError {
    return new UnauthenticatedError('Invalid e-mail or password', 'INVALID_CREDENTIALS');
  }

  // --- provisioning (CLI / controlled operation; there is deliberately NO public API) --------------------
  async createAdmin(input: { phone: string; email: string; password: string; roleCodes: string[] }): Promise<{ userId: string }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationFailedError('Invalid e-mail address', { fields: { email: ['is not a valid e-mail'] } });
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ValidationFailedError('Invalid phone number', { fields: { phone: ['must be a valid mobile number'] } });
    const problems = passwordProblems(input.password, { email });
    if (problems.length) throw new ValidationFailedError('Password does not meet the policy', { fields: { password: problems } });
    if (input.roleCodes.length === 0) throw new ValidationFailedError('At least one role is required');

    const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);

    return this.uow.run(async () => {
      const { user } = await this.repo.createUserIfAbsent(this.phones.hash(phone), this.cipher.encrypt(phone));
      if (await this.repo.findAdminCredentialsByUserId(user.id)) {
        throw new ConflictError('ADMIN_EXISTS', 'This user already has administrator credentials');
      }
      if (await this.repo.findAdminCredentialsByEmailHash(this.emailHash(email))) {
        throw new ConflictError('ADMIN_EMAIL_TAKEN', 'This e-mail is already registered to an administrator');
      }
      await this.repo.insertAdminCredentials({
        userId: user.id,
        emailHash: this.emailHash(email),
        emailEnc: this.cipher.encrypt(email),
        passwordHash,
      });
      for (const code of input.roleCodes) {
        await this.authz.grantRole(user.id, code, { type: 'PLATFORM' }, null);
      }
      await this.audit.record({
        actorType: 'SYSTEM',
        action: 'admin.account_created',
        entityType: 'user',
        entityId: user.id,
        after: { roles: input.roleCodes },
        metadata: { contact_masked: maskPhone(phone) },
      });
      return { userId: user.id };
    });
  }

  // --- step 1: password --------------------------------------------------------------------------------------
  async login(input: { email: string; password: string; ip: string }): Promise<LoginChallenge> {
    const emailHash = this.emailHash(input.email);
    await this.limiter.consume(`admin:login:ip:${this.ipHash(input.ip)}`, 30, 900);
    await this.limiter.consume(`admin:login:email:${emailHash}`, 20, 900);

    const now = this.clock.now();
    type Outcome = { ok: true; userId: string; enrolled: boolean } | { ok: false };

    // Counters/locks must persist even though the request fails, so the transaction RETURNS a verdict.
    const outcome: Outcome = await this.uow.run(async (): Promise<Outcome> => {
      const creds = await this.repo.findAdminCredentialsByEmailHash(emailHash, { forUpdate: true });
      if (!creds) {
        await argon2.verify(await this.getDummyHash(), input.password).catch(() => false);
        return { ok: false };
      }
      const locked = creds.locked_until !== null && creds.locked_until > now;
      const passwordOk = await argon2.verify(creds.password_hash, input.password).catch(() => false);
      if (locked || !passwordOk) {
        if (!locked) {
          const { locked: justLocked } = await this.repo.registerFailedLogin(creds.user_id, now, LOCK_THRESHOLD, LOCK_MS);
          await this.audit.record({
            actorType: 'SYSTEM',
            actorId: creds.user_id,
            action: justLocked ? 'admin.account_locked' : 'admin.login_failed',
            entityType: 'user',
            entityId: creds.user_id,
          });
        }
        return { ok: false };
      }
      const user = await this.repo.findUserById(creds.user_id);
      if (!user || user.status !== 'ACTIVE') return { ok: false };
      await this.repo.resetFailedLogins(creds.user_id);
      return { ok: true, userId: creds.user_id, enrolled: creds.mfa_enabled_at !== null };
    });

    if (!outcome.ok) throw this.invalidCredentials();
    return {
      status: outcome.enrolled ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
      mfa_token: this.tokens.signMfaToken(outcome.userId),
      expires_in: 300,
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(randomBytes(16).toString('hex'), ARGON_OPTIONS);
    return this.dummyHash;
  }

  // --- step 2a: first-time enrolment ------------------------------------------------------------------------
  async beginEnrollment(mfaToken: string): Promise<{ secret_base32: string; otpauth_uri: string }> {
    const userId = this.tokens.verifyMfaToken(mfaToken);
    return this.uow.run(async () => {
      const creds = await this.repo.findAdminCredentialsByUserId(userId, { forUpdate: true });
      if (!creds) throw new UnauthenticatedError('Invalid MFA token', 'MFA_TOKEN_INVALID');
      if (creds.mfa_enabled_at) throw new ConflictError('MFA_ALREADY_ENROLLED', 'MFA is already enabled for this account');
      const secret = generateTotpSecret();
      await this.repo.setPendingMfaSecret(userId, this.cipher.encrypt(base32Encode(secret)));
      const email = this.cipher.decrypt(creds.email_enc);
      return { secret_base32: base32Encode(secret), otpauth_uri: otpauthUri(secret, email) };
    });
  }

  /** Confirms the first code from the authenticator app, enables MFA, issues recovery codes + a session. */
  async activate(input: { mfaToken: string; code: string } & ClientContext): Promise<AuthTokens & { recovery_codes: string[] }> {
    const userId = this.tokens.verifyMfaToken(input.mfaToken);
    await this.limiter.consume(`admin:mfa:user:${userId}`, 10, 900);
    const now = this.clock.now();

    type Outcome = { ok: false } | { ok: true; tokens: AuthTokens; recoveryCodes: string[] };
    const outcome: Outcome = await this.uow.run(async (): Promise<Outcome> => {
      const creds = await this.repo.findAdminCredentialsByUserId(userId, { forUpdate: true });
      if (!creds || creds.mfa_enabled_at || !creds.mfa_secret_enc) return { ok: false };
      const secret = this.decodeSecret(creds.mfa_secret_enc);
      const step = verifyTotp(secret, input.code, now.getTime(), null);
      if (step === null) return { ok: false };

      await this.repo.activateMfa(userId, now, step);
      const recoveryCodes = this.generateRecoveryCodes();
      await this.repo.replaceRecoveryCodes(
        userId,
        recoveryCodes.map((c) => this.recoveryHash(c)),
      );
      const tokens = await this.auth.startSession(userId, now, input, { mfaVerified: true });
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'admin.mfa_enabled', entityType: 'user', entityId: userId });
      return { ok: true, tokens, recoveryCodes };
    });
    if (!outcome.ok) throw new UnauthenticatedError('Invalid verification code', 'MFA_INVALID');
    return { ...outcome.tokens, recovery_codes: outcome.recoveryCodes };
  }

  // --- step 2b: every later login ---------------------------------------------------------------------------
  async verify(input: { mfaToken: string; code?: string; recoveryCode?: string } & ClientContext): Promise<AuthTokens> {
    const userId = this.tokens.verifyMfaToken(input.mfaToken);
    await this.limiter.consume(`admin:mfa:user:${userId}`, 10, 900);
    const now = this.clock.now();

    const ok: boolean = await this.uow.run(async () => {
      const creds = await this.repo.findAdminCredentialsByUserId(userId, { forUpdate: true });
      if (!creds || !creds.mfa_enabled_at || !creds.mfa_secret_enc) return false;

      let passed = false;
      let usedRecovery = false;
      if (input.code) {
        const last = creds.mfa_last_step === null ? null : Number(creds.mfa_last_step);
        const step = verifyTotp(this.decodeSecret(creds.mfa_secret_enc), input.code, now.getTime(), last);
        passed = step !== null && (await this.repo.advanceMfaStep(userId, step));
      } else if (input.recoveryCode) {
        passed = await this.repo.consumeRecoveryCode(userId, this.recoveryHash(input.recoveryCode), now);
        usedRecovery = passed;
      }
      if (!passed) {
        await this.audit.record({ actorType: 'SYSTEM', actorId: userId, action: 'admin.mfa_failed', entityType: 'user', entityId: userId });
        return false;
      }
      if (usedRecovery) {
        await this.audit.record({
          actorType: 'USER',
          actorId: userId,
          action: 'admin.mfa_recovery_code_used',
          entityType: 'user',
          entityId: userId,
          metadata: { remaining: await this.repo.countUnusedRecoveryCodes(userId) },
        });
      }
      return true;
    });
    if (!ok) throw new UnauthenticatedError('Invalid verification code', 'MFA_INVALID');

    return this.uow.run(async () => {
      const tokens = await this.auth.startSession(userId, now, input, { mfaVerified: true });
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'admin.login', entityType: 'user', entityId: userId });
      return tokens;
    });
  }

  // --- helpers --------------------------------------------------------------------------------------------------
  /** The TOTP secret is stored AES-GCM-encrypted, as its base32 text. */
  private decodeSecret(enc: Buffer): Buffer {
    return base32Decode(this.cipher.decrypt(enc));
  }

  private generateRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = base32Encode(randomBytes(7)).slice(0, 10); // 50 bits of entropy
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
  }

  private recoveryHash(code: string): string {
    return hmacSha256Hex(this.hashKey, `recovery:${code.replace(/[-\s]/g, '').toUpperCase()}`);
  }
}
