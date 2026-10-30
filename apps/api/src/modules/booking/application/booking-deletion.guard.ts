import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DeletionGuard, DeletionGuardRegistry, UnitOfWork } from '../../../shared-kernel';

/** An account cannot be deleted while it has a booking that is still going on (money is held, someone is expecting them). */
@Injectable()
export class BookingDeletionGuard implements DeletionGuard {
  readonly name = 'booking';

  constructor(
    private readonly uow: UnitOfWork,
    registry: DeletionGuardRegistry,
  ) {
    registry.register(this);
  }

  async blockers(userId: string): Promise<string[]> {
    const { n } = (
      await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM booking.bookings
         WHERE customer_id = ${userId} AND status IN ('REQUESTED', 'CONFIRMED', 'CUSTOMER_ARRIVED', 'SERVICE_STARTED', 'SERVICE_COMPLETED', 'DISPUTED')`.execute(this.uow.db<unknown>())
    ).rows[0]!;
    const count = Number(n);
    return count === 0 ? [] : [`You have ${count} booking${count === 1 ? '' : 's'} in progress. Finish or cancel ${count === 1 ? 'it' : 'them'} first.`];
  }
}
