#!/usr/bin/env node
// Creates apps/api/.env for LOCAL development with freshly generated, machine-local secrets.
// Refuses to overwrite an existing .env (rotating the PII keys would orphan existing local data).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '.env');

if (existsSync(target)) {
  console.error(`${target} already exists — not overwriting. Delete it first if you really want new keys (this orphans local data).`);
  process.exit(1);
}

const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = (key, type) => key.export({ type, format: 'pem' }).toString().trim().replace(/\n/g, '\\n');

const generated = {
  JWT_PRIVATE_KEY_PEM: `"${pem(pair.privateKey, 'pkcs8')}"`,
  JWT_PUBLIC_KEY_PEM: `"${pem(pair.publicKey, 'spki')}"`,
  PII_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64'),
  PII_HASH_KEY_B64: randomBytes(32).toString('base64'),
  PAYMENT_WEBHOOK_SECRET_B64: randomBytes(32).toString('base64'),
};

const lines = readFileSync(join(root, '.env.example'), 'utf8')
  .split('\n')
  .map((line) => {
    const key = line.split('=')[0];
    return key in generated ? `${key}=${generated[key]}` : line;
  });

writeFileSync(target, lines.join('\n'), { mode: 0o600 });
console.log(`Wrote ${target} with new local-only secrets (git-ignored). Keep it: the PII keys must stay stable.`);
