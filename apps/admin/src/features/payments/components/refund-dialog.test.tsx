import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, stubFetch } from '@/test/render';
import type { PaymentTransaction, Refund } from '../types';
import { RefundButton, RefundDialog, refundableMinor, validateRefundAmount } from './refund-dialog';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => '/' }));
vi.mock('next/link', () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));

const TX: PaymentTransaction = {
  id: '01a11539-732a-79ea-a04c-6014df75ae84',
  intent_id: 'i',
  customer_id: 'c',
  provider: 'razorpay',
  provider_payment_id: 'pay_TEST123',
  status: 'CAPTURED',
  amount: { amount_minor: 50_000, currency: 'INR' },
  failure_reason: null,
  ledger_txn_id: null,
  created_at: '2026-10-07T07:17:28.976Z',
};
const refund = (minor: number, status: Refund['status'], id = Math.random().toString(16).slice(2)): Refund => ({ id, payment_transaction_id: TX.id, amount: { amount_minor: minor, currency: 'INR' }, status, reason: 'x', failure_reason: null, created_at: '', updated_at: '' });

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe('refundable amount', () => {
  it('is the payment minus every refund that has not failed', () => {
    expect(refundableMinor(50_000, [])).toBe(50_000n);
    expect(refundableMinor(50_000, [refund(20_000, 'SUCCEEDED'), refund(10_000, 'FAILED'), refund(5_000, 'PROCESSING')])).toBe(25_000n);
    expect(refundableMinor(50_000, [refund(50_000, 'SUCCEEDED')])).toBe(0n);
    expect(refundableMinor(50_000, [refund(60_000, 'SUCCEEDED')])).toBe(0n); // never negative
  });

  it('validates a typed amount against what remains', () => {
    expect(validateRefundAmount('250.50', 30_000n)).toEqual({ ok: true, minor: 25_050 });
    expect(validateRefundAmount('300', 30_000n)).toEqual({ ok: true, minor: 30_000 });
    expect(validateRefundAmount('300.01', 30_000n)).toMatchObject({ ok: false, error: expect.stringContaining('₹300') });
    expect(validateRefundAmount('0', 30_000n).ok).toBe(false);
    expect(validateRefundAmount('-5', 30_000n).ok).toBe(false);
    expect(validateRefundAmount('1.234', 30_000n).ok).toBe(false);
    expect(validateRefundAmount('abc', 30_000n).ok).toBe(false);
  });
});

describe('RefundButton', () => {
  it('is hidden without the refund permission and for payments that are not captured', () => {
    stubFetch();
    const first = renderApp(<RefundButton tx={TX} />, { permissions: ['payments:read'] });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    first.unmount();
    renderApp(<RefundButton tx={{ ...TX, status: 'QUARANTINED' }} />, { permissions: ['refund:create'] });
    expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
  });
});

describe('RefundDialog', () => {
  const open = (responder?: Parameters<typeof stubFetch>[0]) => {
    const fetchStub = stubFetch(
      responder ?? ((c) => (c.method === 'GET' ? { body: { data: [refund(20_000, 'SUCCEEDED'), refund(10_000, 'FAILED')], meta: { next_cursor: null } } } : { status: 200, body: { data: { ...refund(30_000, 'PROCESSING', 'new-refund-id'), reason: 'dup' } } })),
    );
    const utils = renderApp(<RefundDialog tx={TX} onClose={vi.fn()} />, { permissions: ['refund:create'] });
    return { ...utils, ...fetchStub };
  };

  it('loads existing refunds from the API and shows what can still be refunded', async () => {
    const { calls } = open();
    expect(await screen.findByText('Can still refund')).toBeInTheDocument();
    const box = screen.getByText('Can still refund').closest('div')!;
    expect(within(box).getByText('₹300')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ method: 'GET' });
    expect(calls[0]!.url).toContain('/bff/api/admin/payments/refunds');
    expect(calls[0]!.url).toContain(`payment_transaction_id=${TX.id}`);
  });

  it('cannot be confirmed without a reason', async () => {
    open();
    await screen.findByText('Can still refund');
    expect(screen.getByRole('button', { name: /Refund ₹300/ })).toBeDisabled();
  });

  it('refuses a partial amount above what remains, and accepts one at or below it', async () => {
    const { user } = open();
    await screen.findByText('Can still refund');
    await user.type(screen.getByLabelText(/Reason/), 'customer paid twice');
    await user.click(screen.getByLabelText(/Refund part of it/));
    const amount = screen.getByLabelText(/Amount in rupees/);
    await user.type(amount, '350');
    expect(screen.getByText(/more than the ₹300 that can still be refunded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Refund$/ })).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, '120.50');
    expect(screen.getByRole('button', { name: 'Refund ₹120.50' })).toBeEnabled();
    await user.clear(amount);
    await user.type(amount, '12.345');
    expect(screen.getByText(/at most two decimal places/i)).toBeInTheDocument();
  });

  it('sends an explicit amount in paise, the reason, the CSRF token and an Idempotency-Key', async () => {
    const { user, calls } = open();
    await screen.findByText('Can still refund');
    await user.type(screen.getByLabelText(/Reason/), 'customer paid twice');
    await user.click(screen.getByRole('button', { name: 'Refund ₹300' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/bff/api/admin/payments/refunds');
    expect(post.body).toEqual({ payment_transaction_id: TX.id, amount_minor: 30_000, reason: 'customer paid twice' });
    expect(post.headers['idempotency-key']).toMatch(/^refund-[A-Za-z0-9-]{8,}$/);
    expect(post.headers['x-csrf-token']).toBe('csrf-test-token');
    expect(post.headers['x-requested-with']).toBe('tokengo-admin');
    expect(await screen.findByText(/Refund is being processed/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('disables the button while the request is in flight and sends it only once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { user, calls } = open(async (c) => {
      if (c.method === 'GET') return { body: { data: [], meta: { next_cursor: null } } };
      await gate;
      return { body: { data: refund(50_000, 'PROCESSING', 'rid') } };
    });
    await screen.findByText('Can still refund');
    await user.type(screen.getByLabelText(/Reason/), 'customer paid twice');
    const btn = screen.getByRole('button', { name: 'Refund ₹500' });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await user.click(btn).catch(() => undefined);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    release();
    await screen.findByText(/Refund is being processed/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('reuses the same idempotency key when retrying after a failure (no second refund can result)', async () => {
    let n = 0;
    const { user, calls } = open((c) => {
      if (c.method === 'GET') return { body: { data: [], meta: { next_cursor: null } } };
      n += 1;
      return n === 1 ? { status: 502, body: { code: 'NETWORK_ERROR', detail: 'down' } } : { body: { data: refund(50_000, 'PROCESSING', 'rid') } };
    });
    await screen.findByText('Can still refund');
    await user.type(screen.getByLabelText(/Reason/), 'customer paid twice');
    await user.click(screen.getByRole('button', { name: 'Refund ₹500' }));
    await screen.findByText(/Could not reach the TokenGo API/i);
    await user.click(screen.getByRole('button', { name: 'Refund ₹500' }));
    await screen.findByText(/Refund is being processed/);
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('explains a server-side over-refund refusal with the amount that is actually left', async () => {
    const { user } = open((c) => (c.method === 'GET' ? { body: { data: [], meta: { next_cursor: null } } } : { status: 422, body: { code: 'REFUND_EXCEEDS_PAYMENT', detail: 'x', errors: { refundable: { amount_minor: 1_000, currency: 'INR' } } } }));
    await screen.findByText('Can still refund');
    await user.type(screen.getByLabelText(/Reason/), 'customer paid twice');
    await user.click(screen.getByRole('button', { name: 'Refund ₹500' }));
    expect(await screen.findByText(/₹10 left/)).toBeInTheDocument();
  });

  it('offers nothing to refund when the payment is already fully refunded', async () => {
    open((c) => (c.method === 'GET' ? { body: { data: [refund(50_000, 'SUCCEEDED')], meta: { next_cursor: null } } } : {}));
    expect(await screen.findByText('Nothing is left to refund on this payment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Refund$/ })).toBeDisabled();
  });
});
