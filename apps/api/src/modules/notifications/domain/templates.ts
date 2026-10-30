/**
 * What each business event says to each person. Pure functions: easy to test and review, and the ONLY place wording lives.
 * Messages carry ids in `data` (so the app can open the right screen) and never contain personal data beyond what the recipient
 * already knows (their own booking, their own money).
 */
export type Audience = 'CUSTOMER' | 'PROVIDER';
export type Category = 'BOOKING' | 'REMINDER' | 'WALLET' | 'PAYOUT' | 'REVIEW' | 'SUPPORT';
export const CATEGORIES: readonly Category[] = ['BOOKING', 'REMINDER', 'WALLET', 'PAYOUT', 'REVIEW', 'SUPPORT'];

export interface Draft {
  audience: Audience;
  category: Category;
  kind: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** One notification per (user, dedupeKey): a retried event can never notify twice. */
  dedupeKey: string;
}

export interface BookingFacts {
  id: string;
  reference: string;
  serviceName: string;
  /** Wall-clock at the location, e.g. "2026-10-08T10:00". */
  localStart: string;
  locationName: string | null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-08T10:00" -> "Thu, 8 Oct · 10:00 AM". The location's own clock: no time-zone conversion. */
export function whenText(localStart: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localStart);
  if (!m) return localStart;
  const [, y, mo, d, h, mi] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  const hour = Number(h);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${WEEKDAYS[day]}, ${Number(d)} ${MONTHS[Number(mo) - 1]} · ${h12}:${mi} ${suffix}`;
}

/** ₹1,250 / ₹99.50 — integer arithmetic only. */
export function rupees(minor: bigint | number): string {
  const v = BigInt(minor);
  return `₹${(v / 100n).toLocaleString('en-IN')}${v % 100n === 0n ? '' : '.' + String(v % 100n).padStart(2, '0')}`;
}

const at = (f: BookingFacts) => `${f.serviceName} · ${whenText(f.localStart)}`;
const bdata = (f: BookingFacts) => ({ booking_id: f.id });

export interface BookingDrafts {
  customer?: Draft;
  provider?: Draft;
}

/** Drafts for a booking event, or an empty object when the event is not something to tell anyone about. */
export function bookingDrafts(eventType: string, payload: Record<string, unknown>, f: BookingFacts): BookingDrafts {
  const key = `${eventType}:${f.id}`;
  const customer = (kind: string, category: Category, title: string, body: string): Draft => ({ audience: 'CUSTOMER', category, kind, title, body, data: bdata(f), dedupeKey: key });
  const provider = (kind: string, category: Category, title: string, body: string): Draft => ({ audience: 'PROVIDER', category, kind, title, body, data: bdata(f), dedupeKey: key });

  switch (eventType) {
    case 'booking.requested':
      return { provider: provider('BOOKING_REQUESTED', 'BOOKING', 'New booking request', `${at(f)}. Accept or decline before it expires.`) };
    case 'booking.approved':
      return { customer: customer('BOOKING_CONFIRMED', 'BOOKING', 'Booking confirmed', `${at(f)}${f.locationName ? ` at ${f.locationName}` : ''}. Show your arrival code when you get there.`) };
    case 'booking.rejected':
      return { customer: customer('BOOKING_DECLINED', 'BOOKING', 'Booking declined', `${at(f)} was declined by the salon. The money held for it is back in your wallet.`) };
    case 'booking.expired':
      return {
        customer: customer('BOOKING_EXPIRED', 'BOOKING', 'No response from the salon', `${at(f)} was not answered in time, so it was cancelled. The money held for it is back in your wallet.`),
        provider: provider('BOOKING_EXPIRED', 'BOOKING', 'Booking request expired', `${at(f)} expired because it was not answered in time.`),
      };
    case 'booking.cancelled': {
      const by = payload['by'];
      if (by === 'PROVIDER') return { customer: customer('BOOKING_CANCELLED_BY_SALON', 'BOOKING', 'Booking cancelled by the salon', `${at(f)} was cancelled by the salon. You are refunded in full.`) };
      return { provider: provider('BOOKING_CANCELLED_BY_CUSTOMER', 'BOOKING', 'Booking cancelled', `${at(f)} was cancelled by the customer.`) };
    }
    case 'booking.no_show':
      return { customer: customer('BOOKING_NO_SHOW', 'BOOKING', 'Marked as no-show', `The salon marked ${at(f)} as a no-show. If this is wrong, contact support.`) };
    case 'booking.started':
      return { customer: customer('SERVICE_STARTED', 'BOOKING', 'Your service has started', f.serviceName) };
    case 'booking.completed':
      return { customer: customer('SERVICE_COMPLETED', 'BOOKING', 'Service completed', `${f.serviceName} is done. Please confirm so the salon is paid, or report a problem within the review window.`) };
    case 'booking.settled': {
      const net = payload['provider_net_minor'];
      return {
        provider: provider('PAYMENT_RECORDED', 'PAYOUT', 'Payment recorded', `${f.serviceName} · ${typeof net === 'number' ? `${rupees(net)} added to your earnings.` : 'added to your earnings.'}`),
        customer: { ...customer('REVIEW_REQUESTED', 'REVIEW', 'How was your visit?', `Rate ${f.serviceName} and help others choose.`), dedupeKey: `review-request:${f.id}` },
      };
    }
    case 'booking.reminder_due':
      return {
        customer: { ...customer('APPOINTMENT_REMINDER', 'REMINDER', 'Appointment reminder', `${at(f)}${f.locationName ? ` at ${f.locationName}` : ''}.`), dedupeKey: `reminder:${f.id}` },
        provider: { ...provider('APPOINTMENT_REMINDER', 'REMINDER', 'Upcoming appointment', at(f)), dedupeKey: `reminder:${f.id}` },
      };
    default:
      return {};
  }
}

/** A customer reviewed a booking: the business hears about it (and can reply). */
export function reviewDraft(eventType: string, payload: Record<string, unknown>): Draft | undefined {
  if (eventType !== 'reviews.review_created') return undefined;
  const rating = Number(payload['rating']);
  return {
    audience: 'PROVIDER',
    category: 'REVIEW',
    kind: 'REVIEW_RECEIVED',
    title: `New ${rating}-star review`,
    body: 'Open Reviews to read it and reply.',
    data: { review_id: String(payload['review_id']) },
    dedupeKey: `review:${String(payload['review_id'])}`,
  };
}

export interface SupportDrafts {
  customer?: Draft;
  provider?: Draft;
}

/**
 * Support and dispute events. Staff have no push (they work from the queue). A dispute is shared by both sides; a question
 * belongs to the side that asked it, so only that side is told about the answer.
 */
export function supportDrafts(eventType: string, payload: Record<string, unknown>): SupportDrafts {
  const caseId = String(payload['case_id']);
  const data = { case_id: caseId };
  const dispute = payload['kind'] === 'DISPUTE';
  const make = (audience: Audience, kind: string, title: string, body: string, dedupeKey: string): Draft => ({ audience, category: 'SUPPORT', kind, title, body, data, dedupeKey });
  switch (eventType) {
    case 'support.case_opened':
      return dispute ? { provider: make('PROVIDER', 'DISPUTE_OPENED', 'A customer reported a problem', 'Payment for this appointment is on hold while support reviews it. You can add your side in Support.', `support-opened:${caseId}`) } : {};
    case 'support.message_added': {
      const from = String(payload['author_role']);
      const messageId = String(payload['message_id']);
      const toCustomer = make('CUSTOMER', 'SUPPORT_REPLY', 'New message from support', 'Open Support to read it.', `support-msg:${messageId}`);
      const toProvider = make('PROVIDER', 'SUPPORT_REPLY', 'New message from support', 'Open Support to read it.', `support-msg:${messageId}`);
      if (dispute) {
        if (from === 'ADMIN') return { customer: toCustomer, provider: toProvider };
        if (from === 'CUSTOMER') return { provider: { ...toProvider, title: 'The customer added to their report' } };
        return { customer: { ...toCustomer, title: 'The business replied to your report' } };
      }
      if (from !== 'ADMIN') return {};
      return payload['opened_by_role'] === 'PROVIDER' ? { provider: toProvider } : { customer: toCustomer };
    }
    case 'support.dispute_resolved': {
      const refund = Number(payload['refund_minor'] ?? 0);
      return {
        customer: make('CUSTOMER', 'DISPUTE_RESOLVED', 'Your report has been decided', refund > 0 ? `${rupees(refund)} is being returned to you. Open Support for the details.` : 'Open Support for the decision.', `support-resolved:${caseId}`),
        provider: make('PROVIDER', 'DISPUTE_RESOLVED', 'A reported appointment has been decided', 'Open Support for the decision and your payout.', `support-resolved:${caseId}`),
      };
    }
    default:
      return {};
  }
}

/** Money events that concern one customer. */
export function walletDraft(eventType: string, payload: Record<string, unknown>): Draft | undefined {
  const amount = typeof payload['amount_minor'] === 'number' ? rupees(payload['amount_minor']) : null;
  switch (eventType) {
    case 'ledger.wallet_credited':
      return { audience: 'CUSTOMER', category: 'WALLET', kind: 'WALLET_CREDITED', title: amount ? `${amount} added to your wallet` : 'Money added to your wallet', body: 'Your wallet balance is updated.', data: {}, dedupeKey: `wallet:${String(payload['txn_id'])}` };
    case 'payments.refund_succeeded':
      return { audience: 'CUSTOMER', category: 'WALLET', kind: 'REFUND_PROCESSED', title: 'Refund processed', body: amount ? `${amount} is on its way back to your original payment method.` : 'Your refund is on its way back to your original payment method.', data: { refund_id: String(payload['refund_id']) }, dedupeKey: `refund:${String(payload['refund_id'])}` };
    case 'payments.refund_failed':
      return { audience: 'CUSTOMER', category: 'WALLET', kind: 'REFUND_FAILED', title: 'Refund could not be completed', body: 'Please check your wallet, or contact support if you need help.', data: { refund_id: String(payload['refund_id']) }, dedupeKey: `refund-failed:${String(payload['refund_id'])}` };
    default:
      return undefined;
  }
}

/** Money events that concern a business. */
export function payoutDraft(eventType: string, payload: Record<string, unknown>): Draft | undefined {
  const amount = typeof payload['amount_minor'] === 'number' ? rupees(payload['amount_minor']) : null;
  const base = { audience: 'PROVIDER' as const, category: 'PAYOUT' as const };
  switch (eventType) {
    case 'settlement.payout_paid':
      return { ...base, kind: 'PAYOUT_PAID', title: 'Payout sent', body: amount ? `${amount} was sent to your bank account.` : 'A payout was sent to your bank account.', data: { payout_id: String(payload['payout_id']) }, dedupeKey: `payout-paid:${String(payload['payout_id'])}` };
    case 'settlement.payout_failed':
      return { ...base, kind: 'PAYOUT_FAILED', title: 'Payout could not be completed', body: 'The money stays in your earnings. Open Earnings for details.', data: { payout_id: String(payload['payout_id']) }, dedupeKey: `payout-failed:${String(payload['payout_id'])}` };
    case 'settlement.payout_account_verified':
      return { ...base, kind: 'BANK_ACCOUNT_VERIFIED', title: 'Bank account verified', body: 'Payouts will be sent to this account.', data: {}, dedupeKey: `account-verified:${String(payload['payout_account_id'])}` };
    case 'settlement.payout_account_verification_failed':
      return { ...base, kind: 'BANK_ACCOUNT_FAILED', title: 'Bank account needs attention', body: 'We could not verify your bank account. Please check the details and try again.', data: {}, dedupeKey: `account-failed:${String(payload['payout_account_id'])}` };
    default:
      return undefined;
  }
}
