import { Inject, Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { APP_CONFIG, AppConfig, Clock, UnauthenticatedError, randomToken, sha256Hex } from '../../../shared-kernel';

const ISSUER = 'tokengo';
const AUDIENCE = 'tokengo-api';
const MFA_AUDIENCE = 'tokengo-mfa';
const MFA_TOKEN_TTL_SECONDS = 300;

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id (checked against the DB on every request => instant revocation)
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  get accessTtlSeconds(): number {
    return this.config.jwt.accessTtlSeconds;
  }

  signAccessToken(claims: AccessClaims): string {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return jwt.sign({ ...claims, iat, exp: iat + this.config.jwt.accessTtlSeconds }, this.config.jwt.privateKeyPem, {
      algorithm: 'ES256',
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  verifyAccessToken(token: string): AccessClaims {
    try {
      const decoded = jwt.verify(token, this.config.jwt.publicKeyPem, {
        algorithms: ['ES256'], // pin the algorithm: never trust the token header (alg-confusion defence)
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
      if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || typeof decoded['sid'] !== 'string') {
        throw new Error('malformed claims');
      }
      return { sub: decoded.sub, sid: decoded['sid'] as string };
    } catch {
      throw new UnauthenticatedError('Invalid or expired access token', 'TOKEN_INVALID');
    }
  }

  /**
   * Short-lived, purpose-bound token proving "password step passed" so the MFA endpoints can be called.
   * Different audience and no `sid`: it can never be used as an access token, and vice versa.
   */
  signMfaToken(userId: string): string {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return jwt.sign({ sub: userId, typ: 'mfa', iat, exp: iat + MFA_TOKEN_TTL_SECONDS }, this.config.jwt.privateKeyPem, {
      algorithm: 'ES256',
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
    });
  }

  verifyMfaToken(token: string): string {
    try {
      const decoded = jwt.verify(token, this.config.jwt.publicKeyPem, {
        algorithms: ['ES256'],
        issuer: ISSUER,
        audience: MFA_AUDIENCE,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
      if (typeof decoded === 'string' || typeof decoded.sub !== 'string' || decoded['typ'] !== 'mfa') throw new Error('malformed');
      return decoded.sub;
    } catch {
      throw new UnauthenticatedError('Invalid or expired MFA token', 'MFA_TOKEN_INVALID');
    }
  }

  /** Opaque 256-bit refresh token; only its SHA-256 is persisted (a DB leak cannot be replayed). */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomToken(32);
    return { token, hash: sha256Hex(token) };
  }

  hashRefreshToken(token: string): string {
    return sha256Hex(token);
  }
}
