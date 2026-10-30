import { ValidationFailedError } from './errors';

export const MAX_TEXT = 1000;

/**
 * Cleans free text typed by a person. Control characters are refused rather than silently dropped (they are never typed
 * by accident), line breaks are kept but runs of blank lines are collapsed, and an empty result means "no text".
 * The text is stored as typed — it is NEVER interpreted as markup: every client must render it as plain text.
 */
export function normalizeText(raw: unknown, field = 'text', max = MAX_TEXT): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationFailedError(`${field} must be text`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) throw new ValidationFailedError(`${field} contains characters that are not allowed`);
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > max) throw new ValidationFailedError(`${field} must be at most ${max} characters`);
  return text === '' ? null : text;
}

