import { WebhookSignatureError } from './payment-provider';
import { isValidRefundIdempotencyKey, mapRazorpayPayment, mapRazorpayRefund, parseRazorpayWebhook, signRazorpayWebhook, verifyRazorpaySignature } from './razorpay';

// Shapes copied from Razorpay's published API reference (payment entity, refund entity, webhook envelope).
const paymentFromDocs = { id: 'pay_DG4ZdRK8ZnXC3k', entity: 'payment', amount: 5000, currency: 'INR', status: 'captured', order_id: 'order_DBJOWzybf0sJbb', method: 'card', amount_refunded: 0, refund_status: null, captured: true, error_code: null, error_description: null, error_reason: null, created_at: 1678452635 };
const refundFromDocs = { id: 'rfnd_FP8QHiV938haTz', entity: 'refund', amount: 500100, receipt: 'Receipt No. 31', currency: 'INR', payment_id: 'pay_29QQoUBi66xm2f', notes: {}, created_at: 1597078866, batch_id: null, status: 'processed', speed_processed: 'normal', speed_requested: 'normal' };

describe('Razorpay payment mapping', () => {
  it('maps the documented captured payment exactly (paise as bigint, unix seconds as Date)', () => {
    expect(mapRazorpayPayment(paymentFromDocs)).toEqual({ provider: 'razorpay', paymentId: 'pay_DG4ZdRK8ZnXC3k', orderId: 'order_DBJOWzybf0sJbb', status: 'CAPTURED', amountMinor: 5000n, currency: 'INR', amountRefundedMinor: 0n, createdAt: new Date(1678452635_000) });
  });

  it.each([
    ['captured', 'CAPTURED'],
    ['refunded', 'CAPTURED'], // it WAS captured; the refund is tracked through amount_refunded
    ['failed', 'FAILED'],
    ['authorized', 'PENDING'], // NOT money: capture is not automatic by default at Razorpay
    ['created', 'PENDING'],
    ['something_new_razorpay_adds_later', 'PENDING'], // an unknown state must fail CLOSED, never be credited
  ])('status %s -> %s', (razorpay, ours) => {
    expect(mapRazorpayPayment({ ...paymentFromDocs, status: razorpay }).status).toBe(ours);
  });

  it('carries the refunded amount and a bounded failure reason', () => {
    expect(mapRazorpayPayment({ ...paymentFromDocs, status: 'refunded', amount_refunded: 5000 }).amountRefundedMinor).toBe(5000n);
    const failed = mapRazorpayPayment({ ...paymentFromDocs, status: 'failed', error_reason: 'incorrect_otp', error_description: 'x'.repeat(500) });
    expect(failed.failureReason).toBe('incorrect_otp');
    expect(mapRazorpayPayment({ ...paymentFromDocs, status: 'failed', error_description: 'x'.repeat(500) }).failureReason).toHaveLength(200);
  });

  it('treats a payment with no order as not ours (empty order id), not as an error', () => {
    expect(mapRazorpayPayment({ ...paymentFromDocs, order_id: null }).orderId).toBe('');
  });

  it.each([
    ['a fractional amount', { amount: 50.5 }],
    ['a string amount', { amount: '5000' }],
    ['a negative amount', { amount: -1 }],
    ['an unsafe integer', { amount: Number.MAX_SAFE_INTEGER + 2 }],
    ['a missing id', { id: undefined }],
    ['a missing currency', { currency: undefined }],
    ['a bad timestamp', { created_at: 'yesterday' }],
    ['a bad refunded amount', { amount_refunded: 1.5 }],
  ])('refuses %s instead of rounding or guessing', (_l, patch) => {
    expect(() => mapRazorpayPayment({ ...paymentFromDocs, ...patch })).toThrow(/Razorpay response/);
  });
});

describe('Razorpay refund mapping', () => {
  it('maps the documented processed refund', () => {
    expect(mapRazorpayRefund(refundFromDocs)).toEqual({ provider: 'razorpay', refundId: 'rfnd_FP8QHiV938haTz', paymentId: 'pay_29QQoUBi66xm2f', amountMinor: 500100n, status: 'PROCESSED', reference: 'Receipt No. 31' });
  });

  it.each([
    ['processed', 'PROCESSED'],
    ['failed', 'FAILED'],
    ['pending', 'PENDING'],
    ['unknown', 'PENDING'],
  ])('status %s -> %s', (razorpay, ours) => {
    expect(mapRazorpayRefund({ ...refundFromDocs, status: razorpay }).status).toBe(ours);
  });

  it('correlates by our own reference: notes.reference first, then the receipt, never invented', () => {
    expect(mapRazorpayRefund({ ...refundFromDocs, notes: { reference: 'our-id-123456' } }).reference).toBe('our-id-123456');
    expect(mapRazorpayRefund({ ...refundFromDocs, notes: [] }).reference).toBe('Receipt No. 31');
    expect(mapRazorpayRefund({ ...refundFromDocs, notes: null, receipt: undefined }).reference).toBe('');
  });
});

describe('Razorpay webhook signature (HMAC-SHA256 of the raw body)', () => {
  const secret = 'whsec_unit_test';
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1' } } } }));

  it('verifies a genuine signature and rejects every kind of wrong one', () => {
    const sig = signRazorpayWebhook(secret, body);
    expect(verifyRazorpaySignature(secret, body, sig)).toBe(true);
    expect(verifyRazorpaySignature(secret, body, sig.toUpperCase())).toBe(true); // hex is case-insensitive
    expect(verifyRazorpaySignature('another secret', body, sig)).toBe(false);
    expect(verifyRazorpaySignature(secret, Buffer.from(body.toString().replace('pay_1', 'pay_2')), sig)).toBe(false);
    for (const bad of [undefined, '', 'abc', 'z'.repeat(64), sig.slice(1), `${sig}0`]) expect(verifyRazorpaySignature(secret, body, bad)).toBe(false);
  });

  it('signs the BYTES, not the parsed JSON (re-serialising would change the signature)', () => {
    const sig = signRazorpayWebhook(secret, body);
    const reparsed = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyRazorpaySignature(secret, reparsed, sig)).toBe(false);
  });
});

describe('Razorpay webhook envelope', () => {
  const envelope = (event: string, payload: object) => Buffer.from(JSON.stringify({ entity: 'event', account_id: 'acc_1', event, contains: [], payload, created_at: 1 }));
  const pay = { payment: { entity: { id: 'pay_9', order_id: 'order_9' } } };

  it.each([
    ['payment.captured', 'payment.captured'],
    ['payment.authorized', 'payment.captured'], // routed as "go and look": the fetch decides it is not yet money
    ['order.paid', 'payment.captured'],
    ['payment.failed', 'payment.failed'],
  ])('%s -> %s with the payment id as a hint', (event, type) => {
    expect(parseRazorpayWebhook(envelope(event, pay), 'evt_1')).toEqual({ eventId: 'evt_1', type, data: { payment_id: 'pay_9', order_id: 'order_9' } });
  });

  it.each([
    ['refund.created', 'refund.processed'],
    ['refund.processed', 'refund.processed'],
    ['refund.failed', 'refund.failed'],
  ])('%s -> %s with the refund id as a hint', (event, type) => {
    expect(parseRazorpayWebhook(envelope(event, { refund: { entity: { id: 'rfnd_9', payment_id: 'pay_9' } } }), 'evt_2')).toEqual({ eventId: 'evt_2', type, data: { refund_id: 'rfnd_9', payment_id: 'pay_9' } });
  });

  it('passes unsupported events through with no data, to be acknowledged and ignored', () => {
    expect(parseRazorpayWebhook(envelope('payment.pending', pay), 'evt_3')).toEqual({ eventId: 'evt_3', type: 'payment.pending', data: {} });
  });

  it('tolerates a missing payload section (the receiver then ignores the event)', () => {
    expect(parseRazorpayWebhook(envelope('payment.captured', {}), 'evt_4').data).toEqual({ payment_id: undefined, order_id: undefined });
  });

  it.each([
    ['no event id', Buffer.from('{"event":"payment.captured"}'), undefined],
    ['an over-long event id', Buffer.from('{"event":"payment.captured"}'), 'x'.repeat(201)],
    ['invalid JSON', Buffer.from('not json'), 'evt_5'],
    ['JSON that is not an event', Buffer.from('[1,2]'), 'evt_6'],
    ['an event without a name', Buffer.from('{"payload":{}}'), 'evt_7'],
  ])('rejects %s as malformed', (_l, raw, id) => {
    expect(() => parseRazorpayWebhook(raw, id)).toThrow(WebhookSignatureError);
  });
});

describe('refund idempotency keys (Razorpay: 10+ chars of letters, digits, - and _)', () => {
  it('accepts our UUID refund ids and rejects what Razorpay would refuse', () => {
    expect(isValidRefundIdempotencyKey('0192a5c4-7c1e-7e3a-8d2f-1b2c3d4e5f60')).toBe(true);
    for (const bad of ['short', 'has space in it', 'bad/char/here!!', '']) expect(isValidRefundIdempotencyKey(bad)).toBe(false);
  });
});
