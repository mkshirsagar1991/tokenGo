export type SettingKind = 'string' | 'bool' | 'int' | 'int_list';
export type SettingValue = string | boolean | number | number[];

export interface SettingView {
  key: string;
  description: string;
  kind: SettingKind;
  public: boolean;
  value: SettingValue;
  default: SettingValue;
  /** false = still on the built-in default. */
  customised: boolean;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  constraints: { max_length?: number; hint?: string | null; min?: number; max?: number; min_items?: number; max_items?: number; ascending?: boolean };
}

export const SETTING_GROUPS: Record<string, string> = {
  app: 'Mobile apps',
  support: 'Customer support',
  features: 'Feature switches',
  topup: 'Wallet top-ups',
  reviews: 'Reviews',
  notifications: 'Notifications',
  disputes: 'Disputes',
};

export const groupOf = (key: string): string => key.split('.')[0] ?? key;
