import { createSign } from 'node:crypto';
import { PushMessage, PushProvider, PushResult } from './push-provider';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface FcmOptions {
  projectId: string;
  serviceAccountJson: string;
  apiBaseUrl: string;
  tokenUrl: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

/**
 * Firebase Cloud Messaging, HTTP v1. Authenticates with a service-account key (OAuth 2.0 JWT bearer grant, RS256) — the
 * service-account JSON is a secret and is only ever sent to Google's token endpoint (config refuses any other host). Android
 * and iOS tokens both go through FCM.
 *
 * Failure mapping is deliberately conservative: only a response that says the TOKEN is unknown retires a device; anything
 * ambiguous (timeouts, 5xx, throttling, an expired access token) is a RETRY, because dropping a good device would silently
 * stop that person's notifications.
 */
export class FcmPushProvider extends PushProvider {
  readonly name = 'fcm' as const;
  readonly enabled = true;
  private readonly account: ServiceAccount;
  private accessToken?: { value: string; expiresAt: number };

  constructor(private readonly opts: FcmOptions) {
    super();
    const parsed = JSON.parse(opts.serviceAccountJson) as Partial<ServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) throw new Error('FCM service account JSON must contain client_email and private_key');
    this.account = { client_email: parsed.client_email, private_key: parsed.private_key };
  }

  async send(message: PushMessage): Promise<PushResult> {
    try {
      const first = await this.post(message, await this.token());
      if (first.status !== 401) return this.interpret(first);
      // The access token may have been revoked or expired early: fetch a fresh one ONCE, then treat a second 401 as transient.
      this.accessToken = undefined;
      const second = await this.post(message, await this.token());
      return second.status === 401 ? { kind: 'RETRY', reason: 'credentials rejected' } : this.interpret(second);
    } catch (e) {
      return { kind: 'RETRY', reason: e instanceof Error ? e.message.slice(0, 200) : 'network error' };
    }
  }

  private async post(m: PushMessage, bearer: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.opts.apiBaseUrl}/v1/projects/${encodeURIComponent(this.opts.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: m.token,
          notification: { title: m.title, body: m.body },
          data: m.data,
          // `tag` collapses a repeated push (a retry after a crash) into the notification already shown on the device.
          android: { priority: 'HIGH', notification: { channel_id: 'tokengo_default', ...(m.data['notification_id'] ? { tag: m.data['notification_id'] } : {}) } },
          apns: { payload: { aps: { sound: 'default' } } },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private interpret(r: { status: number; body: unknown }): PushResult {
    const body = r.body as { name?: string; error?: { status?: string; message?: string; details?: { errorCode?: string }[] } } | null;
    if (r.status >= 200 && r.status < 300) return { kind: 'SENT', messageId: body?.name ?? 'unknown' };
    const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode ?? body?.error?.status ?? '';
    if (r.status === 404 || code === 'UNREGISTERED') return { kind: 'INVALID_TOKEN' };
    // INVALID_ARGUMENT is also returned for a malformed message; only retire the device when the message says it is the TOKEN.
    if (r.status === 400 && /registration token/i.test(body?.error?.message ?? '')) return { kind: 'INVALID_TOKEN' };
    if (r.status === 429 || r.status >= 500) return { kind: 'RETRY', reason: `FCM ${r.status}` };
    return { kind: 'REJECTED', reason: `FCM ${r.status} ${code}`.trim() };
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > now) return this.accessToken.value;
    const iat = Math.floor(now / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: this.account.client_email, scope: SCOPE, aud: this.opts.tokenUrl, iat, exp: iat + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const res = await fetch(this.opts.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('token endpoint returned no access_token');
    this.accessToken = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }
}
