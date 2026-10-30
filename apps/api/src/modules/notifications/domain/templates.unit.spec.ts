import { BookingFacts, CATEGORIES, bookingDrafts, payoutDraft, rupees, walletDraft, whenText } from './templates';

const f: BookingFacts = { id: 'b1', reference: 'TG-1', serviceName: 'Haircut', localStart: '2026-10-08T10:00', locationName: 'ABC Salon — Koregaon Park' };

describe('notification templates', () => {
  describe('formatting', () => {
    it('shows the LOCATION wall-clock with weekday and 12-hour time, no zone conversion', () => {
      expect(whenText('2026-10-08T10:00')).toBe('Thu, 8 Oct · 10:00 AM');
      expect(whenText('2026-10-08T00:05')).toBe('Thu, 8 Oct · 12:05 AM');
      expect(whenText('2026-12-31T23:30')).toBe('Thu, 31 Dec · 11:30 PM');
      expect(whenText('2026-10-08T12:00')).toBe('Thu, 8 Oct · 12:00 PM');
      expect(whenText('garbage')).toBe('garbage');
    });

    it('formats rupees with Indian grouping using integers only', () => {
      expect(rupees(30000)).toBe('₹300');
      expect(rupees(12500000)).toBe('₹1,25,000');
      expect(rupees(9950)).toBe('₹99.50');
      expect(rupees(5n)).toBe('₹0.05');
    });
  });

  describe('booking events', () => {
    it('a request tells the SALON; an approval tells the CUSTOMER', () => {
      const req = bookingDrafts('booking.requested', {}, f);
      expect(req.provider).toMatchObject({ audience: 'PROVIDER', kind: 'BOOKING_REQUESTED', category: 'BOOKING' });
      expect(req.customer).toBeUndefined();
      const ok = bookingDrafts('booking.approved', {}, f);
      expect(ok.customer?.body).toContain('Haircut · Thu, 8 Oct · 10:00 AM at ABC Salon');
      expect(ok.provider).toBeUndefined();
    });

    it('cancellation goes to the OTHER party, and a provider cancellation promises the refund the policy gives (in full)', () => {
      expect(bookingDrafts('booking.cancelled', { by: 'CUSTOMER' }, f).provider?.kind).toBe('BOOKING_CANCELLED_BY_CUSTOMER');
      const byProvider = bookingDrafts('booking.cancelled', { by: 'PROVIDER' }, f);
      expect(byProvider.customer?.body).toMatch(/refunded in full/);
      expect(byProvider.provider).toBeUndefined();
    });

    it('expiry tells both sides; settlement pays the salon and asks the customer for a review, once', () => {
      const exp = bookingDrafts('booking.expired', {}, f);
      expect(exp.customer && exp.provider).toBeTruthy();
      const settled = bookingDrafts('booking.settled', { provider_net_minor: 27000 }, f);
      expect(settled.provider?.body).toContain('₹270');
      expect(settled.customer).toMatchObject({ kind: 'REVIEW_REQUESTED', category: 'REVIEW', dedupeKey: 'review-request:b1' });
    });

    it('internal/time-driven events say nothing', () => {
      expect(bookingDrafts('booking.response_deadline', {}, f)).toEqual({});
      expect(bookingDrafts('booking.settlement_due', {}, f)).toEqual({});
    });

    it('every draft is dedupe-keyed by event and booking, so a retried event never notifies twice', () => {
      const a = bookingDrafts('booking.approved', {}, f).customer!;
      const b = bookingDrafts('booking.approved', {}, f).customer!;
      expect(a.dedupeKey).toBe(b.dedupeKey);
      expect(a.dedupeKey).not.toBe(bookingDrafts('booking.started', {}, f).customer!.dedupeKey);
    });

    it('carries ids only in data (no personal details)', () => {
      for (const t of ['booking.requested', 'booking.approved', 'booking.rejected', 'booking.expired', 'booking.completed', 'booking.settled', 'booking.reminder_due']) {
        const d = bookingDrafts(t, { provider_net_minor: 100 }, f);
        for (const draft of [d.customer, d.provider]) if (draft) expect(draft.data).toEqual({ booking_id: 'b1' });
      }
    });
  });

  describe('money events', () => {
    it('wallet credit and refunds', () => {
      expect(walletDraft('ledger.wallet_credited', { amount_minor: 50000, txn_id: 't1' })).toMatchObject({ title: '₹500 added to your wallet', dedupeKey: 'wallet:t1', category: 'WALLET' });
      expect(walletDraft('payments.refund_succeeded', { refund_id: 'r1', amount_minor: 15000 })?.body).toContain('₹150');
      expect(walletDraft('payments.refund_failed', { refund_id: 'r1' })?.kind).toBe('REFUND_FAILED');
      expect(walletDraft('booking.approved', {})).toBeUndefined();
    });

    it('payouts never leak the provider error text', () => {
      const failed = payoutDraft('settlement.payout_failed', { payout_id: 'p1', reason: 'beneficiary account 123456789012 closed' });
      expect(failed?.body).not.toMatch(/\d{6,}/);
      expect(payoutDraft('settlement.payout_paid', { payout_id: 'p1', amount_minor: 27000 })?.body).toContain('₹270');
    });
  });

  it('every category a draft can use is one the database accepts', () => {
    const used = [bookingDrafts('booking.settled', { provider_net_minor: 1 }, f), bookingDrafts('booking.reminder_due', {}, f), bookingDrafts('booking.approved', {}, f)]
      .flatMap((d) => [d.customer, d.provider])
      .filter(Boolean)
      .map((d) => d!.category);
    for (const c of used) expect(CATEGORIES).toContain(c);
  });
});
