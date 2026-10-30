/** True for a valid IANA time-zone name (e.g. "Asia/Kolkata"). Business timezone drives scheduling (docs §H.3). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
