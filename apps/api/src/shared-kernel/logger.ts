import pino, { DestinationStream, Logger } from 'pino';
import { currentRequestId, requestContext } from './request-context';

/**
 * Structured JSON logging with mandatory redaction (requirements §24: never log passwords, OTPs,
 * payment secrets, access tokens, or unnecessary personal data).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.authkey',
  'headers.authkey',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'password',
  'otp',
  'code',
  'pin',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'authkey',
  'auth_key',
  'phone',
  'email',
  'latitude',
  'longitude',
  'lat',
  'lng',
  '*.password',
  '*.otp',
  '*.code',
  '*.pin',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.secret',
  '*.api_key',
  '*.authkey',
  '*.auth_key',
  '*.authorization',
  '*.phone',
  '*.email',
  '*.latitude',
  '*.longitude',
  '*.lat',
  '*.lng',
];

export function createLogger(level = 'info', destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'tokengo-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin() {
        const ctx = requestContext.getStore();
        return ctx ? { request_id: currentRequestId(), actor_id: ctx.actorId } : {};
      },
    },
    destination,
  );
}
