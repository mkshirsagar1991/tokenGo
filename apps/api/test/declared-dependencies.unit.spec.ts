import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * pnpm only links DECLARED dependencies into apps/api/node_modules. Jest runs under pnpm's shims, which put the whole
 * virtual store on NODE_PATH, so an import of a transitive package (it was `multer`, reached through
 * @nestjs/platform-express) passes every test and then fails with MODULE_NOT_FOUND the moment the compiled build is
 * started with plain `node` (production, the Docker image). This test reads what the compiler would actually emit,
 * so a type-only import is correctly ignored, and fails for any package the runtime needs but package.json does not declare.
 */
const root = join(__dirname, '..');
const declared = new Set(Object.keys((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}));
/** Dev-only tools that need devDependencies BY DESIGN (they refuse NODE_ENV=production and never ship in the runtime image). Exact (file, package) pairs only. */
const DEV_ONLY = new Set(['src/cli/seed-dev.ts::@nestjs/testing']);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** Package names a file needs at runtime, as emitted by the compiler (CommonJS, like the real build). */
function runtimePackages(file: string): string[] {
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const specifiers = [...js.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  return specifiers
    .filter((s) => !s.startsWith('.') && !builtins.has(s))
    .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!));
}

describe('runtime dependencies', () => {
  it('every package the compiled code requires is declared in package.json "dependencies"', () => {
    const files = sourceFiles(join(root, 'src'));
    expect(files.length).toBeGreaterThan(100); // non-vacuity: the walk really found the sources

    const missing = new Map<string, string[]>();
    let seen = 0;
    for (const f of files) {
      for (const pkg of runtimePackages(f)) {
        seen++;
        const rel = relative(root, f).replace(/\\/g, '/');
        if (!declared.has(pkg) && !DEV_ONLY.has(`${rel}::${pkg}`)) missing.set(pkg, [...(missing.get(pkg) ?? []), rel]);
      }
    }
    expect(seen).toBeGreaterThan(50); // non-vacuity: requires were really extracted
    expect([...missing.entries()].map(([pkg, where]) => `${pkg} (used by ${where.join(', ')})`)).toEqual([]);
  });
});
