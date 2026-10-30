# ADR-0002: Pin NestJS 11 / Kysely 0.28 (CommonJS-compatible) for v1

- **Status:** Accepted — revisit when the test/decorator toolchain for ESM is mature
- **Date:** 2026-10-06

## Context
The proposal chose NestJS. At install time the newest majors (`@nestjs/*` 12.x, `kysely` 0.29.x) are **ESM-only** (`"type": "module"`, no CJS entry). Adopting them forces an ESM-only toolchain: `.js` import suffixes, Jest ESM mode, and an SWC/esbuild pipeline that must preserve `emitDecoratorMetadata` (Nest DI depends on it).

## Decision
Use `@nestjs/*` ^11 (11.2.x), `@nestjs/swagger` ^11, `kysely` ^0.28 (dual CJS/ESM, verified loadable via `require`). Keep TypeScript `module: commonjs`, Jest + ts-jest.

## Consequences
- Proven, boring toolchain; DI metadata and Jest work without custom loaders.
- We forgo Nest 12 features until we migrate. Migration cost is bounded and mechanical (module format + import suffixes); it is a deliberate, scheduled change, not a surprise.
- `node-pg-migrate` 9 is ESM-only but used only as a CLI subprocess, so it does not affect the app build.
