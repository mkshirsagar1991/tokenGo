// Creates apps/admin/.env.local with a random SESSION_SECRET if it does not exist yet (idempotent, never prints the secret).
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const secretLine = () => `SESSION_SECRET=${randomBytes(48).toString('base64url')}\n`;

if (!existsSync(file)) {
  writeFileSync(file, `API_BASE_URL=http://localhost:3000/api/v1\n${secretLine()}`, { mode: 0o600 });
  console.log('Created .env.local (random SESSION_SECRET generated, not shown).');
} else if (!/^SESSION_SECRET=.{32,}/m.test(readFileSync(file, 'utf8'))) {
  appendFileSync(file, `\n${secretLine()}`);
  console.log('Added a random SESSION_SECRET to .env.local.');
}
