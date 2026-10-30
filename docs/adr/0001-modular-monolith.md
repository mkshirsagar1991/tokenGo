# ADR-0001: Modular monolith with lint-enforced module boundaries

- **Status:** Accepted (requirements §2, §27; proposal §D)
- **Date:** 2026-10-06

## Context
We need one deployable that can later shed modules into services without a redesign, but must not pay microservice operational cost now.

## Decision
One NestJS application (two process types from one image: `api`, `worker`). Each domain module owns its Postgres schema, exposes a public facade via `src/modules/<name>/index.ts`, and may be imported **only** through that file. `shared-kernel` is a leaf; `audit` (and later `wallet-ledger`) depend on nothing else.

Enforced by `dependency-cruiser` (`apps/api/.dependency-cruiser.cjs`, run in CI): no cycles, no cross-module deep imports, shared-kernel cannot import modules, leaf modules stay leaves, `domain/` stays framework-free. The rules were verified to fire on deliberate violations.

## Consequences
- Booking + financial hold must commit atomically, so modules share one DB transaction through `UnitOfWork` (`shared-kernel/database.ts`). This is the single place that would become a saga if a module were extracted; it is documented rather than hidden.
- Cross-module foreign keys exist only for identity-style references (`provider_id`, `user_id`) and are listed in DATABASE.md when written.
- Cross-module reads go through facades (e.g. `ProviderAccessService`), never another module's tables.
