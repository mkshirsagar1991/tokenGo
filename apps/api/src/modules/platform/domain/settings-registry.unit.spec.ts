import { ValidationFailedError } from '../../../shared-kernel';
import { SETTINGS, defaultOf, settingDefinition, validateSetting } from './settings-registry';

describe('settings registry', () => {
  it('every setting ships a default that satisfies its own validation (no setting can start invalid)', () => {
    for (const key of Object.keys(SETTINGS)) {
      expect(() => validateSetting(key, defaultOf(settingDefinition(key)))).not.toThrow();
    }
  });

  it('refuses an unknown key', () => {
    expect(() => settingDefinition('payments.live_mode')).toThrow(ValidationFailedError);
    expect(() => validateSetting('nope', 1)).toThrow(/Unknown setting/);
  });

  it('never marks anything money-moving or secret-like as public', () => {
    const publicKeys = Object.entries(SETTINGS).filter(([, d]) => d.public).map(([k]) => k);
    expect(publicKeys.sort()).toEqual([
      'app.customer.min_version',
      'app.maintenance_message',
      'app.provider.min_version',
      'features.disputes_enabled',
      'features.reviews_enabled',
      'support.email',
      'support.hours',
      'support.phone',
      'topup.presets_minor',
    ]);
    expect(publicKeys.join(',')).not.toMatch(/secret|key|token|limit|commission/);
  });

  describe('strings', () => {
    it('trims, enforces length and pattern, and allows clearing', () => {
      expect(validateSetting('app.customer.min_version', ' 1.4.0 ')).toBe('1.4.0');
      expect(() => validateSetting('app.customer.min_version', '1.4')).toThrow(/like 1.4.0/);
      expect(() => validateSetting('app.customer.min_version', 140)).toThrow(/must be text/);
      expect(validateSetting('app.maintenance_message', '')).toBe('');
      expect(() => validateSetting('app.maintenance_message', 'x'.repeat(201))).toThrow(/at most 200/);
    });
  });

  describe('numbers', () => {
    it('only whole numbers within bounds', () => {
      expect(validateSetting('reviews.window_days', 45)).toBe(45);
      expect(() => validateSetting('reviews.window_days', 0)).toThrow(/between 1 and 180/);
      expect(() => validateSetting('reviews.window_days', 45.5)).toThrow(/whole number/);
      expect(() => validateSetting('reviews.window_days', '45')).toThrow(/whole number/);
    });
  });

  describe('booleans', () => {
    it('are not coerced', () => {
      expect(validateSetting('features.reviews_enabled', false)).toBe(false);
      expect(() => validateSetting('features.reviews_enabled', 'false')).toThrow(/true or false/);
    });
  });

  describe('top-up presets (a list of rupee amounts in paise)', () => {
    it('accepts a strictly increasing list within bounds', () => {
      expect(validateSetting('topup.presets_minor', [5000, 10000, 25000])).toEqual([5000, 10000, 25000]);
    });
    it.each([
      [[], /1 to 6 items/],
      [[1000, 2000, 3000, 4000, 5000, 6000, 7000], /1 to 6 items/],
      [[10000, 10000], /strictly increasing/],
      [[20000, 10000], /strictly increasing/],
      [[500], /between 1000 and 5000000/],
      [[10000, 99999999], /between 1000 and 5000000/],
      [[100.5], /whole numbers/],
      ['10000', /list of whole numbers/],
    ])('refuses %j', (value, message) => {
      expect(() => validateSetting('topup.presets_minor', value)).toThrow(message as RegExp);
    });
  });

  it('a default list is copied, so callers cannot mutate the registry', () => {
    const a = defaultOf(settingDefinition('topup.presets_minor')) as number[];
    a.push(1);
    expect(defaultOf(settingDefinition('topup.presets_minor'))).toHaveLength(5);
  });
});
