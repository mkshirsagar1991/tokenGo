import { AccountDeletionService } from './account-deletion.service';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  AppConfig,
  Clock,
  DomainError,
  FIELD_CIPHER,
  FieldCipher,
  PII_HASH_KEY,
  TooManyRequestsError,
  UnauthenticatedError,
  UnitOfWork,
  ValidationFailedError,
  hmacSha256Hex,
  uuidv7,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { generateOtpCode, hashOtp, otpMatches } from '../domain/otp';
import { maskPhone, normalizePhone } from '../domain/phone';
import { IdentityRepository } from '../infrastructure/identity.repository';
import { PhoneHasher } from './phone-hasher';
import { RateLimiter } from './rate-limiter';
import { SmsSender } from './sms-sender';
import { TokenService } from './token.service';

const HOUR = 3600;
/** A refresh token presented again this soon after rotation is treated as a client retry, not theft. */
const REFRESH_REUSE_GRACE_MS = 10_000;

export interface ClientContext {
  ip: string;
  deviceId?: string | null;
  userAgent?: string | null;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PII_HASH_KEY) private readonly hashKey: Buffer,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    private readonly repo: IdentityRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly limiter: RateLimiter,
    private readonly tokens: TokenService,
    private readonly sms: SmsSender,
    private readonly audit: AuditService,
    private readonly phones: PhoneHasher,
    private readonly deletion: AccountDeletionService,
  ) {}

  phoneHash(e164: string): string {
    return this.phones.hash(e164);
  }

  private ipHash(ip: string): string {
    return hmacSha256Hex(this.hashKey, `ip:${ip}`);
  }

  // ---------------------------------------------------------------------------------------------
  async requestOtp(input: { phone: string } & ClientContext): Promise<{
    challenge_id: string;
    expires_in_seconds: number;
    resend_after_seconds: number;
  }> {
    const e164 = normalizePhone(input.phone);
    if (!e164) throw new ValidationFailedError('Invalid phone number', { fields: { phone: ['must be a valid mobile number'] } });

    const phoneHash = this.phoneHash(e164);
    const otp = this.config.otp;

    // Throttles run BEFORE any work and persist even when the request is rejected.
    await this.limiter.consume(`otp:req:phone:${phoneHash}`, otp.maxPerPhonePerHour, HOUR);
    await this.limiter.consume(`otp:req:ip:${this.ipHash(input.ip)}`, otp.maxPerIpPerHour, HOUR);

    const now = this.clock.now();
    const last = await this.repo.lastChallengeCreatedAt(phoneHash);
    if (last && otp.resendCooldownSeconds > 0) {
      const waitMs = last.getTime() + otp.resendCooldownSeconds * 1000 - now.getTime();
      if (waitMs > 0) throw new TooManyRequestsError('Please wait before requesting another code', Math.ceil(waitMs / 1000));
    }

    const code = generateOtpCode();
    const challengeId = uuidv7();
    await this.uow.run(async () => {
      await this.repo.invalidateOpenChallenges(phoneHash, now); // only the newest code is ever valid
      await this.repo.insertChallenge({
        id: challengeId,
        phoneHash,
        codeHash: hashOtp(this.hashKey, challengeId, code),
        createdAt: now,
        expiresAt: new Date(now.getTime() + otp.ttlSeconds * 1000),
        maxAttempts: otp.maxAttempts,
        ipHash: this.ipHash(input.ip),
        deviceId: input.deviceId ?? null,
      });
    });

    // External side effect strictly AFTER commit; a failure invalidates the code we could not deliver.
    try {
      await this.sms.sendOtp(e164, code, otp.ttlSeconds);
    } catch (err) {
      await this.repo.invalidateOpenChallenges(phoneHash, this.clock.now());
      if (err instanceof DomainError) throw err;
      throw new DomainError('SMS_DELIVERY_FAILED', 'Could not deliver the verification code', 502);
    }

    return { challenge_id: challengeId, expires_in_seconds: otp.ttlSeconds, resend_after_seconds: otp.resendCooldownSeconds };
  }

  // ---------------------------------------------------------------------------------------------
  async verifyOtp(
    input: { phone: string; code: string } & ClientContext,
  ): Promise<AuthTokens & { user: { id: string; is_new: boolean; account_restored: boolean } }> {
    const invalid = () => new UnauthenticatedError('Invalid or expired code', 'OTP_INVALID');
    const e164 = normalizePhone(input.phone);
    if (!e164) throw invalid();
    const phoneHash = this.phoneHash(e164);

    await this.limiter.consume(`otp:verify:phone:${phoneHash}`, 20, HOUR);
    await this.limiter.consume(`otp:verify:ip:${this.ipHash(input.ip)}`, 100, HOUR);

    const now = this.clock.now();

    type Outcome =
      | { kind: 'REJECTED' }
      | { kind: 'DISABLED' }
      | { kind: 'OK'; tokens: AuthTokens; userId: string; isNew: boolean; restored: boolean };

    const outcome: Outcome = await this.uow.run(async (): Promise<Outcome> => {
      const challenge = await this.repo.lockLatestOpenChallenge(phoneHash, now);
      if (!challenge || challenge.attempts >= challenge.max_attempts) return { kind: 'REJECTED' };

      if (!otpMatches(this.hashKey, challenge.id, input.code, challenge.code_hash)) {
        await this.repo.recordFailedAttempt(challenge.id); // committed: we RETURN, we do not throw
        return { kind: 'REJECTED' };
      }
      await this.repo.consumeChallenge(challenge.id, now);

      const { user, created } = await this.repo.createUserIfAbsent(phoneHash, this.cipher.encrypt(e164));
      // Coming back during the deletion grace period cancels the deletion; any other non-active account stays locked out.
      let restored = false;
      if (user.status === 'DEACTIVATED') restored = await this.deletion.restoreOnLogin(user.id);
      if (user.status !== 'ACTIVE' && !restored) return { kind: 'DISABLED' };

      const customerRole = await this.repo.findRoleByCode('CUSTOMER');
      if (customerRole) {
        await this.repo.grantRole({ userId: user.id, roleId: customerRole.id, scopeType: 'PLATFORM', scopeId: null, grantedBy: null });
      }
      await this.repo.touchLastLogin(user.id);

      const tokens = await this.startSession(user.id, now, input);
      await this.audit.record({
        actorType: 'USER',
        actorId: user.id,
        action: created ? 'auth.registered' : 'auth.login',
        entityType: 'user',
        entityId: user.id,
        metadata: { contact_masked: maskPhone(e164), device_id: input.deviceId ?? null },
      });
      return { kind: 'OK', tokens, userId: user.id, isNew: created, restored };
    });

    if (outcome.kind === 'DISABLED') throw new DomainError('ACCOUNT_DISABLED', 'This account is not active', 403);
    if (outcome.kind === 'REJECTED') throw invalid();
    return { ...outcome.tokens, user: { id: outcome.userId, is_new: outcome.isNew, account_restored: outcome.restored } };
  }

  /**
   * Creates a session (= refresh-token family) and its first refresh token + access token.
   * Privileged logins pass `mfaVerified` and get a shorter session (refresh tokens cannot outlive it).
   * Must be called inside a transaction.
   */
  async startSession(userId: string, now: Date, ctx: ClientContext, opts: { mfaVerified?: boolean } = {}): Promise<AuthTokens> {
    const sessionId = uuidv7();
    const ttlMs = opts.mfaVerified ? this.config.adminSessionHours * 3_600_000 : this.config.jwt.refreshTtlDays * 86_400_000;
    const expiresAt = new Date(now.getTime() + ttlMs);
    await this.repo.createSession({
      id: sessionId,
      userId,
      deviceId: ctx.deviceId ?? null,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      expiresAt,
      mfaVerifiedAt: opts.mfaVerified ? now : null,
    });
    const refresh = this.tokens.newRefreshToken();
    await this.repo.insertRefreshToken({ id: uuidv7(), sessionId, tokenHash: refresh.hash, expiresAt });
    return {
      access_token: this.tokens.signAccessToken({ sub: userId, sid: sessionId }),
      refresh_token: refresh.token,
      token_type: 'Bearer',
      expires_in: this.tokens.accessTtlSeconds,
    };
  }

  // ---------------------------------------------------------------------------------------------
  /** Rotating refresh with reuse detection (docs §M.1). */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const now = this.clock.now();
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    type Outcome = { kind: 'INVALID' } | { kind: 'REUSED' } | { kind: 'RACE' } | { kind: 'OK'; tokens: AuthTokens };

    const outcome: Outcome = await this.uow.run(async (): Promise<Outcome> => {
      const row = await this.repo.lockRefreshToken(tokenHash);
      if (!row || row.revoked_at || row.session_expires_at <= now || row.token_expires_at <= now) return { kind: 'INVALID' };

      if (row.rotated_at) {
        if (now.getTime() - row.rotated_at.getTime() <= REFRESH_REUSE_GRACE_MS) return { kind: 'RACE' };
        // An already-rotated token resurfaced outside the grace window: assume theft, kill the whole session.
        await this.repo.revokeSession(row.session_id, 'REFRESH_REUSE', now);
        await this.audit.record({
          actorType: 'SYSTEM',
          actorId: row.user_id,
          action: 'auth.refresh_reuse_detected',
          entityType: 'session',
          entityId: row.session_id,
        });
        return { kind: 'REUSED' };
      }

      const user = await this.repo.findUserById(row.user_id);
      if (!user || user.status !== 'ACTIVE') return { kind: 'INVALID' };

      await this.repo.markTokenRotated(row.token_id, now);
      const next = this.tokens.newRefreshToken();
      await this.repo.insertRefreshToken({
        id: uuidv7(),
        sessionId: row.session_id,
        tokenHash: next.hash,
        expiresAt: row.session_expires_at,
      });
      await this.repo.touchSession(row.session_id, now);
      return {
        kind: 'OK',
        tokens: {
          access_token: this.tokens.signAccessToken({ sub: row.user_id, sid: row.session_id }),
          refresh_token: next.token,
          token_type: 'Bearer',
          expires_in: this.tokens.accessTtlSeconds,
        },
      };
    });

    switch (outcome.kind) {
      case 'OK':
        return outcome.tokens;
      case 'RACE':
        throw new DomainError('REFRESH_CONFLICT', 'Refresh token was just used; retry with the latest token', 409);
      case 'REUSED':
        throw new UnauthenticatedError('Session revoked: refresh token reuse detected', 'REFRESH_REUSED');
      default:
        throw new UnauthenticatedError('Invalid refresh token', 'REFRESH_INVALID');
    }
  }

  // ---------------------------------------------------------------------------------------------
  async logout(userId: string, sessionId: string): Promise<void> {
    await this.uow.run(async () => {
      await this.repo.revokeSession(sessionId, 'LOGOUT', this.clock.now(), userId);
      await this.audit.record({ actorType: 'USER', actorId: userId, action: 'auth.logout', entityType: 'session', entityId: sessionId });
    });
  }

  listSessions(userId: string) {
    return this.repo.listActiveSessions(userId, this.clock.now());
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.uow.run(async () => {
      const revoked = await this.repo.revokeSession(sessionId, 'USER_REVOKED', this.clock.now(), userId);
      if (revoked) {
        await this.audit.record({ actorType: 'USER', actorId: userId, action: 'auth.session_revoked', entityType: 'session', entityId: sessionId });
      }
      return revoked;
    });
  }

  /** Masked phone for the user's own profile; decrypted only for the owner. */
  async getMaskedPhone(userId: string): Promise<string | null> {
    const phoneEnc = await this.repo.getPhoneEnc(userId);
    return phoneEnc ? maskPhone(this.cipher.decrypt(phoneEnc)) : null;
  }
}
