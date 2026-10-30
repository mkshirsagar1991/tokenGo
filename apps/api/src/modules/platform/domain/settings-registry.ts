import { ValidationFailedError } from '../../../shared-kernel';

/**
 * Every platform setting an administrator can change, with its type, bounds and default. The registry is the ONLY source of
 * truth: an unknown key cannot be stored, and a value that does not satisfy its definition is refused with a message that
 * names the key. `public` settings are returned by the unauthenticated `GET /app-config` (the mobile apps read them); never
 * mark anything sensitive as public.
 */
export type SettingKind = 'string' | 'bool' | 'int' | 'int_list';

interface BaseDef {
  description: string;
  public: boolean;
}
export interface StringSetting extends BaseDef {
  kind: 'string';
  default: string;
  maxLength: number;
  /** Optional pattern a non-empty value must match. */
  pattern?: RegExp;
  patternHint?: string;
}
export interface BoolSetting extends BaseDef {
  kind: 'bool';
  default: boolean;
}
export interface IntSetting extends BaseDef {
  kind: 'int';
  default: number;
  min: number;
  max: number;
}
export interface IntListSetting extends BaseDef {
  kind: 'int_list';
  default: number[];
  min: number;
  max: number;
  minItems: number;
  maxItems: number;
  ascending: boolean;
}
export type SettingDef = StringSetting | BoolSetting | IntSetting | IntListSetting;
export type SettingValue = string | boolean | number | number[];

const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const SETTINGS: Record<string, SettingDef> = {
  'app.customer.min_version': { kind: 'string', default: '1.0.0', maxLength: 12, pattern: SEMVER, patternHint: 'like 1.4.0', public: true, description: 'Oldest customer app version allowed to run; older builds are asked to update.' },
  'app.provider.min_version': { kind: 'string', default: '1.0.0', maxLength: 12, pattern: SEMVER, patternHint: 'like 1.4.0', public: true, description: 'Oldest provider app version allowed to run; older builds are asked to update.' },
  'app.maintenance_message': { kind: 'string', default: '', maxLength: 200, public: true, description: 'When not empty, shown to every user as a notice (e.g. planned downtime).' },
  'support.phone': { kind: 'string', default: '', maxLength: 20, public: true, description: 'Customer-support phone number shown in the apps.' },
  'support.email': { kind: 'string', default: '', maxLength: 120, public: true, description: 'Customer-support email address shown in the apps.' },
  'support.hours': { kind: 'string', default: '', maxLength: 80, public: true, description: 'Support hours text, e.g. "Mon–Sat, 9 am – 7 pm IST".' },
  'features.reviews_enabled': { kind: 'bool', default: true, public: true, description: 'Customers can rate and review completed bookings.' },
  'features.disputes_enabled': { kind: 'bool', default: true, public: true, description: 'Customers can raise a dispute on a completed booking during the review window.' },
  'topup.presets_minor': { kind: 'int_list', default: [10000, 20000, 50000, 100000, 200000], min: 1000, max: 5_000_000, minItems: 1, maxItems: 6, ascending: true, public: true, description: 'Quick top-up amounts offered in the app, in paise (the server still enforces its own limits).' },
  'providers.documents_required': { kind: 'bool', default: false, public: false, description: 'A business must upload at least one verification document before it can be submitted for review.' },
  'reviews.window_days': { kind: 'int', default: 30, min: 1, max: 180, public: false, description: 'How many days after a booking closes the customer may still review it.' },
  'notifications.reminder_lead_minutes': { kind: 'int', default: 120, min: 15, max: 1440, public: false, description: 'How long before an appointment the reminder notification is sent.' },
  'disputes.operator_limit_minor': { kind: 'int', default: 500_000, min: 0, max: 100_000_000, public: false, description: 'Largest customer refund (paise) a support operator may decide alone; above it a platform administrator is required.' },
};

export function settingDefinition(key: string): SettingDef {
  const def = SETTINGS[key];
  if (!def) throw new ValidationFailedError(`Unknown setting "${key}"`);
  return def;
}

export function defaultOf(def: SettingDef): SettingValue {
  return def.kind === 'int_list' ? [...def.default] : def.default;
}

/** Returns the value in canonical form, or throws a ValidationFailedError naming the key. */
export function validateSetting(key: string, raw: unknown): SettingValue {
  const def = settingDefinition(key);
  const bad = (why: string): never => {
    throw new ValidationFailedError(`Setting "${key}": ${why}`, { key });
  };
  switch (def.kind) {
    case 'string': {
      if (typeof raw !== 'string') return bad('must be text');
      const v = raw.trim();
      if (v.length > def.maxLength) return bad(`must be at most ${def.maxLength} characters`);
      if (v !== '' && def.pattern && !def.pattern.test(v)) return bad(`must look ${def.patternHint ?? 'valid'}`);
      return v;
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : bad('must be true or false');
    case 'int': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return bad('must be a whole number');
      if (raw < def.min || raw > def.max) return bad(`must be between ${def.min} and ${def.max}`);
      return raw;
    }
    case 'int_list': {
      if (!Array.isArray(raw) || !raw.every((n) => typeof n === 'number' && Number.isInteger(n))) return bad('must be a list of whole numbers');
      const list = raw as number[];
      if (list.length < def.minItems || list.length > def.maxItems) return bad(`must have ${def.minItems} to ${def.maxItems} items`);
      if (list.some((n) => n < def.min || n > def.max)) return bad(`each item must be between ${def.min} and ${def.max}`);
      if (def.ascending && list.some((n, i) => i > 0 && n <= list[i - 1]!)) return bad('must be strictly increasing');
      return list;
    }
  }
}
