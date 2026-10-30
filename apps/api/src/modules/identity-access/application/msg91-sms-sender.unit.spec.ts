import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { DomainError, createLogger } from '../../../shared-kernel';
import { Msg91SmsSender } from './msg91-sms-sender';

const KEY = 'AUTHKEY-9f3c1d7a-do-not-leak';
const TEMPLATE = '65a1b2c3d4e5f6a7b8c9d0e1';
const CODE = '482916';
const PHONE = '+919876543210';

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A stand-in for MSG91 on loopback that records what it is sent and answers however the test says. */
async function fakeMsg91(answer: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const entry: Seen = { method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
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

function logs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger('info', stream), text: () => lines.join('') };
}

describe('Msg91SmsSender', () => {
  const open: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });
  async function setup(answer: Parameters<typeof fakeMsg91>[0], timeoutMs?: number) {
    const fake = await fakeMsg91(answer);
    open.push(fake);
    const log = logs();
    const sender = new Msg91SmsSender({ authKey: KEY, templateId: TEMPLATE, baseUrl: fake.url, ...(timeoutMs ? { timeoutMs } : {}) }, log.logger);
    return { fake, log, sender };
  }
  const failure = async (p: Promise<void>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'SMS_DELIVERY_FAILED', status: 502, message: 'Could not deliver the verification code' });
  };

  it('sends the documented request: POST /api/v5/otp, auth key in a header, number without "+", code and expiry in minutes', async () => {
    const { fake, sender, log } = await setup((_r, res) => json(res, 200, { type: 'success', request_id: 'req-123' }));
    await sender.sendOtp(PHONE, CODE, 300);

    expect(fake.seen).toHaveLength(1);
    const r = fake.seen[0]!;
    const expected = { template_id: TEMPLATE, mobile: '919876543210', otp: CODE, otp_expiry: '5', otp_length: '6' };
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/api/v5/otp');
    expect(r.headers['authkey']).toBe(KEY);
    expect(r.query).toEqual(expected); // the two documented forms carry identical values
    expect(JSON.parse(r.body)).toEqual(expected);
    // the secret travels in the header only
    expect(JSON.stringify([r.path, r.query, r.body])).not.toContain(KEY);
    // and a success is logged WITHOUT the code or the full number
    const out = log.text();
    expect(out).toContain('req-123');
    expect(out).toContain('+91 ••••• ••210');
    expect(out).not.toContain(CODE);
    expect(out).not.toContain('9876543210');
    expect(out).not.toContain(KEY);
  });

  it.each([
    [300, '5'],
    [301, '6'],
    [60, '1'],
    [30, '1'],
  ])('rounds a %i s lifetime UP to whole minutes (%s)', async (ttl, minutes) => {
    const { fake, sender } = await setup((_r, res) => json(res, 200, { type: 'success' }));
    await sender.sendOtp(PHONE, CODE, ttl);
    expect(fake.seen[0]!.query['otp_expiry']).toBe(minutes);
  });

  it('omits otp_length for a code length MSG91 does not support', async () => {
    const { fake, sender } = await setup((_r, res) => json(res, 200, { type: 'success' }));
    await sender.sendOtp(PHONE, '12345678', 300);
    expect(fake.seen[0]!.query['otp_length']).toBeUndefined();
  });

  describe('every way it can go wrong is a clean SMS_DELIVERY_FAILED, with the detail in the log and nothing sensitive in it', () => {
    it('HTTP 200 carrying {"type":"error"} is NOT a success (MSG91 reports some failures this way)', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 200, { type: 'error', message: 'Template not found' }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      const out = log.text();
      expect(out).toContain('Template not found');
      expect(out).toContain('"http_status":200');
      expect(out).not.toContain(CODE);
      expect(out).not.toContain(KEY);
    });

    it('a 2xx without type "success" is not a success either', async () => {
      const { sender } = await setup((_r, res) => json(res, 200, { message: 'queued' }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
    });

    it('a rejected key (401) fails, and the log tells the operator about the key and the IP allow-list', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 401, { type: 'error', message: 'AuthenticationFailure' }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text()).toMatch(/IP security/);
      expect(log.text()).not.toContain(KEY);
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
      const { sender, log } = await setup(() => undefined, 150);
      const started = Date.now();
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(log.text()).toContain('TimeoutError');
    });

    it('an unreachable provider fails', async () => {
      const fake = await fakeMsg91((_r, res) => json(res, 200, { type: 'success' }));
      const log = logs();
      const sender = new Msg91SmsSender({ authKey: KEY, templateId: TEMPLATE, baseUrl: fake.url }, log.logger);
      await fake.close(); // nothing listens any more
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text()).not.toContain(KEY);
    });

    it('does NOT follow a redirect, so the auth key can never be carried to another host', async () => {
      const elsewhere = await fakeMsg91((_r, res) => json(res, 200, { type: 'success' }));
      open.push(elsewhere);
      const { sender } = await setup((_r, res) => res.writeHead(302, { location: `${elsewhere.url}/steal` }).end());
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(elsewhere.seen).toHaveLength(0);
    });

    it('scrubs the code and the auth key out of provider text before it reaches the log', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 400, { type: 'error', message: `Invalid otp ${CODE} for key ${KEY}, call us` }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      const out = log.text();
      expect(out).toContain('Invalid otp');
      expect(out).not.toContain(CODE);
      expect(out).not.toContain(KEY);
    });

    it('bounds the provider text it logs (a huge error page cannot flood the log)', async () => {
      const { sender, log } = await setup((_r, res) => json(res, 500, { type: 'error', message: 'x'.repeat(50_000) }));
      await failure(sender.sendOtp(PHONE, CODE, 300));
      expect(log.text().length).toBeLessThan(2_000);
    });
  });
});
