import type { MoneyJson } from '@/lib/money';

export interface ReportOverview {
  range: { from: string; to: string; timezone: string };
  bookings: {
    created_by_status: Record<string, number>;
    requested: number;
    confirmed: number;
    completed: number;
    closed: number;
    distinct_customers: number;
  };
  money: {
    gross_booking_value_closed: MoneyJson;
    platform_commission: MoneyJson;
    topups_succeeded: MoneyJson & { count: number };
    refunds_succeeded: MoneyJson & { count: number };
    payouts_paid: MoneyJson & { count: number };
  };
  accounts: { new_users: number; new_providers: number; providers_approved: number };
}

export interface DailyRow {
  day: string;
  bookings_created: number;
  bookings_closed: number;
  gross_booking_value_closed: MoneyJson;
  topups_succeeded: MoneyJson;
  refunds_succeeded: MoneyJson;
}
