# ADR-0004: Integration tests run against a real PostgreSQL (template-database cloning)

- **Status:** Accepted
- **Date:** 2026-10-06

## Decision
Integration tests never mock the database. `test/support/db.ts` builds a **migrated template database** once per migration-set (keyed by a hash of the migration files; stale templates are dropped) and gives every test file a cheap `CREATE DATABASE … TEMPLATE` clone. `TEST_DATABASE_URL` is an admin connection; the default targets `docker/docker-compose.yml` (`postgis/postgis:16-3.4`).

## Reduced-schema fallback (and its limits) — READ THIS
If the target server lacks the `postgis` extension, the harness builds a **reduced schema**: `geography`/`geometry` become text-backed domains and `ST_MakePoint/ST_SetSRID/ST_X/ST_Y` are shimmed; the GiST index is skipped. This lets everything that is not spatial be verified on a bare PostgreSQL.

It verifies application logic only. It does **not** verify: the real `geography` column type, the GiST index, PostGIS function behaviour, or any distance/radius query. Spatial behaviour must be verified on the PostGIS image (CI always uses it). Phase 1 results recorded in `docs/STATUS.md` state which environment each run used.

## Consequences
- Fast (≈45 s for the current 77 tests) and faithful for constraints, triggers and locking.
- Spatial suites (`test/search.int.spec.ts`) choose `describe` vs `describe.skip` at load time via a synchronous PostGIS probe, so on a server without PostGIS they are **reported as skipped** — a spatial test can never silently pass.
- Status as of this writing: the whole suite (207 tests) has been run on the real `postgis/postgis:16-3.4` image. The reduced-schema fallback was used only while Docker was unavailable (the first 77 tests) and is not needed on any machine with the compose database.
