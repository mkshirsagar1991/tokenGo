import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  Clock,
  ConflictError,
  DomainError,
  Money,
  NotFoundError,
  OutboxService,
  PG_UNIQUE_VIOLATION,
  PII_HASH_KEY,
  TooManyRequestsError,
  UnitOfWork,
  ValidationFailedError,
  pgConstraint,
  pgErrorCode,
  uuidv7,
} from '../../../shared-kernel';
import { AuditService } from '../../audit';
import { AvailabilityService, PolicyService } from '../../availability';
import {
  CancellationSnapshot,
  CatalogReadService,
  CommissionSnapshot,
  MAX_SERVICES_PER_BOOKING,
  PolicyResolverService,
  combineCommission,
  refundBpsFor,
  splitCommission,
  splitRefund,
} from '../../catalog';
import { AuthorizationService } from '../../identity-access';
import { SettingsService } from '../../platform';
import { ProviderAccessService, ProviderDirectoryService } from '../../provider-management';
import { Allocation, LedgerService } from '../../wallet-ledger';
import { derivePin, issueQrToken, pinMatches, verifyQrToken } from '../domain/arrival-token';
import { ActorKind, BookingCommand, BookingStatus, nextStatus } from '../domain/booking-state';
import type { FundsStatus } from '../infrastructure/db-types';
import { BookingPatch, BookingRepository, BookingRow } from '../infrastructure/booking.repository';
import { BookingView, BookingViewBuilder } from './booking-view';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60_000;

type Actor = { kind: ActorKind; id: string | null };
const SYSTEM: Actor = { kind: 'SYSTEM', id: null };
const ledgerActor = (a: Actor) => (a.kind === 'SYSTEM' ? { type: 'SYSTEM' as const } : { type: 'USER' as const, id: a.id ?? undefined });

function newReference(): string {
  const bytes = randomBytes(8);
  return `TG-${Array.from(bytes, (b) => CROCKFORD[b % 32]).join('')}`;
}

/**
 * Booking commands (requirements §15–§18). Every command:
 *   1. authorises server-side (ownership for customers; scoped permission for provider users),
 *   2. locks the booking row, validates the transition against the explicit state machine,
 *   3. performs the financial and scheduling side effects in the SAME transaction,
 *   4. appends an immutable booking event, an audit row and an outbox event.
 * Nothing here accepts a status, price, commission or amount from the client.
 */
@Injectable()
export class BookingService {
  constructor(
    @Inject(PII_HASH_KEY) private readonly hashKey: Buffer,
    private readonly repo: BookingRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly availability: AvailabilityService,
    private readonly catalog: CatalogReadService,
    private readonly resolver: PolicyResolverService,
    private readonly policies: PolicyService,
    private readonly directory: ProviderDirectoryService,
    private readonly access: ProviderAccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly views: BookingViewBuilder,
    private readonly settings: SettingsService,
  ) {}

  // =====================================================================================================
  // Customer: request a booking (atomic: validate -> hold funds -> reserve slot -> create booking)
  // =====================================================================================================
  /**
   * One visit can hold several services (a haircut + a facial; a car wash + a tyre change): give ONE as `serviceId` or several as
   * `serviceIds`. They are done one after the other by the same person, priced and held together, reserved as ONE block of time,
   * and each is saved as its own immutable line.
   */
  async create(
    customerId: string,
    input: { locationId: string; serviceId?: string; serviceIds?: string[]; startAt: string; resourceId?: string; note?: string; idempotencyKey: string },
  ): Promise<BookingView> {
    await this.authz.require(customerId, 'appointment:create');
    const serviceIds = [...new Set(input.serviceIds ?? (input.serviceId ? [input.serviceId] : []))];
    if (serviceIds.length === 0 || serviceIds.length > MAX_SERVICES_PER_BOOKING) {
      throw new ValidationFailedError('Invalid services', { fields: { service_ids: [`choose between 1 and ${MAX_SERVICES_PER_BOOKING} services`] } });
    }
    const startAt = new Date(input.startAt);
    if (Number.isNaN(startAt.getTime()) || startAt.getTime() % 60_000 !== 0) {
      throw new ValidationFailedError('Invalid start time', { fields: { start_at: ['must be an ISO-8601 instant on a whole minute'] } });
    }

    const bookingId = await this.uow.run(async () => {
      const now = this.clock.now();
      const id = uuidv7();

      // (1) Re-validate availability authoritatively with the same engine the public list uses.
      const slot = await this.availability.findBookableSlot({ locationId: input.locationId, serviceIds, startAt, resourceId: input.resourceId });
      if (!slot) throw new ConflictError('SLOT_UNAVAILABLE', 'That time is no longer available');

      // (2) Everything priced and configured comes from trusted records, never from the request.
      const bundle = await this.catalog.getBookableBundle(serviceIds);
      const location = await this.directory.getLocation(input.locationId);
      if (!bundle || !location || bundle.providerId !== location.providerId) throw new NotFoundError('Service');
      const service = bundle.services[0]!; // the first one chosen: names the provider and the category the cancellation policy follows
      // Commission is resolved per service (a business may have a special rate on one) and snapshotted as ONE rule for the booking.
      const commission = combineCommission(
        await Promise.all(
          bundle.services.map(async (sv) => ({
            rule: await this.resolver.resolveCommission({ at: now, providerServiceId: sv.id, providerId: sv.providerId, serviceTypeId: sv.serviceTypeId, categoryId: sv.categoryId }),
            amount: sv.price,
          })),
        ),
      );
      const cancellation = await this.resolver.resolveCancellationPolicy({ at: now, providerId: service.providerId, categoryId: service.categoryId });
      const policy = slot.policy;

      // (3) Funds first: fails fast with INSUFFICIENT_FUNDS before anything else is written. Locks the
      //     customer's wallet, so two simultaneous bookings can never spend the same money.
      let holdId: string | null = null;
      if (bundle.price.isPositive()) {
        const hold = await this.ledger.createHold({ bookingId: id, customerId, amount: bundle.price, idempotencyKey: `hold:${id}`, actor: { type: 'USER', id: customerId } });
        holdId = hold.id;
      }

      // (4) Reserve the slot. The exclusion constraint decides; losing candidates are skipped.
      const reservation = await this.availability.reserveFirstFree({
        candidates: slot.candidates,
        startAt,
        durationMin: bundle.durationMin,
        bufferMin: bundle.bufferMin,
        bookingId: id,
        createdBy: customerId,
        dayStart: slot.dayStart,
        dayEnd: slot.dayEnd,
      });
      if (!reservation) throw new ConflictError('SLOT_UNAVAILABLE', 'That time was just taken — please choose another slot'); // rolls the hold back too

      // (5) The aggregate, its immutable snapshots, and its first events.
      let ref = newReference();
      while (await this.repo.bookingRefExists(ref)) ref = newReference();
      try {
        await this.repo.insertBooking({
          id,
          bookingRef: ref,
          customerId,
          providerId: service.providerId,
          locationId: location.locationId,
          resourceId: reservation.resourceId,
          reservationId: reservation.reservationId,
          startAt,
          endAt: new Date(startAt.getTime() + bundle.durationMin * 60_000),
          occupiedUntil: reservation.occupiedUntil,
          responseDeadlineAt: new Date(now.getTime() + policy.responseDeadlineMin * 60_000),
          requestedAt: now,
          customerNote: input.note ?? null,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (err) {
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'bookings_customer_idem_key') {
          throw new ConflictError('DUPLICATE_BOOKING_REQUEST', 'This booking request was already submitted');
        }
        throw err;
      }
      for (const [position, sv] of bundle.services.entries()) {
        await this.repo.insertItem({ bookingId: id, providerServiceId: sv.id, serviceVersion: sv.version, name: sv.name, priceMinor: sv.price.minor, currency: sv.price.currency, durationMin: sv.durationMin, bufferMin: sv.bufferMin, position });
      }
      await this.repo.insertFinancials({
        bookingId: id,
        currency: bundle.price.currency,
        grossMinor: bundle.price.minor,
        commissionRuleId: commission.ruleId,
        commissionRuleVersion: commission.ruleVersion,
        commissionKind: commission.kind,
        commissionBps: commission.percentBps,
        commissionFixedMinor: commission.fixedMinor,
        cancellationPolicy: cancellation,
        holdId,
      });
      if (!holdId) await this.repo.transition(id, 'REQUESTED', 'REQUESTED', { fundsStatus: 'NONE' }); // free service: nothing held

      const actor: Actor = { kind: 'CUSTOMER', id: customerId };
      await this.event(id, 'BookingRequested', null, 'REQUESTED', actor, null, { hold_id: holdId, amount_minor: Number(bundle.price.minor), service_count: bundle.services.length });
      const deadline = new Date(now.getTime() + policy.responseDeadlineMin * 60_000);
      await this.outbox.publish({ type: 'booking.requested', aggregateType: 'booking', aggregateId: id, payload: { booking_id: id, provider_id: service.providerId, location_id: location.locationId, customer_id: customerId, resource_id: reservation.resourceId } });
      // The response deadline is an outbox event that becomes due at the deadline: no polling, and it
      // does not depend on any app being open (requirements §17).
      await this.outbox.publish({ type: 'booking.response_deadline', aggregateType: 'booking', aggregateId: id, payload: { booking_id: id }, availableAt: deadline });
      await this.audit.record({ actorType: 'USER', actorId: customerId, action: 'booking.requested', entityType: 'booking', entityId: id, after: { status: 'REQUESTED', provider_id: service.providerId, amount_minor: Number(bundle.price.minor), service_count: bundle.services.length } });
      return id;
    });
    return this.view(bookingId);
  }

  // =====================================================================================================
  // Provider decisions
  // =====================================================================================================
  async approve(userId: string, bookingId: string): Promise<BookingView> {
    await this.authorizeProvider(userId, bookingId, 'appointment:respond');
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      const now = this.clock.now();
      nextStatus(b.status, 'APPROVE', 'PROVIDER'); // validate first so a stale approve is a clean 409
      if (b.response_deadline_at && now > b.response_deadline_at) {
        throw new ConflictError('RESPONSE_DEADLINE_PASSED', 'The response deadline for this request has passed');
      }
      await this.move(b, 'APPROVE', { kind: 'PROVIDER', id: userId }, { confirmedAt: now }, 'BookingApproved', null);
      await this.publish('booking.approved', b);
      // A reminder before the appointment (requirements §26). Time-driven through the outbox like the response deadline; the
      // consumer re-checks that the booking is still confirmed, so a later cancellation silences it.
      const leadMinutes = await this.settings.get<number>('notifications.reminder_lead_minutes');
      const remindAt = new Date(b.start_at.getTime() - leadMinutes * 60_000);
      if (remindAt > now) await this.outbox.publish({ type: 'booking.reminder_due', aggregateType: 'booking', aggregateId: b.id, payload: { booking_id: b.id, customer_id: b.customer_id, provider_id: b.provider_id, location_id: b.location_id }, availableAt: remindAt });
    });
    return this.view(bookingId);
  }

  async reject(userId: string, bookingId: string, input: { reasonCode: string; note?: string }): Promise<BookingView> {
    await this.authorizeProvider(userId, bookingId, 'appointment:respond');
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'REJECT', 'PROVIDER');
      await this.closeAndRelease(b, 'REJECT', { kind: 'PROVIDER', id: userId }, 10000, `REJECTED:${input.reasonCode}`, 'BookingRejected', input.reasonCode, { note: input.note });
      await this.publish('booking.rejected', b, { reason_code: input.reasonCode });
    });
    return this.view(bookingId);
  }

  /** Called by the worker when the response deadline event becomes due. Safe if the booking has moved on. */
  async expireIfDue(bookingId: string): Promise<'EXPIRED' | 'SKIPPED' | 'NOT_DUE'> {
    return this.uow.run(async () => {
      const b = await this.repo.findById(bookingId, { forUpdate: true });
      if (!b || b.status !== 'REQUESTED') return 'SKIPPED'; // approved/rejected/cancelled in the meantime
      if (b.response_deadline_at && b.response_deadline_at > this.clock.now()) return 'NOT_DUE'; // e.g. tiny clock skew between workers: retry rather than drop
      await this.closeAndRelease(b, 'EXPIRE', SYSTEM, 10000, 'PROVIDER_TIMEOUT', 'BookingExpired', 'PROVIDER_TIMEOUT');
      await this.publish('booking.expired', b);
      return 'EXPIRED';
    });
  }

  // =====================================================================================================
  // Cancellations and no-show
  // =====================================================================================================
  async customerCancel(userId: string, bookingId: string, input: { reasonCode?: string }): Promise<BookingView> {
    await this.authorizeCustomer(userId, bookingId);
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'CUSTOMER_CANCEL', 'CUSTOMER');
      const fin = await this.repo.getFinancials(b.id);
      // A request nobody has accepted yet can always be withdrawn for a full refund; a CONFIRMED booking
      // follows the cancellation policy that was snapshotted when it was requested.
      const hoursBefore = (b.start_at.getTime() - this.clock.now().getTime()) / 3_600_000;
      const bps = b.status === 'REQUESTED' ? 10000 : refundBpsFor(fin!.cancellation_policy as CancellationSnapshot, 'CUSTOMER', hoursBefore);
      await this.closeAndRelease(b, 'CUSTOMER_CANCEL', { kind: 'CUSTOMER', id: userId }, bps, `CUSTOMER_CANCELLED:${input.reasonCode ?? 'UNSPECIFIED'}`, 'BookingCancelledByCustomer', input.reasonCode ?? null, { refund_bps: bps });
      await this.publish('booking.cancelled', b, { by: 'CUSTOMER', refund_bps: bps });
    });
    return this.view(bookingId);
  }

  async providerCancel(userId: string, bookingId: string, input: { reasonCode: string; note?: string }): Promise<BookingView> {
    await this.authorizeProvider(userId, bookingId, 'appointment:cancel');
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'PROVIDER_CANCEL', 'PROVIDER');
      const fin = await this.repo.getFinancials(b.id);
      const bps = refundBpsFor(fin!.cancellation_policy as CancellationSnapshot, 'PROVIDER', 0);
      await this.closeAndRelease(b, 'PROVIDER_CANCEL', { kind: 'PROVIDER', id: userId }, bps, `PROVIDER_CANCELLED:${input.reasonCode}`, 'BookingCancelledByProvider', input.reasonCode, { note: input.note, refund_bps: bps });
      await this.publish('booking.cancelled', b, { by: 'PROVIDER', reason_code: input.reasonCode, refund_bps: bps });
    });
    return this.view(bookingId);
  }

  async markNoShow(userId: string, bookingId: string): Promise<BookingView> {
    await this.authorizeProvider(userId, bookingId, 'appointment:run');
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'MARK_NO_SHOW', 'PROVIDER');
      const policy = await this.policies.resolve(b.provider_id);
      const earliest = b.start_at.getTime() + policy.noShowGraceMin * 60_000;
      if (this.clock.now().getTime() < earliest) {
        throw new ConflictError('TOO_EARLY_FOR_NO_SHOW', 'A no-show can only be recorded after the grace period', { earliest: new Date(earliest).toISOString() });
      }
      const fin = await this.repo.getFinancials(b.id);
      const bps = refundBpsFor(fin!.cancellation_policy as CancellationSnapshot, 'NO_SHOW', 0);
      await this.closeAndRelease(b, 'MARK_NO_SHOW', { kind: 'PROVIDER', id: userId }, bps, 'CUSTOMER_NO_SHOW', 'BookingNoShow', 'CUSTOMER_NO_SHOW', { refund_bps: bps });
      await this.publish('booking.no_show', b, { refund_bps: bps });
    });
    return this.view(bookingId);
  }

  // =====================================================================================================
  // At the venue: arrival (QR / PIN / manager override), start, complete
  // =====================================================================================================
  /** The customer's proof of booking: a stable PIN and a short-lived signed QR token (no personal data). */
  async getArrivalCode(customerId: string, bookingId: string) {
    const b = await this.authorizeCustomer(customerId, bookingId);
    if (b.status !== 'CONFIRMED') throw new ConflictError('NOT_CONFIRMED', 'Arrival codes are available once the provider has confirmed the booking');
    const policy = await this.policies.resolve(b.provider_id);
    this.assertCheckInWindow(b, policy.checkInWindowMin);
    const qr = issueQrToken(this.hashKey, b.id, this.clock.now().getTime());
    return { booking_id: b.id, reference: b.booking_ref, pin: derivePin(this.hashKey, b.id), qr: { token: qr.token, expires_at: qr.expiresAt.toISOString() } };
  }

  async verifyArrival(userId: string, bookingId: string, proof: { pin?: string; qrToken?: string; manualReason?: string }): Promise<BookingView> {
    const preliminary = await this.authorizeProvider(userId, bookingId, proof.manualReason ? 'appointment:respond' : 'appointment:run');

    // Failed attempts must be COMMITTED even though the request fails, so the transaction RETURNS a verdict.
    const verdict = await this.uow.run(async (): Promise<'OK' | 'BAD_PROOF' | 'LOCKED'> => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'VERIFY_ARRIVAL', 'PROVIDER');
      const policy = await this.policies.resolve(b.provider_id);
      this.assertCheckInWindow(b, policy.checkInWindowMin);
      const now = this.clock.now();

      if (!proof.manualReason) {
        const v = await this.repo.getVerification(b.id);
        if (v?.locked_until && v.locked_until > now) return 'LOCKED';
        const ok =
          (proof.pin !== undefined && pinMatches(this.hashKey, b.id, proof.pin)) ||
          (proof.qrToken !== undefined && verifyQrToken(this.hashKey, proof.qrToken, now.getTime()) === b.id);
        if (!ok) {
          await this.repo.recordVerificationFailure(b.id, MAX_PIN_FAILURES, new Date(now.getTime() + PIN_LOCK_MS));
          await this.event(b.id, 'ArrivalVerificationFailed', b.status, b.status, { kind: 'PROVIDER', id: userId }, 'BAD_PROOF', {});
          return 'BAD_PROOF';
        }
        await this.repo.resetVerification(b.id);
      }
      await this.move(b, 'VERIFY_ARRIVAL', { kind: 'PROVIDER', id: userId }, { arrivedAt: now }, 'CustomerArrived', proof.manualReason ? 'MANUAL_OVERRIDE' : null, proof.manualReason ? { manual_reason: proof.manualReason } : {});
      await this.publish('booking.arrived', b, { manual: Boolean(proof.manualReason) });
      return 'OK';
    });

    if (verdict === 'LOCKED') throw new TooManyRequestsError('Too many wrong codes — arrival verification is locked for 15 minutes', PIN_LOCK_MS / 1000);
    if (verdict === 'BAD_PROOF') throw new DomainError('ARRIVAL_PROOF_INVALID', 'The PIN or QR code is not valid for this booking', 401);
    void preliminary;
    return this.view(bookingId);
  }

  async startService(userId: string, bookingId: string): Promise<BookingView> {
    await this.authorizeProvider(userId, bookingId, 'appointment:run');
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      await this.move(b, 'START', { kind: 'PROVIDER', id: userId }, { startedAt: this.clock.now() }, 'ServiceStarted', null);
      await this.publish('booking.started', b);
    });
    return this.view(bookingId);
  }

  /**
   * Completion is an explicit act by staff (never inferred from the clock). Settlement is NOT immediate: it
   * waits for the customer's confirmation or the dispute window, whichever comes first (proposal G5).
   */
  async completeService(userId: string, bookingId: string): Promise<BookingView> {
    await this.authorizeProvider(userId, bookingId, 'appointment:run');
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'COMPLETE', 'PROVIDER');
      const now = this.clock.now();
      const policy = await this.policies.resolve(b.provider_id);
      const settleAfter = new Date(now.getTime() + policy.settlementHoldHours * 3_600_000);
      await this.move(b, 'COMPLETE', { kind: 'PROVIDER', id: userId }, { completedAt: now, settlementStatus: 'PENDING', settleAfter }, 'ServiceCompleted', null, { settle_after: settleAfter.toISOString() });
      await this.publish('booking.completed', b);
      await this.outbox.publish({ type: 'booking.settlement_due', aggregateType: 'booking', aggregateId: b.id, payload: { booking_id: b.id }, availableAt: settleAfter });
    });
    return this.view(bookingId);
  }

  // =====================================================================================================
  // Settlement
  // =====================================================================================================
  /** The customer confirms the service was delivered: settle now instead of waiting for the window. */
  async confirmCompletion(userId: string, bookingId: string): Promise<BookingView> {
    await this.authorizeCustomer(userId, bookingId);
    await this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'SETTLE', 'CUSTOMER');
      await this.settle(b, { kind: 'CUSTOMER', id: userId }, 'CUSTOMER_CONFIRMED');
    });
    return this.view(bookingId);
  }

  // =====================================================================================================
  // Disputes (requirements §20). The case itself (messages, evidence, decision) lives in the support module; the MONEY and the
  // booking state are decided here, in the same transaction as everything else that touches the hold.
  // =====================================================================================================
  /**
   * The customer disputes a completed service before the dispute window ends. Settlement is frozen: the held money stays held
   * until an administrator decides. Only the booking's own customer, only while the service is completed and unsettled.
   */
  async raiseDispute(customerId: string, bookingId: string): Promise<{ grossMinor: bigint; currency: string; providerId: string }> {
    await this.authorizeCustomer(customerId, bookingId);
    return this.uow.run(async () => {
      const b = await this.lock(bookingId);
      nextStatus(b.status, 'DISPUTE', 'CUSTOMER'); // a clean 409 unless the service is completed
      if (b.settlement_status !== 'PENDING') throw new ConflictError('SETTLEMENT_NOT_PENDING', 'This booking is not waiting for settlement');
      if (b.settle_after && b.settle_after <= this.clock.now()) throw new ConflictError('DISPUTE_WINDOW_PASSED', 'The time to raise a dispute for this booking has passed');
      const fin = (await this.repo.getFinancials(b.id))!;
      await this.move(b, 'DISPUTE', { kind: 'CUSTOMER', id: customerId }, { settlementStatus: 'FROZEN' }, 'DisputeRaised', null);
      await this.publish('booking.disputed', b);
      return { grossMinor: BigInt(fin.gross_minor), currency: fin.currency, providerId: b.provider_id };
    });
  }

  /**
   * An administrator's decision on a disputed booking: how much goes back to the customer. The rest is the business's, with the
   * platform commission taken from it by the rule snapshotted at request time. The ledger enforces that the pieces add up to the
   * held amount exactly and can only be applied once (idempotency key), so no decision can move more money than was held.
   */
  async resolveDispute(adminId: string, bookingId: string, input: { refundMinor: bigint }): Promise<{ refundMinor: bigint; providerNetMinor: bigint; commissionMinor: bigint; currency: string }> {
    return this.uow.run(async () => {
      const b = await this.lock(bookingId);
      const actor: Actor = { kind: 'ADMIN', id: adminId };
      nextStatus(b.status, 'RESOLVE_DISPUTE', 'ADMIN');
      if (b.settlement_status !== 'FROZEN') throw new ConflictError('SETTLEMENT_NOT_FROZEN', 'This booking is not under dispute');
      const fin = (await this.repo.getFinancials(b.id))!;
      const gross = Money.of(BigInt(fin.gross_minor), fin.currency);
      if (input.refundMinor < 0n || input.refundMinor > gross.minor) throw new ValidationFailedError(`The refund must be between 0 and ${gross.minor} (the amount held)`);
      const refund = Money.of(input.refundMinor, fin.currency);
      const retained = gross.subtract(refund);
      const reason = 'DISPUTE_RESOLVED';
      let funds: FundsStatus = 'NONE';
      let net = Money.zero(fin.currency);
      let commission = Money.zero(fin.currency);
      if (fin.hold_id) {
        if (retained.isZero()) {
          await this.ledger.releaseHold({ holdId: fin.hold_id, reason, idempotencyKey: `dispute:${b.id}`, actor: ledgerActor(actor) });
          funds = 'RELEASED';
        } else {
          ({ commission, net } = splitCommission(this.commissionOf(fin), retained));
          const allocations: Allocation[] = [
            { kind: 'CUSTOMER_REFUND', amount: refund },
            { kind: 'PROVIDER_PAYABLE', providerId: b.provider_id, amount: net },
            { kind: 'PLATFORM_COMMISSION', amount: commission },
          ];
          await this.ledger.settleHold({ holdId: fin.hold_id, allocations, reason, idempotencyKey: `dispute:${b.id}`, actor: ledgerActor(actor) });
          funds = refund.isZero() ? 'SETTLED' : 'PARTIAL';
        }
      }
      const outcome = { refund_minor: Number(refund.minor), provider_net_minor: Number(net.minor), commission_minor: Number(commission.minor), funds_status: funds };
      await this.move(b, 'RESOLVE_DISPUTE', actor, { fundsStatus: funds, settlementStatus: 'DONE', closedAt: this.clock.now() }, 'DisputeResolved', reason, outcome);
      await this.publish('booking.dispute_resolved', b, { ...outcome, currency: fin.currency });
      return { refundMinor: refund.minor, providerNetMinor: net.minor, commissionMinor: commission.minor, currency: fin.currency };
    });
  }

  /** Worker: the dispute window elapsed with no dispute. No-op unless the booking is still waiting for it. */
  async settleIfDue(bookingId: string): Promise<'SETTLED' | 'SKIPPED' | 'NOT_DUE'> {
    return this.uow.run(async () => {
      const b = await this.repo.findById(bookingId, { forUpdate: true });
      if (!b || b.status !== 'SERVICE_COMPLETED' || b.settlement_status !== 'PENDING') return 'SKIPPED'; // disputed / already settled
      if (b.settle_after && b.settle_after > this.clock.now()) return 'NOT_DUE';
      await this.settle(b, SYSTEM, 'DISPUTE_WINDOW_ELAPSED');
      return 'SETTLED';
    });
  }

  /** Full settlement: held money -> provider payable + platform commission (rule SNAPSHOT from request time). */
  private async settle(b: BookingRow, actor: Actor, reason: string): Promise<void> {
    if (b.settlement_status !== 'PENDING') throw new ConflictError('SETTLEMENT_NOT_PENDING', 'This booking is not waiting for settlement');
    const fin = (await this.repo.getFinancials(b.id))!;
    const gross = Money.of(BigInt(fin.gross_minor), fin.currency);
    const rule = this.commissionOf(fin);
    const { commission, net } = splitCommission(rule, gross);
    if (fin.hold_id) {
      await this.ledger.settleHold({
        holdId: fin.hold_id,
        allocations: [
          { kind: 'PROVIDER_PAYABLE', providerId: b.provider_id, amount: net },
          { kind: 'PLATFORM_COMMISSION', amount: commission },
        ],
        reason,
        idempotencyKey: `settle:${b.id}`,
        actor: ledgerActor(actor),
      });
    }
    await this.move(b, 'SETTLE', actor, { closedAt: this.clock.now(), settlementStatus: 'DONE', fundsStatus: fin.hold_id ? 'SETTLED' : 'NONE' }, 'ServiceSettled', reason, { provider_net_minor: Number(net.minor), commission_minor: Number(commission.minor) });
    await this.publish('booking.settled', b, { provider_net_minor: Number(net.minor), commission_minor: Number(commission.minor), currency: fin.currency });
  }

  /**
   * Safety net (belt and braces next to the outbox events): finds work that is overdue by more than a grace
   * period — a request past its response deadline, a completed service past its dispute window — and
   * processes it with the same idempotent commands. Called by the worker's housekeeping.
   */
  async sweepOverdue(opts: { graceMinutes?: number; limit?: number } = {}): Promise<{ expired: number; settled: number }> {
    const grace = (opts.graceMinutes ?? 5) * 60_000;
    const cutoff = new Date(this.clock.now().getTime() - grace);
    const limit = opts.limit ?? 100;
    const ids = await this.repo.findOverdue(cutoff, limit);
    let expired = 0;
    let settled = 0;
    for (const id of ids.expiry) if ((await this.expireIfDue(id)) === 'EXPIRED') expired++;
    for (const id of ids.settlement) if ((await this.settleIfDue(id)) === 'SETTLED') settled++;
    return { expired, settled };
  }

  // =====================================================================================================
  // internals
  // =====================================================================================================
  /**
   * Terminal-state helper: validates + applies the transition, returns the hold (fully when refundBps is
   * 10000, otherwise as a refund/fee split), releases the time slot, and records the outcome.
   */
  private async closeAndRelease(b: BookingRow, command: BookingCommand, actor: Actor, refundBps: number, reason: string, eventType: string, reasonCode: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
    const fin = (await this.repo.getFinancials(b.id))!;
    let funds: FundsStatus = 'NONE';
    if (fin.hold_id) {
      const gross = Money.of(BigInt(fin.gross_minor), fin.currency);
      const { refund, retained } = splitRefund(gross, refundBps);
      if (retained.isZero()) {
        await this.ledger.releaseHold({ holdId: fin.hold_id, reason, idempotencyKey: `close:${b.id}`, actor: ledgerActor(actor) });
        funds = 'RELEASED';
      } else {
        // The customer keeps part of the money back; the retained part is a fee earned by the provider,
        // split with the platform using the commission rule snapshotted at request time.
        const { commission, net } = splitCommission(this.commissionOf(fin), retained);
        const allocations: Allocation[] = [
          { kind: 'CUSTOMER_REFUND', amount: refund },
          { kind: 'PROVIDER_PAYABLE', providerId: b.provider_id, amount: net },
          { kind: 'PLATFORM_COMMISSION', amount: commission },
        ];
        await this.ledger.settleHold({ holdId: fin.hold_id, allocations, reason, idempotencyKey: `close:${b.id}`, actor: ledgerActor(actor) });
        funds = refund.isZero() ? 'SETTLED' : 'PARTIAL';
      }
    }
    await this.availability.releaseReservation(b.reservation_id);
    await this.move(b, command, actor, { fundsStatus: funds, closedAt: this.clock.now(), statusReason: reason }, eventType, reasonCode, { ...metadata, funds_status: funds });
  }

  private commissionOf(fin: { commission_kind: 'PERCENT' | 'FIXED'; commission_bps: number | null; commission_fixed_minor: string | null; commission_rule_id: string | null; commission_rule_version: number | null }): CommissionSnapshot {
    return {
      ruleId: fin.commission_rule_id,
      ruleVersion: fin.commission_rule_version,
      kind: fin.commission_kind,
      percentBps: fin.commission_bps,
      fixedMinor: fin.commission_fixed_minor === null ? null : BigInt(fin.commission_fixed_minor),
    };
  }

  /** Applies a validated transition (compare-and-set), writes the booking event and the audit row. */
  private async move(b: BookingRow, command: BookingCommand, actor: Actor, patch: BookingPatch, eventType: string, reasonCode: string | null, metadata: Record<string, unknown> = {}): Promise<BookingRow> {
    const next: BookingStatus = nextStatus(b.status, command, actor.kind);
    const updated = await this.repo.transition(b.id, b.status, next, patch);
    if (!updated) throw new ConflictError('CONCURRENT_MODIFICATION', 'The booking was changed by someone else; reload and retry');
    await this.event(b.id, eventType, b.status, next, actor, reasonCode, metadata);
    await this.audit.record({
      actorType: actor.kind === 'SYSTEM' ? 'SYSTEM' : 'USER',
      actorId: actor.id,
      action: `booking.${command.toLowerCase()}`,
      entityType: 'booking',
      entityId: b.id,
      before: { status: b.status },
      after: { status: next, funds_status: patch.fundsStatus },
      metadata: { reason_code: reasonCode },
    });
    // keep the in-memory copy in step for callers that continue using it
    Object.assign(b, updated);
    return updated;
  }

  private event(bookingId: string, eventType: string, from: string | null, to: string | null, actor: Actor, reasonCode: string | null, metadata: Record<string, unknown>) {
    return this.repo.insertEvent({ bookingId, eventType, fromStatus: from, toStatus: to, actorType: actor.kind, actorId: actor.id, reasonCode, metadata, occurredAt: this.clock.now() });
  }

  private publish(type: string, b: BookingRow, extra: Record<string, unknown> = {}) {
    return this.outbox.publish({
      type,
      aggregateType: 'booking',
      aggregateId: b.id,
      payload: { booking_id: b.id, customer_id: b.customer_id, provider_id: b.provider_id, location_id: b.location_id, ...extra },
    });
  }

  private async lock(bookingId: string): Promise<BookingRow> {
    const b = await this.repo.findById(bookingId, { forUpdate: true });
    if (!b) throw new NotFoundError('Booking');
    return b;
  }

  /** Customer ownership check. A booking that is not yours is indistinguishable from one that does not exist. */
  private async authorizeCustomer(userId: string, bookingId: string): Promise<BookingRow> {
    const b = await this.repo.findById(bookingId);
    if (!b || b.customer_id !== userId) throw new NotFoundError('Booking');
    return b;
  }

  /** Provider-side access: scoped to the booking's provider AND location (IDOR-safe: 404 for outsiders). */
  private async authorizeProvider(userId: string, bookingId: string, permission: string): Promise<BookingRow> {
    const b = await this.repo.findById(bookingId);
    if (!b) throw new NotFoundError('Booking');
    await this.access.require(userId, permission, b.provider_id, b.location_id);
    return b;
  }

  private assertCheckInWindow(b: BookingRow, windowMin: number): void {
    const now = this.clock.now().getTime();
    const opens = b.start_at.getTime() - windowMin * 60_000;
    if (now < opens || now > b.occupied_until.getTime()) {
      throw new ConflictError('OUTSIDE_CHECK_IN_WINDOW', 'Arrival can only be recorded shortly before and during the appointment', { opens_at: new Date(opens).toISOString() });
    }
  }

  private async view(bookingId: string): Promise<BookingView> {
    const b = await this.repo.findById(bookingId);
    if (!b) throw new NotFoundError('Booking');
    return this.views.build(b);
  }
}
