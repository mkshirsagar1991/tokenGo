import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { DomainError, createLogger } from '../../../shared-kernel';
import { WhatsAppSmsSender } from './whatsapp-sms-sender';

const TOKEN = 'EAAtest-9f3c1d7a-do-not-leak';
const PHONE_NUMBER_ID = '1234567890123';
const TEMPLATE = 'tokengo_auth_otp';
const CODE = '482916';
const PHONE = '+919876543210';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A stand-in for the Meta Graph API on loopback that records what it is sent and answers however the test says. */
async function fakeMeta(answer: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', path: new URL(req.url ?? '/', 'http://x').pathname, headers: req.headers, body };
      seen.push(entry);
      answer(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const accepted = { messaging_product: 'whatsapp', contacts: [{ input: '919876543210', wa_id: '919876543210' }], messages: [{ id: 'wamid.HBgM123' }] };

function logs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger('info', stream), text: () => lines.join('') };
}

describe('WhatsAppSmsSender', () => {
  const open: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });
  async function setup(answer: Parameters<typeof fakeMeta>[0], extra: { timeoutMs?: number; codeButton?: boolean } = {}) {
    const fake = await fakeMeta(answer);
    open.push(fake);
    const log = logs();
    const sender = new WhatsAppSmsSender(
      {
        accessToken: TOKEN,
        phoneNumberId: PHONE_NUMBER_ID,
        templateName: TEMPLATE,
        templateLanguage: 'en_IN',
        codeButton: extra.codeButton ?? true,
        apiVersion: 'v21.0',
        baseUrl: fake.url,
        ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
      },
      log.logger,
    );
    return { fake, log, sender };
  }
  const failure = async (p: Promise<void>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'SMS_DELIVERY_FAILED', status: 502, message: 'Could not deliver the verification code' });
  };

  it('sends the documented request: POST /{version}/{phoneNumberId}/messages, bearer token, number without "+", code in body and button', async () => {
    const { fake, sender, log } = await setup((_r, res) => json(res, 200, accepted));
    await sender.sendOtp(PHONE, CODE, 300);

    expect(fake.seen).toHaveLength(1);
    const r = fake.seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.path).toBe(`/v21.0/${PHONE_NUMBER_ID}/messages`);
    expect(r.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(r.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: {
        name: TEMPLATE,
        language: { code: 'en_IN' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: CODE }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: CODE }] },
        ],
      },
    });
    // the secret travels in the header only
    expect(r.body).not.toContain(TOKEN);
    // and a success is logged WITHOUT the code or the full number
    const out = log.text();
    expect(out).toContain('wamid.HBgM123');
    expect(out).toContain('+91 ••••• ••210');
    expect(out).not.toContain(CODE);
    expect(out).not.toContain('9876543210');
    expect(out).not.toContain(TOKEN);
  });

  it('omits the button component for a template without a "Copy code" button', async () => {
    const { fake, sender } = await setup((_r, res) => json(res, 200, accepted), { codeButton: false });
    await sender.sendOtp(PHONE, CODE, 300);
    const components = JSON.parse(fake.seen[0]!.body).template.components as { type: string }[];
    expect(components.map((c) => c.type)).toEqual(['body']);
  });

  describe('every way it can go wrong is a clean SMS_DELIVERY_FAILED, with the detail in the log and nothing sensitive in it', () => {
    it('a Meta error object (HTTP 400) fails, and the log carries its code, text and a hint', async () => {
      const { sender, log } = await setup((_r, res) =>
        json(res, 404, { error: { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001, fbtrace_id: 'AbC123' } }),
      );
      await failure(sender.sendOtp(PHONE, CODE, 300));
      const out = log.text();
      expect(out).toContain('"provider_error_code":132001');
      expect(out).toContain('Template name does not exist');
      expect(out).toContain('WHATSAPP_TEMPLATE_LANGUAGE');
      expect(out).toContain('AbC123');
      expect(out).not.toContain(CODE);
      expect(out).not.toContain(TOKEN);
    });

    it('an expired token (190) fails and tells the operator to renew it', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 401, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text()).toContain('WHATSAPP_ACCESS_TOKEN');
      expect(log.text()).not.toContain(TOKEN);
    });

    it('an unlisted test recipient (131030) fails with its hint', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 400, { error: { message: '(#131030) Recipient phone number not in allowed list', code: 131030 } }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text()).toContain('allowed list');
    });

    it('HTTP 200 without a message id is NOT a success', async () => {
      const { sender } = await setup((_r, res) => json(res, 200, { messaging_product: 'whatsapp', messages: [] }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
    });

    it('a server error with an HTML page fails', async () => {
      const { sender, log } = await setup((_r, res) => res.writeHead(502, { 'content-type': 'text/html' }).end('<html>Bad gateway</html>'));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text()).toContain('"http_status":502');
    });

    it('a 200 that is not JSON fails', async () => {
      const { sender } = await setup((_r, res) => res.writeHead(200).end('OK'));
      await failure(sender.sendOtp(PHONE, CODE, 300));
    });

    it('a JSON body that is not an object fails (null, a number, an array)', async () => {
      for (const body of ['null', '42', '[]']) {
        const { sender } = await setup((_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
        await failure(sender.sendOtp(PHONE, CODE, 300));
      }
    });

    it('a provider that never answers is cut off at the timeout', async () => {
      const { sender, log } = await setup(() => undefined, { timeoutMs: 150 });
      const started = Date.now();
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(log.text()).toContain('TimeoutError');
    });

    it('an unreachable provider fails', async () => {
      const fake = await fakeMeta((_r, res) => json(res, 200, accepted));
      const log = logs();
      const sender = new WhatsAppSmsSender(
        { accessToken: TOKEN, phoneNumberId: PHONE_NUMBER_ID, templateName: TEMPLATE, templateLanguage: 'en_IN', codeButton: true, apiVersion: 'v21.0', baseUrl: fake.url },
        log.logger,
      );
      await fake.close(); // nothing listens any more
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text()).not.toContain(TOKEN);
    });

    it('does NOT follow a redirect, so the access token can never be carried to another host', async () => {
      const elsewhere = await fakeMeta((_r, res) => json(res, 200, accepted));
      open.push(elsewhere);
      const { sender } = await setup((_r, res) => res.writeHead(302, { location: `${elsewhere.url}/steal` }).end());
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(elsewhere.seen).toHaveLength(0);
    });

    it('scrubs the code and the token out of provider text before it reaches the log', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 400, { error: { message: `Invalid parameter ${CODE} for token ${TOKEN}, call us`, code: 100 } }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      const out = log.text();
      expect(out).toContain('Invalid parameter');
      expect(out).not.toContain(CODE);
      expect(out).not.toContain(TOKEN);
    });

    it('bounds the provider text it logs (a huge error page cannot flood the log)', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 500, { error: { message: 'x'.repeat(50_000), code: 1 } }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text().length).toBeLessThan(2_500);
    });
  });
});
