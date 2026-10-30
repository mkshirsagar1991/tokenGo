import { DomainError } from '../../../shared-kernel';

/** Required reference configuration is missing: a deployment/data problem, never the caller's fault. */
export class LedgerInvariantFallback extends DomainError {
  constructor(message: string) {
    super('CONFIGURATION_MISSING', message, 500);
  }
}
