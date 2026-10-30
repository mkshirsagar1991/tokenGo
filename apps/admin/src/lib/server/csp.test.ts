import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('production upgrades insecure requests by default', () => {
    expect(buildCsp('n', { dev: false })).toContain('upgrade-insecure-requests');
    expect(buildCsp('n', { dev: false, upgradeInsecure: true })).toContain('upgrade-insecure-requests');
  });

  it('a deliberate plain-http test deployment drops only that directive, nothing else gets looser', () => {
    const https = buildCsp('n', { dev: false });
    const http = buildCsp('n', { dev: false, upgradeInsecure: false });
    expect(http).not.toContain('upgrade-insecure-requests');
    expect(http.split('; ').filter((d) => d !== 'upgrade-insecure-requests')).toEqual(https.split('; ').filter((d) => d !== 'upgrade-insecure-requests'));
    expect(http).not.toContain('unsafe-eval');
    expect(http).not.toContain('unsafe-inline');
  });
});
