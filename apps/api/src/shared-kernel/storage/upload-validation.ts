import { createHash } from 'node:crypto';
import { ValidationFailedError } from '../errors';

export type UploadType = 'image/jpeg' | 'image/png' | 'application/pdf';

export const EXTENSIONS: Record<UploadType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/** What the bytes ARE, from their signature — never from the file name or the type the client claims. */
export function sniffType(b: Buffer): UploadType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A first line of defence, NOT an antivirus: it refuses the standard antivirus test file, executables disguised as documents,
 * and PDFs that carry active content (scripts, auto-run actions, embedded launchers). A production deployment should add a real
 * scanner in front of storage (see docs/SECURITY-CHECKLIST.md); this keeps the obvious abuse out in the meantime.
 */
export function inspectContent(b: Buffer, type: UploadType): string | null {
  const text = b.toString('latin1');
  if (text.includes(EICAR)) return 'The file was identified as malware';
  if (b.length > 2 && ((b[0] === 0x4d && b[1] === 0x5a) || (b[0] === 0x7f && b[1] === 0x45))) return 'Executable files are not accepted';
  if (type === 'application/pdf' && /\/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia)\b/.test(text)) return 'PDF files with scripts or embedded content are not accepted';
  return null;
}

export interface CheckedUpload {
  type: UploadType;
  size: number;
  sha256: string;
}

/**
 * Validates an uploaded file or throws a ValidationFailedError a person can act on. The claimed content type must agree with the
 * actual bytes, the type must be one of `allowed`, and the size must be within `maxBytes`.
 */
export function checkUpload(file: { buffer?: Buffer; mimetype?: string } | undefined, opts: { allowed: readonly UploadType[]; maxBytes: number }): CheckedUpload & { buffer: Buffer } {
  if (!file?.buffer || file.buffer.length === 0) throw new ValidationFailedError('Attach a file');
  const buffer = file.buffer;
  if (buffer.length > opts.maxBytes) throw new ValidationFailedError(`The file is too large (the limit is ${Math.floor(opts.maxBytes / 1_000_000)} MB)`);
  const actual = sniffType(buffer);
  if (!actual || !opts.allowed.includes(actual)) throw new ValidationFailedError(`Unsupported file type. Use ${opts.allowed.map((t) => EXTENSIONS[t].toUpperCase()).join(', ')}.`);
  if (file.mimetype && file.mimetype !== actual) throw new ValidationFailedError('The file does not match its declared type');
  const problem = inspectContent(buffer, actual);
  if (problem) throw new ValidationFailedError(problem);
  return { buffer, type: actual, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}
