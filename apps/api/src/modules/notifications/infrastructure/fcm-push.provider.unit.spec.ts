import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { FcmPushProvider } from './fcm-push.provider';

/** A local stand-in for Google's OAuth token endpoint and the FCM v1 send endpoint. */
class FakeGoogle {
  readonly tokenRequests: { assertion: string; grantType: string }[] = [];
  readonly sends: { auth: string; body: { message: { token: string; notification: { title: string; body: string }; data: Record<string, string> } } }[] = [];
  /** Access tokens FCM currently accepts. */
  valid = new Set<string>();
  private issued = 0;
  private server!: Server;
  base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(b));
    });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/token') {
      const form = new URLSearchParams(raw);
      this.tokenRequests.push({ assertion: form.get('assertion') ?? '', grantType: form.get('grant_type') ?? '' });
      const token = `access-${++this.issued}`;
      this.valid.add(token);
      return json(200, { access_token: token, expires_in: 3600 });
    }
    const body = JSON.parse(raw);
    const auth = req.headers['authorization'] ?? '';
    this.sends.push({ auth, body });
    if (!this.valid.has(auth.replace('Bearer ', ''))) return json(401, { error: { status: 'UNAUTHENTICATED' } });
    const token: string = body.message.token;
    if (token === 'unregistered') return json(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
    if (token === 'bad-token') return json(400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } });
    if (token === 'bad-message') return json(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.data' } });
    if (token === 'throttled') return json(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
    if (token === 'down') return json(503, { error: { status: 'UNAVAILABLE' } });
    return json(200, { name: `projects/p/messages/${this.sends.length}` });
  }
}

describe('FcmPushProvider', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = pair.publicKey;
  const account = JSON.stringify({ client_email: 'push@tokengo-test.iam.gserviceaccount.com', private_key: privatePem });
  let google: FakeGoogle;
  let fcm: FcmPushProvider;
  const msg = (token: string) => ({ token, title: 'Booking confirmed', body: 'Haircut · Thu, 8 Oct · 10:00 AM', data: { booking_id: 'b1' } });

  beforeEach(async () => {
    google = new FakeGoogle();
    await google.start();
    fcm = new FcmPushProvider({ projectId: 'p', serviceAccountJson: account, apiBaseUrl: google.base, tokenUrl: `${google.base}/token` });
  });
  afterEach(() => google.stop());

  it('authenticates with a correctly SIGNED service-account JWT (RS256, right issuer, audience and scope) and sends the message', async () => {
    const result = await fcm.send(msg('device-ok'));
    expect(result).toEqual({ kind: 'SENT', messageId: expect.stringMatching(/^projects\/p\/messages\//) });

    expect(google.tokenRequests).toHaveLength(1);
    expect(google.tokenRequests[0]!.grantType).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, sig] = google.tokenRequests[0]!.assertion.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'push@tokengo-test.iam.gserviceaccount.com', aud: `${google.base}/token`, scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);

    const sent = google.sends[0]!;
    expect(sent.auth).toBe('Bearer access-1');
    expect(sent.body.message).toMatchObject({ token: 'device-ok', notification: { title: 'Booking confirmed' }, data: { booking_id: 'b1' } });
  });

  it('reuses the access token across sends (one token request, not one per message)', async () => {
    await fcm.send(msg('device-ok'));
    await fcm.send(msg('device-ok'));
    expect(google.tokenRequests).toHaveLength(1);
  });

  it('fetches a fresh access token ONCE when FCM says the cached one is no longer valid, then succeeds', async () => {
    await fcm.send(msg('device-ok'));
    google.valid.clear(); // Google revoked the token
    expect(await fcm.send(msg('device-ok'))).toMatchObject({ kind: 'SENT' });
    expect(google.tokenRequests).toHaveLength(2);
  });

  it('retires a device ONLY when FCM says the token itself is unknown', async () => {
    expect(await fcm.send(msg('unregistered'))).toEqual({ kind: 'INVALID_TOKEN' });
    expect(await fcm.send(msg('bad-token'))).toEqual({ kind: 'INVALID_TOKEN' });
    // A malformed MESSAGE is our bug, not a dead device: it must not retire a good token.
    expect(await fcm.send(msg('bad-message'))).toMatchObject({ kind: 'REJECTED' });
  });

  it('treats throttling, outages and an unreachable server as retryable', async () => {
    expect(await fcm.send(msg('throttled'))).toEqual({ kind: 'RETRY', reason: 'FCM 429' });
    expect(await fcm.send(msg('down'))).toEqual({ kind: 'RETRY', reason: 'FCM 503' });
    const offline = new FcmPushProvider({ projectId: 'p', serviceAccountJson: account, apiBaseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/token' });
    expect(await offline.send(msg('device-ok'))).toMatchObject({ kind: 'RETRY' });
  });

  it('refuses a service account without credentials', () => {
    expect(() => new FcmPushProvider({ projectId: 'p', serviceAccountJson: '{}', apiBaseUrl: google.base, tokenUrl: `${google.base}/token` })).toThrow(/client_email and private_key/);
  });
});
