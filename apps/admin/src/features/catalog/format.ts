import { formatBps, formatMoney } from '@/lib/money';
import type { CommissionRule } from './types';

/** "10%" for a percentage rule, "₹20 per booking" for a fixed one. Pure, so both server and client components can use it. */
export const describeRate = (r: Pick<CommissionRule, 'kind' | 'percent_bps' | 'fixed'>): string => (r.kind === 'PERCENT' ? formatBps(r.percent_bps ?? 0) : `${formatMoney(r.fixed)} per booking`);
