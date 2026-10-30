'use strict';
// Copies ONE package and everything it needs at runtime out of a pnpm virtual store, keeping pnpm's layout
// (so transitive dependencies resolve exactly as they do in the lockfile).
//
//   node docker/pnpm-closure.cjs <workspace-package-dir> <package-name> <out-dir>
//
// Used by apps/api/Dockerfile (target `migrate`): `node-pg-migrate` is a devDependency of the API (it is a build/deploy
// tool, not part of the running service), so `pnpm deploy --prod` leaves it out of the runtime image. The migration job
// image is built from this closure only: node-pg-migrate + glob + jiti + yargs + pg, never the rest of the dev tree.
const fs = require('node:fs');
const path = require('node:path');

const [pkgDir, name, outDir] = process.argv.slice(2);
if (!pkgDir || !name || !outDir) {
  console.error('usage: pnpm-closure.cjs <package-dir> <package-name> <out-dir>');
  process.exit(2);
}

const top = path.join(pkgDir, 'node_modules', name);
if (!fs.existsSync(top)) {
  console.error(`${name} is not installed under ${pkgDir}/node_modules`);
  process.exit(1);
}

// <repo>/node_modules/.pnpm/<id>/node_modules/<name>  ->  <repo>/node_modules/.pnpm and <id>
const real = fs.realpathSync(top);
const marker = `${path.sep}.pnpm${path.sep}`;
const at = real.indexOf(marker);
if (at < 0) {
  console.error(`${real} is not inside a pnpm virtual store`);
  process.exit(1);
}
const store = real.slice(0, at + marker.length - 1); // .../node_modules/.pnpm
const idOf = (p) => p.slice(store.length + 1).split(path.sep)[0];

const seen = new Set();
const queue = [idOf(real)];
while (queue.length) {
  const id = queue.pop();
  if (seen.has(id)) continue;
  seen.add(id);
  const nm = path.join(store, id, 'node_modules');
  for (const entry of fs.readdirSync(nm)) {
    const entries = entry.startsWith('@') ? fs.readdirSync(path.join(nm, entry)).map((e) => path.join(entry, e)) : [entry];
    for (const e of entries) {
      const target = fs.realpathSync(path.join(nm, e));
      if (target.startsWith(store + path.sep)) queue.push(idOf(target));
    }
  }
}

const outStore = path.join(outDir, 'node_modules', '.pnpm');
fs.mkdirSync(outStore, { recursive: true });
for (const id of seen) {
  fs.cpSync(path.join(store, id), path.join(outStore, id), { recursive: true, verbatimSymlinks: true });
}
const link = path.join(outDir, 'node_modules', name);
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.symlinkSync(path.relative(path.dirname(link), path.join(outStore, idOf(real), 'node_modules', name)), link);
console.log(`copied ${seen.size} packages for ${name}`);
