import { Injectable } from '@nestjs/common';
import { AvailabilityRepository, PolicyRow } from '../infrastructure/availability.repository';

export interface EffectivePolicy {
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxAdvanceDays: number;
  responseDeadlineMin: number;
  /** Minutes before the start that arrival may be verified. */
  checkInWindowMin: number;
  /** Minutes after the start before a provider may mark a no-show. */
  noShowGraceMin: number;
  /** After completion, hours the customer has to dispute before settlement happens automatically. */
  settlementHoldHours: number;
}

/**
 * Booking-policy resolution, most specific wins: PROVIDER override -> PLATFORM default. Every field is
 * resolved independently, so a provider may override just the lead time. (A CATEGORY tier slots in between
 * without changing callers.) Nothing here is hard-coded: the platform row is data an admin can change.
 */
@Injectable()
export class PolicyService {
  constructor(private readonly repo: AvailabilityRepository) {}

  async resolve(providerId: string): Promise<EffectivePolicy> {
    const [platform, provider] = await Promise.all([this.repo.findPlatformPolicy(), this.repo.findProviderPolicy(providerId)]);
    if (!platform) throw new Error('Platform booking policy is missing (migration 1791244800007 seeds it)');
    return merge(platform, provider);
  }
}

function merge(platform: PolicyRow, provider?: PolicyRow): EffectivePolicy {
  return {
    slotGranularityMin: provider?.slot_granularity_min ?? platform.slot_granularity_min!,
    minLeadTimeMin: provider?.min_lead_time_min ?? platform.min_lead_time_min!,
    maxAdvanceDays: provider?.max_advance_days ?? platform.max_advance_days!,
    responseDeadlineMin: provider?.response_deadline_min ?? platform.response_deadline_min!,
    checkInWindowMin: provider?.check_in_window_min ?? platform.check_in_window_min!,
    noShowGraceMin: provider?.no_show_grace_min ?? platform.no_show_grace_min!,
    settlementHoldHours: provider?.settlement_hold_hours ?? platform.settlement_hold_hours!,
  };
}
