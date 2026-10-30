import type { Logger } from 'pino';
import { DomainError } from '../../../shared-kernel';
import { maskPhone } from '../domain/phone';
import { SmsSender } from './sms-sender';

export interface WhatsAppOptions {
  /** A System User / permanent access token from Meta Business (a secret: only ever sent to graph.facebook.com or a localhost test double). */
  accessToken: string;
  /** The numeric "Phone number ID" of the WhatsApp sender in the Meta dashboard (NOT the phone number itself). */
  phoneNumberId: string;
  /** The NAME of the approved authentication template (e.g. tokengo_auth_otp), as shown in WhatsApp Manager. */
  templateName: string;
  /** The language the template was approved in, e.g. en_IN. Must match exactly or Meta answers "template does not exist". */
  templateLanguage: string;
  /** True for templates with a "Copy code" button: the code is then sent a second time as the button's parameter. */
  codeButton: boolean;
  /** Graph API version, e.g. v21.0. */
  apiVersion: string;
  /** https://graph.facebook.com, or a localhost test double (config refuses any other host). */
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** What Meta answers (everything is optional: the body is untrusted and may not even be JSON). */
interface ProviderBody {
  messages?: unknown;
  error?: { message?: unknown; type?: unknown; code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown } | null;
}

/** Operator hints for the Meta error codes people actually hit while setting this up. Logged only, never sent to the client. */
const HINTS: Record<number, string> = {
  190: 'The access token is invalid or expired: generate a permanent System User token and update WHATSAPP_ACCESS_TOKEN',
  100: 'Meta rejected a parameter: check WHATSAPP_PHONE_NUMBER_ID (it is the Phone number ID, not the phone number) and the template parameters',
  131030: 'The recipient is not on the allowed list. A test phone number can only message numbers added under API Setup > "To"; a production number has no such limit',
  131026: 'The recipient cannot receive WhatsApp messages (no WhatsApp account, or an old client)',
  131042: 'Meta payment/billing problem on the WhatsApp Business account',
  132000: 'The number of template parameters does not match the template: check WHATSAPP_TEMPLATE_HAS_CODE_BUTTON',
  132001: 'The template does not exist in this language: check WHATSAPP_TEMPLATE_NAME and WHATSAPP_TEMPLATE_LANGUAGE (and that it is APPROVED)',
  132012: 'A template parameter has the wrong format (the code must be plain text)',
  132015: 'The template is paused or disabled by Meta because of quality: check WhatsApp Manager',
  132016: 'The template is paused or disabled by Meta: check WhatsApp Manager',
  133010: 'The sender phone number is not registered with the Cloud API: finish its registration in the Meta dashboard',
  80007: 'Meta rate limit for this WhatsApp Business account was reached',
};

/**
 * Sends login codes as a WhatsApp AUTHENTICATION TEMPLATE through the Meta WhatsApp Cloud API. WE generate, hash and verify the code
 * (auth.service.ts); Meta only delivers it. The message text is the approved template, so it cannot be changed from here.
 *
 *   POST {baseUrl}/{version}/{phoneNumberId}/messages   header `Authorization: Bearer <token>`
 *   { messaging_product: "whatsapp", to: <country code + number, no "+">, type: "template",
 *     template: { name, language: { code }, components: [ body{code}, (optional) button url index 0 {code} ] } }
 *   success: HTTP 2xx AND `messages[0].id` (the "wamid…"). That means Meta ACCEPTED the message; delivery is asynchronous.
 *
 * Failure handling is deliberately blunt, like the MSG91 sender: any problem (network, timeout, a redirect, a non-success answer)
 * throws SMS_DELIVERY_FAILED, auth.service invalidates the code it could not deliver, and the person simply asks again. The detail
 * (Meta's error code and text, plus a hint for the common ones) goes to the log, never to the client, and NEITHER THE CODE NOR THE
 * ACCESS TOKEN IS EVER LOGGED (provider text is scrubbed of both before it is written).
 */
export class WhatsAppSmsSender extends SmsSender {
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: WhatsAppOptions,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendOtp(toE164: string, code: string, _ttlSeconds: number): Promise<void> {
    const recipient = maskPhone(toE164);
    const components: unknown[] = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
    if (this.opts.codeButton) {
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
    }
    const payload = {
      messaging_product: 'whatsapp',
      to: toE164.replace(/^\+/, ''), // Meta wants the country code without the plus sign
      type: 'template',
      template: { name: this.opts.templateName, language: { code: this.opts.templateLanguage }, components },
    };

    let status: number | undefined;
    let text = '';
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/${this.opts.apiVersion}/${this.opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error', // never follow a redirect: it would carry the access token to wherever it points
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      // Duck-typed on purpose: fetch's timeout/abort errors are DOMExceptions, which are not always `instanceof Error` across realms.
      const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name).slice(0, 40) : '';
      this.fail(recipient, { reason: name || 'network error' });
    }

    let body: ProviderBody | null;
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ProviderBody) : null;
    } catch {
      body = null; // not JSON (an error page from a proxy, say)
    }

    const first: unknown = Array.isArray(body?.messages) ? (body?.messages as unknown[])[0] : undefined;
    const messageId = first && typeof first === 'object' && 'id' in first ? (first as { id: unknown }).id : undefined;
    if (status !== undefined && status >= 200 && status < 300 && typeof messageId === 'string' && messageId.length > 0) {
      this.logger.info({ provider: 'whatsapp', recipient, provider_message_id: messageId.slice(0, 120) }, 'WhatsApp message accepted by the provider');
      return;
    }

    const err = body?.error ?? undefined;
    const errCode = typeof err?.code === 'number' ? err.code : undefined;
    this.fail(recipient, {
      http_status: status,
      provider_error_code: errCode,
      provider_error_type: typeof err?.type === 'string' ? err.type.slice(0, 40) : undefined,
      provider_message: this.scrub(typeof err?.message === 'string' ? err.message : text, code),
      provider_trace_id: typeof err?.fbtrace_id === 'string' ? err.fbtrace_id.slice(0, 40) : undefined,
      hint: errCode !== undefined ? HINTS[errCode] : status === 401 || status === 403 ? HINTS[190] : undefined,
    });
  }

  /** Logs the operator-facing detail (no code, no token, masked number) and throws the client-facing error. Never returns. */
  private fail(recipient: string, detail: Record<string, unknown>): never {
    this.logger.warn({ provider: 'whatsapp', recipient, ...detail }, 'WhatsApp delivery failed');
    throw new DomainError('SMS_DELIVERY_FAILED', 'Could not deliver the verification code', 502);
  }

  /** Provider text is untrusted: bound its length and make sure it cannot carry the code or the token into a log line. */
  private scrub(text: string, code: string): string {
    return text.split(code).join('******').split(this.opts.accessToken).join('[token]').slice(0, 200); // scrub BEFORE cutting, so a code cannot be split in half and survive
  }
}
