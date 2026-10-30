/** Server-side configuration. Read once per process; invalid production configuration fails loudly instead of running half-secure. */
export interface ServerConfig {
  /** TokenGo API base URL without a trailing slash, e.g. http://localhost:3000/api/v1 */
  apiBaseUrl: string;
  sessionSecret: string;
  isProduction: boolean;
  secureCookies: boolean;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  /** Refresh the access token when it has less than this left (SESSION_REFRESH_SKEW_SECONDS, default 30). */
  refreshSkewMs: number;
  trustProxy: boolean;
  allowedOrigins: string[];
  apiTimeoutMs: number;
}

const DEFAULT_API = 'http://localhost:3000/api/v1';

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid configuration value "${value}" (expected an integer between ${min} and ${max})`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const isProduction = env.NODE_ENV === 'production';
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 random characters (run `pnpm --filter @tokengo/admin init-env` for local development).');
  }
  const apiBaseUrl = (env.API_BASE_URL?.trim() || DEFAULT_API).replace(/\/+$/, '');
  try {
    new URL(apiBaseUrl);
  } catch {
    throw new Error('API_BASE_URL is not a valid URL');
  }
  const secureOverride = env.COOKIE_SECURE?.trim().toLowerCase();
  return {
    apiBaseUrl,
    sessionSecret: secret,
    isProduction,
    secureCookies: secureOverride ? secureOverride === 'true' : isProduction,
    idleTimeoutMs: int(env.SESSION_IDLE_MINUTES, 15, 1, 240) * 60_000,
    absoluteTimeoutMs: int(env.SESSION_MAX_HOURS, 12, 1, 72) * 3_600_000,
    refreshSkewMs: int(env.SESSION_REFRESH_SKEW_SECONDS, 30, 5, 3600) * 1000,
    trustProxy: env.TRUST_PROXY?.trim().toLowerCase() === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    apiTimeoutMs: 20_000,
  };
}

let cached: ServerConfig | undefined;
export function getConfig(): ServerConfig {
  cached ??= loadConfig();
  return cached;
}
