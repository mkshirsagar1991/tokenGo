# ADR-0003: SQL-first, forward-only migrations + Kysely query builder

- **Status:** Accepted (proposal §B.1, §G.8)
- **Date:** 2026-10-06

## Context
Correctness depends on features ORMs hide or fight: `SELECT … FOR UPDATE`, exclusion constraints, partial/expression indexes, deferred constraint triggers, PostGIS, append-only triggers.

## Decision
- Schema is defined **only** by reviewed SQL files in `apps/api/migrations/` (executed by `node-pg-migrate`). Forward-only: the `Down` section is intentionally empty. Destructive changes follow expand → migrate → contract and need a separately approved production procedure.
- Application queries use Kysely with **hand-written per-module table types** (`infrastructure/db-types.ts`). Each module only types its own schema. Type generation from the live schema can replace these later.
- `bigint` columns are strings at the `pg` boundary and converted explicitly (`BigInt(...)`); money is never a JS float.

## Consequences
- More SQL to write and review; in exchange, constraints (not application code) are the final arbiter of integrity — see the append-only audit triggers and role-scope foreign key, both exercised by tests.
- Hand-written types can drift from the schema; integration tests against a real database are the safety net (ADR-0004).
