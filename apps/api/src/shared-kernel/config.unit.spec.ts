import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };
const piiKeys = {
  PII_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
  PII_HASH_KEY_B64: Buffer.alloc(32, 2).toString('base64'),
};

describe('loadConfig', () => {
  it('in tests, boots with no secrets using ephemeral keys (the DB is created fresh per run)', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'test' });
    expect(c.jwt.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(c.piiEncryptionKey).toHaveLength(32);
    expect(c.realMoneyEnabled).toBe(false);
  });

  it('in development, REFUSES to start without the PII keys (ephemeral keys would orphan stored data)', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development' })).toThrow(/PII_ENCRYPTION_KEY_B64, PII_HASH_KEY_B64.*api:init-env/s);
    expect(() => loadConfig({ ...base })).toThrow(/api:init-env/); // NODE_ENV defaults to development
  });

  it('in development, accepts stable PII keys; JWT keys may still be ephemeral', () => {
    const c = loadConfig({ ...base, ...piiKeys, NODE_ENV: 'development' });
    expect(c.piiHashKey.equals(Buffer.alloc(32, 2))).toBe(true);
    expect(c.jwt.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('keeps persisted-data keys identical across processes (same env => same keys)', () => {
    const a = loadConfig({ ...base, ...piiKeys, NODE_ENV: 'development' });
    const b = loadConfig({ ...base, ...piiKeys, NODE_ENV: 'development' });
    expect(a.piiEncryptionKey.equals(b.piiEncryptionKey)).toBe(true);
    expect(a.piiHashKey.equals(b.piiHashKey)).toBe(true);
  });

  it('accepts PEMs written with literal \\n sequences (as found in .env files)', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const escaped = (k: typeof pair.privateKey, type: 'pkcs8' | 'spki') => k.export({ type, format: 'pem' }).toString().trim().replace(/\n/g, '\\n');
    const c = loadConfig({
      ...base,
      ...piiKeys,
      JWT_PRIVATE_KEY_PEM: escaped(pair.privateKey, 'pkcs8'),
      JWT_PUBLIC_KEY_PEM: escaped(pair.publicKey as unknown as typeof pair.privateKey, 'spki'),
    });
    expect(c.jwt.privateKeyPem).toContain('\n');
    expect(c.jwt.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('REFUSES to start with REAL_MONEY_ENABLED=true (compliance gate, docs §K.4)', () => {
    expect(() => loadConfig({ ...base, ...piiKeys, REAL_MONEY_ENABLED: 'true' })).toThrow(/REAL_MONEY_ENABLED=true is refused/);
  });

  it('requires secrets and a real SMS provider in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', SMS_PROVIDER: 'disabled' })).toThrow(
      /Missing required secrets in production/,
    );
    const secrets = { JWT_PRIVATE_KEY_PEM: 'x', JWT_PUBLIC_KEY_PEM: 'y', ...piiKeys };
    expect(() => loadConfig({ ...base, ...secrets, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test' })).toThrow(/SMS_PROVIDER=console/);
    expect(loadConfig({ ...base, ...secrets, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', SMS_PROVIDER: 'disabled' }).isProduction).toBe(true);
  });

  describe('WhatsApp login codes (SMS_PROVIDER=whatsapp)', () => {
    const wa = { ...base, ...piiKeys, SMS_PROVIDER: 'whatsapp', WHATSAPP_ACCESS_TOKEN: 'EAAtoken123', WHATSAPP_PHONE_NUMBER_ID: '1380695201788654', WHATSAPP_TEMPLATE_NAME: 'tokengo_auth_otp' };

    it('needs the token, the phone number id and the template name', () => {
      expect(loadConfig(wa).whatsapp).toEqual({
        accessToken: 'EAAtoken123',
        phoneNumberId: '1380695201788654',
        templateName: 'tokengo_auth_otp',
        templateLanguage: 'en_IN',
        codeButton: true,
        apiVersion: 'v21.0',
        baseUrl: 'https://graph.facebook.com',
      });
      for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_NAME'] as const) {
        expect(() => loadConfig({ ...wa, [key]: ' ' })).toThrow(/SMS_PROVIDER=whatsapp requires/);
      }
    });

    it('is only validated when selected, and is allowed in production', () => {
      expect(loadConfig({ ...base, ...piiKeys }).whatsapp).toBeUndefined();
      const prod = { ...wa, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', JWT_PRIVATE_KEY_PEM: 'x', JWT_PUBLIC_KEY_PEM: 'y' };
      expect(loadConfig(prod).smsProvider).toBe('whatsapp');
    });

    it('rejects values a copy-paste could have mangled', () => {
      expect(() => loadConfig({ ...wa, WHATSAPP_ACCESS_TOKEN: 'EAA token' })).toThrow(/printable characters/);
      expect(() => loadConfig({ ...wa, WHATSAPP_PHONE_NUMBER_ID: '+919767409318' })).toThrow(/Phone number ID/);
      expect(() => loadConfig({ ...wa, WHATSAPP_TEMPLATE_NAME: 'Tokengo Auth OTP' })).toThrow(/template NAME/);
      expect(() => loadConfig({ ...wa, WHATSAPP_TEMPLATE_LANGUAGE: 'english' })).toThrow(/language code/);
      expect(() => loadConfig({ ...wa, WHATSAPP_API_VERSION: '21' })).toThrow(/v21\.0/);
    });

    it('only ever sends the token to Meta (or a localhost test double)', () => {
      expect(() => loadConfig({ ...wa, WHATSAPP_API_BASE_URL: 'https://evil.example.com' })).toThrow(/only ever sent to Meta/);
      expect(() => loadConfig({ ...wa, WHATSAPP_API_BASE_URL: 'https://graph.facebook.com.evil.example.com' })).toThrow(/only ever sent to Meta/);
      expect(loadConfig({ ...wa, WHATSAPP_API_BASE_URL: 'http://127.0.0.1:4010/' }).whatsapp?.baseUrl).toBe('http://127.0.0.1:4010');
    });

    it('lets the template differ from the default (no code button, other language/version)', () => {
      const c = loadConfig({ ...wa, WHATSAPP_TEMPLATE_HAS_CODE_BUTTON: 'false', WHATSAPP_TEMPLATE_LANGUAGE: 'en_US', WHATSAPP_API_VERSION: 'v22.0' });
      expect(c.whatsapp).toMatchObject({ codeButton: false, templateLanguage: 'en_US', apiVersion: 'v22.0' });
    });
  });

  describe('payment provider (no live provider is approved: docs §K.4)', () => {
    const prod = { ...base, JWT_PRIVATE_KEY_PEM: 'x', JWT_PUBLIC_KEY_PEM: 'y', ...piiKeys, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', SMS_PROVIDER: 'disabled' };

    it('defaults to the sandbox outside production and to DISABLED in production', () => {
      expect(loadConfig({ ...base, ...piiKeys }).payments.provider).toBe('sandbox');
      expect(loadConfig({ ...base, NODE_ENV: 'test' }).payments.provider).toBe('sandbox');
      expect(loadConfig(prod).payments.provider).toBe('disabled');
    });

    it('REFUSES an explicit sandbox in production, naming the fix', () => {
      expect(() => loadConfig({ ...prod, PAYMENT_PROVIDER: 'sandbox' })).toThrow(/PAYMENT_PROVIDER=sandbox is not allowed in production/);
      expect(loadConfig({ ...prod, PAYMENT_PROVIDER: 'disabled' }).payments.provider).toBe('disabled');
    });

    it('rejects an unknown provider name (there is no way to select a live PSP by typo)', () => {
      expect(() => loadConfig({ ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'stripe' })).toThrow(/Invalid configuration/);
    });

    describe('payouts (no live payout provider is approved)', () => {
      const prod = { ...base, JWT_PRIVATE_KEY_PEM: 'x', JWT_PUBLIC_KEY_PEM: 'y', ...piiKeys, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', SMS_PROVIDER: 'disabled' };

      it('defaults to the sandbox outside production and to DISABLED in production, with conservative limits', () => {
        const dev = loadConfig({ ...base, NODE_ENV: 'test' }).payouts;
        expect(dev).toEqual({ provider: 'sandbox', minMinor: 10_000n, maxMinor: 10_000_000n, delayHours: 24, maxConsecutiveFailures: 3, accountCoolingHours: 24 });
        expect(loadConfig(prod).payouts.provider).toBe('disabled');
      });

      it('REFUSES an explicit sandbox payout provider in production', () => {
        expect(() => loadConfig({ ...prod, PAYOUT_PROVIDER: 'sandbox' })).toThrow(/PAYOUT_PROVIDER=sandbox is not allowed in production/);
        expect(loadConfig({ ...prod, PAYOUT_PROVIDER: 'disabled' }).payouts.provider).toBe('disabled');
      });

      it('rejects unknown providers and out-of-range limits (including a real PSP that is not built)', () => {
        for (const bad of [{ PAYOUT_PROVIDER: 'razorpayx' }, { PAYOUT_MIN_MINOR: '0' }, { PAYOUT_DELAY_HOURS: '-1' }, { PAYOUT_MAX_CONSECUTIVE_FAILURES: '0' }, { PAYOUT_ACCOUNT_COOLING_HOURS: '9999' }]) {
          expect(() => loadConfig({ ...base, NODE_ENV: 'test', ...bad })).toThrow(/Invalid configuration/);
        }
      });
    });

    describe('Razorpay (TEST MODE ONLY)', () => {
      const rzp = { ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_AbC123xyz', RAZORPAY_KEY_SECRET: 'a-secret', RAZORPAY_WEBHOOK_SECRET: 'whsec_12345678' };

      it('accepts a complete test-mode configuration and defaults to Razorpay\'s own API host', () => {
        const c = loadConfig(rzp);
        expect(c.payments.provider).toBe('razorpay');
        expect(c.payments.razorpay).toEqual({ keyId: 'rzp_test_AbC123xyz', keySecret: 'a-secret', webhookSecret: 'whsec_12345678', baseUrl: 'https://api.razorpay.com/v1' });
      });

      it('REFUSES a LIVE key — live money movement stays disabled whoever asks (compliance gate, docs §K.4)', () => {
        expect(() => loadConfig({ ...rzp, RAZORPAY_KEY_ID: 'rzp_live_AbC123xyz' })).toThrow(/LIVE Razorpay key .* is refused/);
      });

      it.each([
        ['an arbitrary key id', 'AKIAxxxxxxxx'],
        ['an empty-looking test key', 'rzp_test_'],
        ['a test key with junk characters', 'rzp_test_ab c'],
      ])('refuses %s', (_l, keyId) => {
        expect(() => loadConfig({ ...rzp, RAZORPAY_KEY_ID: keyId })).toThrow(/TEST-mode key id/);
      });

      it('requires all three credentials and a usable webhook secret', () => {
        for (const missing of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
          expect(() => loadConfig({ ...rzp, [missing]: undefined })).toThrow(/requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET/);
        }
        expect(() => loadConfig({ ...rzp, RAZORPAY_WEBHOOK_SECRET: 'short' })).toThrow(/at least 8 characters/);
      });

      it('is REFUSED in production even with test keys (test payments would credit wallets spendable on real services)', () => {
        const prod = { ...rzp, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', JWT_PRIVATE_KEY_PEM: 'x', JWT_PUBLIC_KEY_PEM: 'y', ...piiKeys, SMS_PROVIDER: 'disabled' };
        expect(() => loadConfig(prod)).toThrow(/PAYMENT_PROVIDER=razorpay is not allowed in production/);
      });

      it('only ever sends credentials to Razorpay or to a localhost test double — never to a lookalike or an arbitrary host', () => {
        for (const ok of ['https://api.razorpay.com/v1', 'https://api.razorpay.com/v1/', 'http://127.0.0.1:4010/v1', 'http://localhost:4010/v1']) {
          expect(() => loadConfig({ ...rzp, RAZORPAY_API_BASE_URL: ok })).not.toThrow();
        }
        for (const bad of ['https://api.razorpay.com.evil.example/v1', 'https://api.razorpay.com@evil.example/v1', 'http://localhost@evil.example/v1', 'https://evil.example/v1', 'http://api.razorpay.com/v1', 'https://sub.api.razorpay.com/v1', 'ftp://localhost/v1']) {
          expect(() => loadConfig({ ...rzp, RAZORPAY_API_BASE_URL: bad })).toThrow(/RAZORPAY_API_BASE_URL must be/);
        }
      });

      it('does not require Razorpay settings when another provider is selected', () => {
        expect(loadConfig({ ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'sandbox' }).payments.razorpay).toBeUndefined();
      });
    });

    it('bounds the top-up limits with safe defaults and a stable webhook secret when provided', () => {
      const c = loadConfig({ ...base, NODE_ENV: 'test', PAYMENT_WEBHOOK_SECRET_B64: Buffer.alloc(32, 7).toString('base64') });
      expect(c.payments.topupMinMinor).toBe(1_000n);
      expect(c.payments.topupMaxMinor).toBe(5_000_000n);
      expect(c.payments.topupIntentTtlMinutes).toBe(30);
      expect(c.payments.webhookSecret.equals(Buffer.alloc(32, 7))).toBe(true);
    });
  });

  it('validates key sizes and ranges', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', PII_ENCRYPTION_KEY_B64: Buffer.alloc(8).toString('base64') })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', OTP_MAX_ATTEMPTS: '0' })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  describe('notifications, uploads, maker-checker and account deletion', () => {
    const prod = { ...base, JWT_PRIVATE_KEY_PEM: 'x', JWT_PUBLIC_KEY_PEM: 'y', ...piiKeys, NODE_ENV: 'production', S3_BUCKET: 'tokengo-docs-test', SMS_PROVIDER: 'disabled' };
    const fcm = { PUSH_PROVIDER: 'fcm', FCM_PROJECT_ID: 'tokengo-test', FCM_SERVICE_ACCOUNT_JSON_B64: Buffer.from('{"client_email":"a@b","private_key":"k"}').toString('base64') };

    it('defaults are safe in each environment', () => {
      const dev = loadConfig({ ...base, NODE_ENV: 'test' });
      expect(dev.push.provider).toBe('console');
      expect(dev.storage).toMatchObject({ driver: 'local', maxUploadBytes: 5_000_000 });
      expect(dev.makerChecker).toBe(false);
      expect(dev.accountDeletionGraceDays).toBe(7);
      const live = loadConfig(prod);
      expect(live.push.provider).toBe('disabled');
      expect(live.storage).toMatchObject({ driver: 's3', bucket: 'tokengo-docs-test', region: 'ap-south-1' });
      expect(live.makerChecker).toBe(true);
    });

    it('production REFUSES the console push, local file storage and a switched-off maker-checker', () => {
      expect(() => loadConfig({ ...prod, PUSH_PROVIDER: 'console' })).toThrow(/PUSH_PROVIDER=console is not allowed in production/);
      expect(() => loadConfig({ ...prod, STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER=local is not allowed in production/);
      expect(() => loadConfig({ ...prod, MAKER_CHECKER: 'off' })).toThrow(/MAKER_CHECKER=off is not allowed in production/);
    });

    it('the S3 driver needs a bucket; FCM needs its project and key', () => {
      const { S3_BUCKET: _omit, ...noBucket } = prod;
      expect(() => loadConfig(noBucket)).toThrow(/STORAGE_DRIVER=s3 requires S3_BUCKET/);
      expect(() => loadConfig({ ...base, NODE_ENV: 'test', PUSH_PROVIDER: 'fcm' })).toThrow(/requires FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON_B64/);
      expect(loadConfig({ ...prod, ...fcm }).push.fcm).toMatchObject({ projectId: 'tokengo-test', apiBaseUrl: 'https://fcm.googleapis.com' });
    });

    it('the FCM service-account key can only ever be sent to Google (or a localhost test double)', () => {
      expect(() => loadConfig({ ...prod, ...fcm, FCM_API_BASE_URL: 'https://evil.example.com' })).toThrow(/FCM_API_BASE_URL must be https:\/\/fcm.googleapis.com/);
      expect(() => loadConfig({ ...prod, ...fcm, FCM_TOKEN_URL: 'https://evil.example.com/token' })).toThrow(/FCM_TOKEN_URL must be/);
      expect(loadConfig({ ...base, NODE_ENV: 'test', ...fcm, FCM_API_BASE_URL: 'http://127.0.0.1:9999', FCM_TOKEN_URL: 'http://localhost:9999/token' }).push.fcm?.apiBaseUrl).toBe('http://127.0.0.1:9999');
    });

    it('bounds the account-deletion grace period and the upload size', () => {
      for (const bad of [{ ACCOUNT_DELETION_GRACE_DAYS: '0' }, { ACCOUNT_DELETION_GRACE_DAYS: '31' }, { MAX_UPLOAD_BYTES: '5' }, { MAX_UPLOAD_BYTES: '999999999' }]) {
        expect(() => loadConfig({ ...base, NODE_ENV: 'test', ...bad })).toThrow(/Invalid configuration/);
      }
    });
  });
});
