/**
 * Zips the built extensions for distribution.
 *
 * The layout matters more than it looks: browsers read `manifest.json` from
 * the *root* of the archive. Compressing the folder instead of its contents —
 * which is what Finder's "Compress" does — nests everything one level down and
 * makes Firefox reject the file as "corrupt". macOS also injects `__MACOSX`
 * resource forks and `.DS_Store`, which have no business in a signed package.
 *
 * So: zip from inside each directory, and exclude the junk explicitly.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

const EXCLUDES = ['.DS_Store', '__MACOSX/*', '*/.DS_Store'];

/** Firefox accepts either extension; .xpi installs directly, .zip is for AMO. */
const TARGETS = [
  { dir: 'chrome', outputs: ['better-cis-chrome.zip'] },
  { dir: 'firefox', outputs: ['better-cis-firefox.xpi', 'better-cis-firefox.zip'] },
];

for (const target of TARGETS) {
  const source = join(dist, target.dir);
  try {
    statSync(source);
  } catch {
    console.error(`  skipped ${target.dir}: not built`);
    continue;
  }

  for (const output of target.outputs) {
    const archive = join(dist, output);
    rmSync(archive, { force: true });
    // -X drops extra file attributes; running from inside `source` is what
    // puts manifest.json at the archive root.
    execFileSync('zip', ['-qrX', archive, '.', '-x', ...EXCLUDES], { cwd: source });

    const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    // Fail loudly rather than ship an archive that will not install.
    if (!listing.includes('manifest.json')) {
      throw new Error(`${output}: manifest.json is not at the archive root — ${listing.join(', ')}`);
    }
    const junk = listing.filter((name) => name.startsWith('__MACOSX') || name.endsWith('.DS_Store'));
    if (junk.length > 0) throw new Error(`${output}: contains ${junk.join(', ')}`);

    const size = statSync(archive).size;
    console.log(`  ${output}  ${(size / 1024).toFixed(1)} KB  (${listing.length} files)`);
  }
}

// Anything else at the top of dist/ is a leftover from an earlier attempt and
// is exactly what someone reaches for by mistake.
const known = new Set(TARGETS.flatMap((t) => t.outputs));
for (const entry of readdirSync(dist)) {
  if (/\.(zip|xpi)$/.test(entry) && !known.has(entry)) {
    console.log(`  note: dist/${entry} is not a package this script produced`);
  }
}
