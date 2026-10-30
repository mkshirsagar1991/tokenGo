// Public API of the availability module.
export { AvailabilityModule } from './availability.module';
export { AvailabilityService } from './application/availability.service';
export type { SlotResult } from './application/availability.service';
export { PolicyService } from './application/policy.service';
export type { EffectivePolicy } from './application/policy.service';
export { computeSlots, occupiedInterval } from './domain/slot-engine';
export { localDateTime } from './domain/local-time';
