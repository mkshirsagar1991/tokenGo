import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'coverage/**']),
  {
    rules: {
      // Money is integer minor units; floating-point parsing of amounts is banned (same rule as the API).
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Never use floating point for money; use lib/money.' }],
      'no-restricted-properties': ['error', { object: 'Number', property: 'parseFloat', message: 'Never use floating point for money; use lib/money.' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser-side code must never reach for server-only modules (they read secrets and cookies).
    files: ['src/components/**', 'src/lib/client/**', 'src/features/**/components/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/lib/server/*', 'next/headers'], message: 'Server-only module: not importable from browser code.' }] }],
    },
  },
]);
