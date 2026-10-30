import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().optional(),
  PII_ENCRYPTION_KEY_B64: z.string().optional(),
  PII_HASH_KEY_B64: z.string().optional(),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Privileged sessions are short-lived; refresh tokens cannot outlive them.
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(12),

  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
  OTP_MAX_PER_PHONE_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
  OTP_MAX_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),

  // 'console' prints codes to the log (development/tests only); 'msg91' sends them by SMS through MSG91 (India, DLT-registered template);
  // 'whatsapp' sends them as an authentication template through the Meta WhatsApp Cloud API; 'disabled' refuses every request.
  SMS_PROVIDER: z.enum(['console', 'disabled', 'msg91', 'whatsapp']).default('console'),
  // Meta WhatsApp Cloud API. The access token is a secret and is only ever sent to graph.facebook.com (or to a localhost test double).
  // Required when SMS_PROVIDER=whatsapp: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_NAME.
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TEMPLATE_NAME: z.string().optional(),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().optional(),
  // Authentication templates with a "Copy code" button need the code a second time, as the button's parameter.
  WHATSAPP_TEMPLATE_HAS_CODE_BUTTON: z.enum(['true', 'false']).optional(),
  WHATSAPP_API_VERSION: z.string().optional(),
  WHATSAPP_API_BASE_URL: z.string().optional(),
  // MSG91. The auth key is a secret and is only ever sent to MSG91 (or to a localhost test double). Required when SMS_PROVIDER=msg91.
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  MSG91_BASE_URL: z.string().optional(),
  // DEVELOPMENT ONLY: comma-separated mobile numbers whose login codes go to the API log instead of the SMS gateway (the seeded demo
  // numbers could belong to real people). Refused in production.
  SMS_LOG_ONLY_PHONES: z.string().optional(),

  // Payments: only the SANDBOX simulator exists. It is refused in production; live money stays disabled.
  // Unset => 'sandbox' outside production and 'disabled' in production. An EXPLICIT sandbox in production is refused.
  PAYMENT_PROVIDER: z.enum(['sandbox', 'razorpay', 'disabled']).optional(),
  // Razorpay, TEST MODE ONLY: `rzp_live_` keys are refused (live money stays disabled, docs §K.4).
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_API_BASE_URL: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET_B64: z.string().optional(),
  TOPUP_MIN_MINOR: z.coerce.number().int().min(1).default(1_000), // ₹10
  TOPUP_MAX_MINOR: z.coerce.number().int().min(1).default(5_000_000), // ₹50,000
  TOPUP_INTENT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  // Provider payouts (bank transfers). Only a SANDBOX simulator exists; unset => 'sandbox' outside production, 'disabled' in production.
  PAYOUT_PROVIDER: z.enum(['sandbox', 'disabled']).optional(),
  PAYOUT_MIN_MINOR: z.coerce.number().int().min(1).default(10_000), // INR 100: below this, earnings keep accruing
  PAYOUT_MAX_MINOR: z.coerce.number().int().min(1).default(10_000_000), // INR 100,000 per payout (bank/provider limits, blast radius)
  PAYOUT_DELAY_HOURS: z.coerce.number().int().min(0).max(720).default(24), // a payable becomes eligible this long after it is recorded
  PAYOUT_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(20).default(3), // then the provider's payouts are frozen for review
  PAYOUT_ACCOUNT_COOLING_HOURS: z.coerce.number().int().min(0).max(720).default(24), // a newly verified bank account is not paid until it has stood this long (account-takeover control)

  // Account deletion (requirements §5/§25): the account is deactivated at once and anonymised after this grace period; signing
  // in again within it cancels the deletion.
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(30).default(7),

  // Push notifications. 'console' only logs (development/tests); 'fcm' sends through Firebase Cloud Messaging (HTTP v1);
  // 'disabled' keeps in-app notifications and drops pushes. Unset => 'console' outside production and 'disabled' in production.
  PUSH_PROVIDER: z.enum(['console', 'fcm', 'disabled']).optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON_B64: z.string().optional(),
  FCM_API_BASE_URL: z.string().optional(),
  FCM_TOKEN_URL: z.string().optional(),

  // Uploaded files (provider documents, dispute evidence). 'local' writes under STORAGE_LOCAL_DIR (development/tests only);
  // 's3' uses the bucket below with the task role's credentials (never static keys). Production requires 's3'.
  STORAGE_DRIVER: z.enum(['local', 's3']).optional(),
  STORAGE_LOCAL_DIR: z.string().default('./.data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(10_000).max(25_000_000).default(5_000_000),

  // Maker-checker (requirements §21): sensitive administrative changes need a SECOND administrator to approve. Unset => on in
  // production, off elsewhere (a single developer account must still be able to work). Production refuses 'off'.
  MAKER_CHECKER: z.enum(['on', 'off']).optional(),

  // Hard safety switch (docs §K.2/§K.4): live money movement is disabled until compliance sign-off.
  REAL_MONEY_ENABLED: boolString.default(false),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: string;
  databaseUrl: string;
  dbPoolMax: number;
  jwt: { privateKeyPem: string; publicKeyPem: string; accessTtlSeconds: number; refreshTtlDays: number };
  adminSessionHours: number;
  piiEncryptionKey: Buffer;
  piiHashKey: Buffer;
  otp: {
    ttlSeconds: number;
    maxAttempts: number;
    resendCooldownSeconds: number;
    maxPerPhonePerHour: number;
    maxPerIpPerHour: number;
  };
  smsProvider: 'console' | 'disabled' | 'msg91' | 'whatsapp';
  /** Only present when smsProvider === 'msg91'. */
  msg91?: { authKey: string; templateId: string; baseUrl: string };
  /** Only present when smsProvider === 'whatsapp'. */
  whatsapp?: { accessToken: string; phoneNumberId: string; templateName: string; templateLanguage: string; codeButton: boolean; apiVersion: string; baseUrl: string };
  /** Raw entries of SMS_LOG_ONLY_PHONES (normalised and validated where the sender is built). Always empty in production. */
  smsLogOnlyPhones: string[];
  payments: {
    provider: 'sandbox' | 'razorpay' | 'disabled';
    /** Only present when provider === 'razorpay'. Always a TEST-mode key pair. */
    razorpay?: { keyId: string; keySecret: string; webhookSecret: string; baseUrl: string };
    webhookSecret: Buffer;
    topupMinMinor: bigint;
    topupMaxMinor: bigint;
    topupIntentTtlMinutes: number;
  };
  payouts: {
    provider: 'sandbox' | 'disabled';
    minMinor: bigint;
    maxMinor: bigint;
    delayHours: number;
    maxConsecutiveFailures: number;
    accountCoolingHours: number;
  };
  accountDeletionGraceDays: number;
  push: {
    provider: 'console' | 'fcm' | 'disabled';
    /** Only present when provider === 'fcm'. */
    fcm?: { projectId: string; serviceAccountJson: string; apiBaseUrl: string; tokenUrl: string };
  };
  storage: { driver: 'local' | 's3'; localDir: string; bucket?: string; region: string; maxUploadBytes: number };
  makerChecker: boolean;
  realMoneyEnabled: false;
}

function decodeKey(name: string, b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (e.REAL_MONEY_ENABLED) {
    throw new Error(
      'REAL_MONEY_ENABLED=true is refused: live money movement stays disabled until the payment-model, ' +
        'custody and regulatory review is approved (docs/ARCHITECTURE-PROPOSAL.md §K.4).',
    );
  }

  if (isProduction) {
    const missing = (
      ['JWT_PRIVATE_KEY_PEM', 'JWT_PUBLIC_KEY_PEM', 'PII_ENCRYPTION_KEY_B64', 'PII_HASH_KEY_B64'] as const
    ).filter((k) => !e[k]);
    if (missing.length) throw new Error(`Missing required secrets in production: ${missing.join(', ')}`);
    if (e.SMS_PROVIDER === 'console') {
      throw new Error('SMS_PROVIDER=console is not allowed in production');
    }
    if (e.SMS_LOG_ONLY_PHONES?.trim()) {
      throw new Error('SMS_LOG_ONLY_PHONES is not allowed in production (those numbers would never receive their login code)');
    }
    if (e.PAYMENT_PROVIDER === 'sandbox') {
      throw new Error('PAYMENT_PROVIDER=sandbox is not allowed in production (no live provider is approved; use disabled)');
    }
    if (e.PAYOUT_PROVIDER === 'sandbox') {
      throw new Error('PAYOUT_PROVIDER=sandbox is not allowed in production (no live payout provider is approved; use disabled)');
    }
    if (e.PUSH_PROVIDER === 'console') throw new Error('PUSH_PROVIDER=console is not allowed in production (it only logs)');
    if (e.STORAGE_DRIVER === 'local') throw new Error('STORAGE_DRIVER=local is not allowed in production (use s3)');
    if (e.MAKER_CHECKER === 'off') throw new Error('MAKER_CHECKER=off is not allowed in production');
  }

  // A credential may only ever be sent to its own vendor, or to a localhost test double.
  const allowed = (u: string, host: RegExp) => host.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u);

  let msg91: AppConfig['msg91'];
  if (e.SMS_PROVIDER === 'msg91') {
    const authKey = e.MSG91_AUTH_KEY?.trim();
    const templateId = e.MSG91_TEMPLATE_ID?.trim();
    if (!authKey || !templateId) throw new Error('SMS_PROVIDER=msg91 requires MSG91_AUTH_KEY and MSG91_TEMPLATE_ID');
    // Both go into an HTTP header / URL: printable ASCII only (a stray line break from a copy-paste would corrupt the request).
    if (!/^[!-~]+$/.test(authKey)) throw new Error('MSG91_AUTH_KEY must be a single run of printable characters (no spaces or line breaks)');
    if (!/^[A-Za-z0-9_-]+$/.test(templateId)) throw new Error('MSG91_TEMPLATE_ID may only contain letters, digits, "_" and "-"');
    const baseUrl = (e.MSG91_BASE_URL?.trim() || 'https://control.msg91.com').replace(/\/+$/, '');
    if (!allowed(baseUrl, /^https:\/\/control\.msg91\.com$/)) throw new Error('MSG91_BASE_URL must be https://control.msg91.com (or a localhost test double): the auth key is only ever sent to MSG91');
    msg91 = { authKey, templateId, baseUrl };
  }
  let whatsapp: AppConfig['whatsapp'];
  if (e.SMS_PROVIDER === 'whatsapp') {
    const accessToken = e.WHATSAPP_ACCESS_TOKEN?.trim();
    const phoneNumberId = e.WHATSAPP_PHONE_NUMBER_ID?.trim();
    const templateName = e.WHATSAPP_TEMPLATE_NAME?.trim();
    if (!accessToken || !phoneNumberId || !templateName) {
      throw new Error('SMS_PROVIDER=whatsapp requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE_NAME');
    }
    // The token goes into an HTTP header, the other values into a URL / JSON: refuse anything a copy-paste could have mangled.
    if (!/^[!-~]+$/.test(accessToken)) throw new Error('WHATSAPP_ACCESS_TOKEN must be a single run of printable characters (no spaces or line breaks)');
    if (!/^\d{5,25}$/.test(phoneNumberId)) throw new Error('WHATSAPP_PHONE_NUMBER_ID must be the numeric "Phone number ID" from Meta (not the phone number itself)');
    if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw new Error('WHATSAPP_TEMPLATE_NAME must be the template NAME (lower-case letters, digits and "_"), as shown in WhatsApp Manager');
    const templateLanguage = e.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || 'en_IN';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(templateLanguage)) throw new Error('WHATSAPP_TEMPLATE_LANGUAGE must be a language code such as en, en_US or en_IN');
    const apiVersion = e.WHATSAPP_API_VERSION?.trim() || 'v21.0';
    if (!/^v\d{1,3}\.\d{1,2}$/.test(apiVersion)) throw new Error('WHATSAPP_API_VERSION must look like v21.0');
    const baseUrl = (e.WHATSAPP_API_BASE_URL?.trim() || 'https://graph.facebook.com').replace(/\/+$/, '');
    if (!allowed(baseUrl, /^https:\/\/graph\.facebook\.com$/)) throw new Error('WHATSAPP_API_BASE_URL must be https://graph.facebook.com (or a localhost test double): the access token is only ever sent to Meta');
    whatsapp = { accessToken, phoneNumberId, templateName, templateLanguage, codeButton: (e.WHATSAPP_TEMPLATE_HAS_CODE_BUTTON ?? 'true') === 'true', apiVersion, baseUrl };
  }
  const smsLogOnlyPhones = (e.SMS_LOG_ONLY_PHONES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (smsLogOnlyPhones.length > 50) throw new Error('SMS_LOG_ONLY_PHONES lists more than 50 numbers');

  const pushProvider = e.PUSH_PROVIDER ?? (isProduction ? 'disabled' : 'console');
  let fcm: AppConfig['push']['fcm'];
  if (pushProvider === 'fcm') {
    if (!e.FCM_PROJECT_ID || !e.FCM_SERVICE_ACCOUNT_JSON_B64) throw new Error('PUSH_PROVIDER=fcm requires FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON_B64');
    const apiBase = (e.FCM_API_BASE_URL ?? 'https://fcm.googleapis.com').replace(/\/+$/, '');
    const tokenUrl = e.FCM_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
    // The service-account key may only ever be sent to Google (or to a localhost test double).
    if (!allowed(apiBase, /^https:\/\/fcm\.googleapis\.com(\/|$)/)) throw new Error('FCM_API_BASE_URL must be https://fcm.googleapis.com (or a localhost test double)');
    if (!allowed(tokenUrl, /^https:\/\/oauth2\.googleapis\.com\/token$/)) throw new Error('FCM_TOKEN_URL must be https://oauth2.googleapis.com/token (or a localhost test double)');
    fcm = { projectId: e.FCM_PROJECT_ID, serviceAccountJson: Buffer.from(e.FCM_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'), apiBaseUrl: apiBase, tokenUrl };
  }

  const storageDriver = e.STORAGE_DRIVER ?? (isProduction ? 's3' : 'local');
  if (storageDriver === 's3' && !e.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
  const makerChecker = (e.MAKER_CHECKER ?? (isProduction ? 'on' : 'off')) === 'on';

  const paymentProvider = e.PAYMENT_PROVIDER ?? (isProduction ? 'disabled' : 'sandbox');
  let razorpay: AppConfig['payments']['razorpay'];
  if (paymentProvider === 'razorpay') {
    if (isProduction) {
      throw new Error(
        'PAYMENT_PROVIDER=razorpay is not allowed in production yet: only test-mode keys are accepted, and test-mode payments would ' +
          'credit wallets that could be spent on real services. Use PAYMENT_PROVIDER=disabled until the compliance review is approved (docs §K.4).',
      );
    }
    const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret, RAZORPAY_WEBHOOK_SECRET: webhookSecret } = e;
    if (!keyId || !keySecret || !webhookSecret) {
      throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET');
    }
    if (keyId.startsWith('rzp_live_')) {
      throw new Error('A LIVE Razorpay key (rzp_live_…) is refused: live money movement is disabled until the compliance review is approved (docs §K.4). Use a rzp_test_ key.');
    }
    if (!/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) throw new Error('RAZORPAY_KEY_ID must be a Razorpay TEST-mode key id (rzp_test_…)');
    if (webhookSecret.length < 8) throw new Error('RAZORPAY_WEBHOOK_SECRET must be at least 8 characters');
    // The credentials may only ever be sent to Razorpay (or to a local test double) — never to an arbitrary configured host.
    const baseUrl = (e.RAZORPAY_API_BASE_URL ?? 'https://api.razorpay.com/v1').replace(/\/+$/, '');
    if (!/^https:\/\/api\.razorpay\.com(\/|$)/.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseUrl)) {
      throw new Error('RAZORPAY_API_BASE_URL must be https://api.razorpay.com/… (or a localhost test double)');
    }
    razorpay = { keyId, keySecret, webhookSecret, baseUrl };
  }

  // PII keys define PERSISTED data: the phone/e-mail blind indexes and every encrypted column. If they
  // differ between processes or restarts, existing users silently "disappear" (their hashes no longer
  // match) and ciphertext becomes unreadable. So they may only be ephemeral in automated tests, where the
  // database is created fresh for each run. Everywhere else they must be provided (see `pnpm api:init-env`).
  if (!isProduction && e.NODE_ENV !== 'test') {
    const missing = (['PII_ENCRYPTION_KEY_B64', 'PII_HASH_KEY_B64'] as const).filter((k) => !e[k]);
    if (missing.length) {
      throw new Error(
        `Missing ${missing.join(', ')}. These keys protect stored data and must be stable across restarts. ` +
          'Generate a local .env with: pnpm api:init-env',
      );
    }
  }

  // JWT signing keys may be ephemeral in non-production (a restart merely invalidates tokens).
  // PEMs in .env files carry newlines as the two characters "\n".
  const unescapePem = (s?: string) => s?.replace(/\\n/g, '\n');
  let privateKeyPem = unescapePem(e.JWT_PRIVATE_KEY_PEM);
  let publicKeyPem = unescapePem(e.JWT_PUBLIC_KEY_PEM);
  if (!privateKeyPem || !publicKeyPem) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    jwt: {
      privateKeyPem,
      publicKeyPem,
      accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    },
    adminSessionHours: e.ADMIN_SESSION_HOURS,
    piiEncryptionKey: e.PII_ENCRYPTION_KEY_B64
      ? decodeKey('PII_ENCRYPTION_KEY_B64', e.PII_ENCRYPTION_KEY_B64)
      : randomBytes(32),
    piiHashKey: e.PII_HASH_KEY_B64 ? decodeKey('PII_HASH_KEY_B64', e.PII_HASH_KEY_B64) : randomBytes(32),
    otp: {
      ttlSeconds: e.OTP_TTL_SECONDS,
      maxAttempts: e.OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: e.OTP_RESEND_COOLDOWN_SECONDS,
      maxPerPhonePerHour: e.OTP_MAX_PER_PHONE_PER_HOUR,
      maxPerIpPerHour: e.OTP_MAX_PER_IP_PER_HOUR,
    },
    smsProvider: e.SMS_PROVIDER,
    ...(msg91 ? { msg91 } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    smsLogOnlyPhones,
    payments: {
      provider: paymentProvider,
      ...(razorpay ? { razorpay } : {}),
      webhookSecret: e.PAYMENT_WEBHOOK_SECRET_B64 ? Buffer.from(e.PAYMENT_WEBHOOK_SECRET_B64, 'base64') : randomBytes(32),
      topupMinMinor: BigInt(e.TOPUP_MIN_MINOR),
      topupMaxMinor: BigInt(e.TOPUP_MAX_MINOR),
      topupIntentTtlMinutes: e.TOPUP_INTENT_TTL_MINUTES,
    },
    payouts: {
      provider: e.PAYOUT_PROVIDER ?? (isProduction ? 'disabled' : 'sandbox'),
      minMinor: BigInt(e.PAYOUT_MIN_MINOR),
      maxMinor: BigInt(e.PAYOUT_MAX_MINOR),
      delayHours: e.PAYOUT_DELAY_HOURS,
      maxConsecutiveFailures: e.PAYOUT_MAX_CONSECUTIVE_FAILURES,
      accountCoolingHours: e.PAYOUT_ACCOUNT_COOLING_HOURS,
    },
    accountDeletionGraceDays: e.ACCOUNT_DELETION_GRACE_DAYS,
    push: { provider: pushProvider, ...(fcm ? { fcm } : {}) },
    storage: { driver: storageDriver, localDir: e.STORAGE_LOCAL_DIR, ...(e.S3_BUCKET ? { bucket: e.S3_BUCKET } : {}), region: e.S3_REGION, maxUploadBytes: e.MAX_UPLOAD_BYTES },
    makerChecker,
    realMoneyEnabled: false,
  };
}
