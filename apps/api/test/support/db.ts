import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

/**
 * Integration-test database provisioning.
 *
 * Tests run against a REAL PostgreSQL (never a mock) because correctness depends on constraints,
 * triggers and locking. A migrated TEMPLATE database is built once per migration-set (keyed by a hash
 * of the migration files) and each test file gets a cheap `CREATE DATABASE ... TEMPLATE` clone.
 *
 * TEST_DATABASE_URL must point at an admin connection (e.g. the `postgres` database):
 *   docker compose -f docker/docker-compose.yml up -d
 *   TEST_DATABASE_URL=postgres://tokengo:tokengo_local_dev_only@localhost:55432/postgres
 */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://tokengo:tokengo_local_dev_only@localhost:55432/postgres';

const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');
const MIGRATE_BIN = resolve(__dirname, '../../node_modules/node-pg-migrate/bin/node-pg-migrate.js');

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Synchronous probe so a spec file can choose `describe` vs `describe.skip` at load time. A skipped suite
 * is REPORTED as skipped by Jest — a spatial test must never silently pass on a server without PostGIS.
 */
export function postgisAvailableSync(): boolean {
  const script =
    "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.PROBE_URL});await c.connect();" +
    "const r=await c.query(\"SELECT 1 FROM pg_available_extensions WHERE name='postgis'\");await c.end();process.stdout.write(r.rowCount?'1':'0')})().catch(()=>process.stdout.write('0'))";
  try {
    return execFileSync(process.execPath, ['-e', script], { env: { ...process.env, PROBE_URL: ADMIN_URL }, cwd: resolve(__dirname, '../..') }).toString() === '1';
  } catch {
    return false;
  }
}

export async function postgisAvailable(): Promise<boolean> {
  return admin(async (c) => {
    const r = await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'");
    return r.rowCount === 1;
  });
}

/**
 * Where PostGIS is not installed (e.g. a bare local PostgreSQL), a REDUCED schema is built so the
 * PostGIS-independent tests can still run: `geography` / `geometry` become text-backed DOMAINS and the
 * few ST_* functions the Phase-1 SQL uses (ST_MakePoint, ST_SetSRID, ST_X, ST_Y) get trivial shims.
 * This verifies the application logic, NOT PostGIS behaviour: spatial-index and distance queries need
 * the real thing, so tests that exercise them check `schema.hasPostgis` and skip. CI uses the docker
 * image (docker/docker-compose.yml), which always has PostGIS, so the real schema is verified there.
 */
const POSTGIS_SHIM = [
  '-- Up Migration',
  'CREATE DOMAIN geography AS text;',
  'CREATE DOMAIN geometry AS text;',
  "CREATE FUNCTION ST_MakePoint(x double precision, y double precision) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT x::text || ',' || y::text $$;",
  'CREATE FUNCTION ST_SetSRID(g text, srid integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT g $$;',
  "CREATE FUNCTION ST_X(g text) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(g, ',', 1)::double precision $$;",
  "CREATE FUNCTION ST_Y(g text) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(g, ',', 2)::double precision $$;",
  '-- Down Migration',
  '',
].join('\n');

function reduceForNoPostgis(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS postgis;/g, '-- (postgis unavailable: skipped)')
    .replace(/geography\(Point, 4326\)/g, 'geography')
    .replace(/CREATE INDEX provider_locations_geog_gix[^;]*;/g, '-- (geog index skipped)');
}

function prepareMigrationsDir(hasPostgis: boolean): string {
  if (hasPostgis) return MIGRATIONS_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'tokengo-mig-'));
  writeFileSync(join(dir, '1791244800000_postgis-shim.sql'), POSTGIS_SHIM);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'))) {
    writeFileSync(join(dir, f), reduceForNoPostgis(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
  }
  return dir;
}

function migrationFingerprint(hasPostgis: boolean): string {
  const h = createHash('sha256');
  h.update(hasPostgis ? 'pg' : 'nopg-v2'); // bump the suffix when the shim changes
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    h.update(f).update(readFileSync(join(MIGRATIONS_DIR, f)));
  }
  return h.digest('hex').slice(0, 12);
}

export interface TestSchema {
  databaseUrl: string;
  hasPostgis: boolean;
  drop: () => Promise<void>;
}

/** Builds (once) a migrated template, then returns a fresh isolated clone for the calling test file. */
export async function createTestDatabase(): Promise<TestSchema> {
  const hasPostgis = await postgisAvailable();
  const template = `tg_tpl_${migrationFingerprint(hasPostgis)}`;

  await admin(async (c) => {
    await c.query('SELECT pg_advisory_lock(727274)'); // serialise template creation across workers
    try {
      // Templates from older migration sets can never be reused again: drop them so they don't pile up.
      const stale = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'tg_tpl_%' AND datname NOT LIKE $1", [`${template}%`]);
      for (const row of stale.rows) await c.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);

      const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [template]);
      if (exists.rowCount === 0) {
        const building = `${template}_build`;
        await c.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${building}`);
        try {
          execFileSync(
            process.execPath,
            [MIGRATE_BIN, 'up', '--migrations-dir', prepareMigrationsDir(hasPostgis), '--database-url-var', 'MIGRATE_DB_URL'],
            { env: { ...process.env, MIGRATE_DB_URL: withDatabase(ADMIN_URL, building) }, stdio: 'pipe' },
          );
        } catch (err) {
          const e = err as { stdout?: Buffer; stderr?: Buffer };
          await c.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
          throw new Error(`Migrations failed:\n${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`, { cause: err });
        }
        await c.query(`ALTER DATABASE ${building} RENAME TO ${template}`);
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(727274)');
    }
  });

  const name = `tg_t_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${template}`));
  return {
    databaseUrl: withDatabase(ADMIN_URL, name),
    hasPostgis,
    drop: () => admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).then(() => undefined)),
  };
}
