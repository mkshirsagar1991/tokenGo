const COMMON = new Set([
  'password1234',
  'passw0rd1234',
  '123456789012',
  'qwertyuiop12',
  'administrator',
  'welcome12345',
  'letmein12345',
  'iloveyou1234',
]);

/** Length-first policy (NIST SP 800-63B): long passphrases, no arbitrary composition rules. */
export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = [];
  if (typeof password !== 'string' || password.length < 12) problems.push('must be at least 12 characters');
  if (typeof password === 'string' && password.length > 128) problems.push('must be at most 128 characters');
  if (typeof password === 'string') {
    if (/^(.)\1+$/.test(password)) problems.push('must not be a single repeated character');
    if (COMMON.has(password.toLowerCase())) problems.push('is too common');
    const local = context.email?.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push('must not contain your e-mail name');
  }
  return problems;
}
