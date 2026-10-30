import { Injectable } from '@nestjs/common';

/**
 * A module's veto over an account deletion. The identity module owns the deletion workflow but must not know about bookings,
 * wallets or providers, so each owning module registers a guard that says, in words a person can act on, why the account
 * cannot be deleted YET (an empty list = no objection). Run both when deletion is requested and again when it is carried out.
 */
export interface DeletionGuard {
  readonly name: string;
  blockers(userId: string): Promise<string[]>;
}

@Injectable()
export class DeletionGuardRegistry {
  private readonly guards = new Map<string, DeletionGuard>();

  register(guard: DeletionGuard): void {
    this.guards.set(guard.name, guard); // keyed by name: registering twice (e.g. a test re-boot) replaces, never duplicates
  }

  async blockers(userId: string): Promise<string[]> {
    const reasons: string[] = [];
    for (const guard of this.guards.values()) reasons.push(...(await guard.blockers(userId)));
    return reasons;
  }

  get names(): string[] {
    return [...this.guards.keys()].sort();
  }
}
