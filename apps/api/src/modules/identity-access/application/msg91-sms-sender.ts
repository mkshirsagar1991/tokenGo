import type { Logger } from 'pino';
import { DomainError } from '../../../shared-kernel';
import { maskPhone } from '../domain/phone';
import { SmsSender } from './sms-sender';

export interface Msg91Options {
  authKey: string;
  /** The OTP template created in the MSG91 panel and linked to the DLT-approved template (India requires both). */
  templateId: string;
  /** https://control.msg91.com, or a localhost test double (config refuses any other host: the auth key is only ever sent to MSG91). */
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** What MSG91 answers (everything is optional: the body is untrusted and may not even be JSON). */
interface ProviderBody {
  type?: unknown;
  message?: unknown;
  request_id?: unknown;
}

/**
 * Sends login codes through MSG91's "Send OTP" API (v5). WE generate, hash and verify the code (auth.service.ts); MSG91 only delivers it.
 * The message text is the DLT-approved template, with the code in its `##OTP##` variable: it cannot be changed from here.
 *
 *   POST {baseUrl}/api/v5/otp   header `authkey: <key>`   template_id, mobile (country code, no "+"), otp, otp_length, otp_expiry (minutes)
 *   success: HTTP 2xx AND {"type":"success", ...}. MSG91 reports some failures as HTTP 200 with {"type":"error","message":...}, so the
 *   HTTP status alone is NOT trusted.
 *
 * The parameters are sent BOTH in the query string and in the JSON body: MSG91's documentation shows both forms and the page that
 * would settle which one is authoritative could not be read when this was written. The two carry identical values, so a gateway that
 * reads either gets the same request. (See docs/SMS-SETUP-MSG91.md: the first real send is the proof; `pnpm --filter @tokengo/api sms:check`.)
 *
 * Failure handling is deliberately blunt: any problem (network, timeout, a redirect, a non-success answer) throws SMS_DELIVERY_FAILED
 * and auth.service invalidates the code it could not deliver, so the person simply asks again. The detail goes to the log, never to
 * the client, and NEITHER THE CODE NOR THE AUTH KEY IS EVER LOGGED (provider text is scrubbed of both before it is written).
 */
export class Msg91SmsSender extends SmsSender {
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: Msg91Options,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendOtp(toE164: string, code: string, ttlSeconds: number): Promise<void> {
    const recipient = maskPhone(toE164);
    const params: Record<string, string> = {
      template_id: this.opts.templateId,
      mobile: toE164.replace(/^\+/, ''), // MSG91 wants the country code without the plus sign
      otp: code,
      otp_expiry: String(Math.max(1, Math.ceil(ttlSeconds / 60))), // minutes
    };
    if (code.length === 4 || code.length === 6) params['otp_length'] = String(code.length); // the only lengths MSG91 accepts

    let status: number | undefined;
    let text = '';
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/api/v5/otp?${new URLSearchParams(params).toString()}`, {
        method: 'POST',
        headers: { authkey: this.opts.authKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(params),
        redirect: 'error', // never follow a redirect: it would carry the auth key to wherever it points
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      // Duck-typed on purpose: fetch's timeout/abort errors are DOMExceptions, which are not always `instanceof Error` across realms.
      const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name).slice(0, 40) : '';
      this.fail(recipient, code, { reason: name || 'network error' });
    }

    let body: ProviderBody | null;
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed && typeof parsed === 'object' ? (parsed as ProviderBody) : null;
    } catch {
      body = null; // not JSON (an error page from a proxy, say)
    }

    if (status !== undefined && status >= 200 && status < 300 && body?.type === 'success') {
      this.logger.info({ provider: 'msg91', recipient, provider_request_id: typeof body.request_id === 'string' ? body.request_id.slice(0, 80) : undefined }, 'SMS accepted by the provider');
      return;
    }
    this.fail(recipient, code, {
      http_status: status,
      provider_type: typeof body?.type === 'string' ? body.type.slice(0, 30) : undefined,
      provider_message: this.scrub(typeof body?.message === 'string' ? body.message : text, code),
      hint: status === 401 || status === 403 ? 'MSG91 rejected the auth key: check MSG91_AUTH_KEY, and that this server\'s public IP is allowed under Authkey > IP security in the MSG91 panel' : undefined,
    });
  }

  /** Logs the operator-facing detail (no code, no key, masked number) and throws the client-facing error. Never returns. */
  private fail(recipient: string, code: string, detail: Record<string, unknown>): never {
    this.logger.warn({ provider: 'msg91', recipient, ...detail }, 'SMS delivery failed');
    throw new DomainError('SMS_DELIVERY_FAILED', 'Could not deliver the verification code', 502);
  }

  /** Provider text is untrusted: bound its length and make sure it cannot carry the code or the auth key into a log line. */
  private scrub(text: string, code: string): string {
    return text.split(code).join('******').split(this.opts.authKey).join('[key]').slice(0, 200); // scrub BEFORE cutting, so a code cannot be split in half and survive
  }
}
