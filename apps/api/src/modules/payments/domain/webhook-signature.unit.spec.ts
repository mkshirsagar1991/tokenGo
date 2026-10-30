import { SIGNATURE_TOLERANCE_SECONDS, signWebhook, verifyWebhookSignature } from './webhook-signature';

const secret = Buffer.from('0123456789abcdef0123456789abcdef');
const body = Buffer.from('{"id":"evt_1","type":"payment.captured","data":{"payment_id":"pay_1"}}');
const T = 1_800_000_000; // unix seconds
const nowMs = T * 1000;

describe('webhook signature (HMAC-SHA256 over "<t>.<raw body>")', () => {
  it('accepts a genuine, fresh signature', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, T, body), body, nowMs)).toEqual({ ok: true });
  });

  it('rejects when the body was changed after signing (a single byte)', () => {
    const header = signWebhook(secret, T, body);
    const tampered = Buffer.from(body.toString().replace('pay_1', 'pay_2'));
    expect(verifyWebhookSignature(secret, header, tampered, nowMs)).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('rejects a signature made with a different secret', () => {
    const header = signWebhook(Buffer.from('another secret another secret 1234'), T, body);
    expect(verifyWebhookSignature(secret, header, body, nowMs)).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('binds the timestamp: replaying an old signature under a fresh timestamp fails', () => {
    const old = signWebhook(secret, T - 10_000, body);
    const forged = old.replace(`t=${T - 10_000}`, `t=${T}`);
    expect(verifyWebhookSignature(secret, forged, body, nowMs)).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('rejects stale and far-future timestamps, but accepts the edge of the tolerance', () => {
    const at = (t: number) => verifyWebhookSignature(secret, signWebhook(secret, t, body), body, nowMs);
    expect(at(T - SIGNATURE_TOLERANCE_SECONDS)).toEqual({ ok: true });
    expect(at(T + SIGNATURE_TOLERANCE_SECONDS)).toEqual({ ok: true });
    expect(at(T - SIGNATURE_TOLERANCE_SECONDS - 1)).toEqual({ ok: false, reason: 'STALE' });
    expect(at(T + SIGNATURE_TOLERANCE_SECONDS + 1)).toEqual({ ok: false, reason: 'STALE' });
  });

  it('reports a missing header and malformed headers distinctly, never throwing', () => {
    expect(verifyWebhookSignature(secret, undefined, body, nowMs)).toEqual({ ok: false, reason: 'MISSING' });
    for (const bad of ['', 'garbage', 't=abc,v1=00', `t=${T}`, `t=${T},v1=zz`, `t=${T},v1=${'a'.repeat(63)}`, `v1=${'a'.repeat(64)}`, `t=${T},v1`]) {
      expect(verifyWebhookSignature(secret, bad, body, nowMs)).toEqual({ ok: false, reason: expect.stringMatching(/MALFORMED|MISSING/) });
    }
  });

  it('supports secret rotation: any listed secret may have signed, and any v1 entry may match', () => {
    const next = Buffer.from('the next secret, used after rotation');
    const signedWithOld = signWebhook(secret, T, body);
    expect(verifyWebhookSignature([next, secret], signedWithOld, body, nowMs)).toEqual({ ok: true });
    const both = `${signWebhook(next, T, body)},v1=${signWebhook(secret, T, body).split('v1=')[1]}`;
    expect(verifyWebhookSignature(secret, both, body, nowMs)).toEqual({ ok: true });
    expect(verifyWebhookSignature(Buffer.from('unrelated unrelated unrelated 12'), both, body, nowMs)).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('is independent of how the body would parse (works on bytes, not on JSON)', () => {
    const reordered = Buffer.from('{"data":{"payment_id":"pay_1"},"type":"payment.captured","id":"evt_1"}');
    const header = signWebhook(secret, T, body);
    expect(verifyWebhookSignature(secret, header, reordered, nowMs)).toEqual({ ok: false, reason: 'MISMATCH' });
  });
});
