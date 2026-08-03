/**
 * A stable fingerprint of built output, for deciding whether anything actually
 * changed.
 *
 * Used by CI to answer "is this worth releasing / deploying?" without guessing
 * from file paths. Paths are a poor proxy: src/lib/ feeds both the extension
 * and the worker, and each uses only part of it, so a touched file there says
 * nothing about whether either artifact moved.
 *
 *   node scripts/artifact-hash.mjs dist/chrome dist/firefox
 *
 * Two things make the result meaningful:
 *
 *  - `version` is stripped from any manifest. The release job bumps the patch
 *    number on every release, so leaving it in would make every build look
 *    different from the last and the check would never skip anything.
 *  - Entries are sorted by path, since directory order is not guaranteed.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node scripts/artifact-hash.mjs <dir|file>...');
  process.exit(1);
}

/** Every file under `root`, as [relativePath, absolutePath], depth-first. */
function walk(root, base = root) {
  if (statSync(root).isFile()) return [[relative(base, root) || root, root]];

  const out = [];
  for (const entry of readdirSync(root)) {
    out.push(...walk(join(root, entry), base));
  }
  return out;
}

const entries = [];
for (const root of roots) {
  for (const [rel, abs] of walk(root)) {
    // Prefix with the root so two dirs holding an identically named file
    // cannot collapse into one entry.
    entries.push([`${root}/${rel.split(sep).join('/')}`, abs]);
  }
}

entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const hash = createHash('sha256');
for (const [name, path] of entries) {
  hash.update(name);
  hash.update('\0');

  if (name.endsWith('manifest.json')) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.version;
    hash.update(JSON.stringify(manifest));
  } else {
    hash.update(readFileSync(path));
  }
  hash.update('\0');
}

process.stdout.write(hash.digest('hex'));
