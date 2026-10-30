/**
 * Architecture boundary rules (docs/ARCHITECTURE-PROPOSAL.md §D.2).
 * A module may import another module ONLY through its public entry: src/modules/<name>/index.ts.
 * The shared-kernel must not depend on any module. ledger/audit are leaf modules.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are forbidden (rule 6).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'modules-only-via-public-api',
      severity: 'error',
      comment: 'Cross-module imports must go through src/modules/<name>/index.ts (rule 1).',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'shared-kernel-is-a-leaf',
      severity: 'error',
      comment: 'shared-kernel must not depend on any domain module.',
      from: { path: '^src/shared-kernel/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'ledger-is-a-leaf',
      severity: 'error',
      comment: 'wallet-ledger depends on shared-kernel only (rule 4).',
      from: { path: '^src/modules/wallet-ledger/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/wallet-ledger/' },
    },
    {
      name: 'audit-is-a-leaf',
      severity: 'error',
      comment: 'audit depends on shared-kernel only (rule 4).',
      from: { path: '^src/modules/audit/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/audit/' },
    },
    {
      name: 'domain-layer-is-pure',
      severity: 'error',
      comment: 'domain/ must not import infrastructure, presentation or framework code.',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { path: ['/infrastructure/', '/presentation/', '^node_modules/@nestjs/', '^node_modules/pg/', '^node_modules/kysely/'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '\\.spec\\.ts$' },
  },
};
