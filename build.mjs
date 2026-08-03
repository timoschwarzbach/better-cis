/**
 * Builds an unpacked extension for each browser into dist/.
 *
 * The two targets differ in exactly one interesting way: Chrome runs the
 * background script as a service worker, while Firefox's MV3 support wants a
 * non-module event page. Both manifests are generated from one description
 * below so they cannot drift apart.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const site = JSON.parse(await readFile(join(root, 'src/site.config.json'), 'utf8'));

if (site.origins.some((o) => o.includes('REPLACE-ME'))) {
  console.warn(
    '\n  ⚠  src/site.config.json still has placeholder origins.\n' +
      '     The build will succeed, but the extension will not match any page.\n',
  );
}

/** Entry points, skipped silently when not yet written. */
const ENTRIES = [
  { in: 'src/background/index.ts', out: 'background' },
  { in: 'src/content/index.ts', out: 'content' },
  { in: 'src/popup/index.ts', out: 'popup' },
  { in: 'src/options/index.ts', out: 'options' },
];

const present = ENTRIES.filter((entry) => existsSync(join(root, entry.in)));

/**
 * The preview harness is a development tool, not part of the extension: it is
 * built as a standalone IIFE for injection into a page, and deliberately never
 * added to either manifest.
 */
async function buildPreview() {
  const entry = join(root, 'src/preview/index.ts');
  if (!existsSync(entry)) return;
  await build({
    entryPoints: [entry],
    outfile: join(root, 'dist/preview.js'),
    bundle: true,
    format: 'iife',
    target: ['chrome110'],
    // Minified so the bundle can be pasted into a devtools console or an
    // automated evaluate call without hitting payload limits.
    minify: true,
    logLevel: 'silent',
    // The same defines as the extension bundles. Without these, any library
    // module reading __SITE_CONFIG__ would throw a ReferenceError the moment
    // the preview page loads.
    define: {
      'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
      __SITE_CONFIG__: JSON.stringify(site),
    },
  });
}

function manifestFor(target) {
  const isFirefox = target === 'firefox';

  const manifest = {
    manifest_version: 3,
    name: 'better-cis',
    version: pkg.version,
    description: pkg.description,
    permissions: ['storage', 'alarms'],
    host_permissions: site.origins,
    action: {
      default_title: 'better-cis',
      ...(existsSync(join(root, 'src/popup/index.html'))
        ? { default_popup: 'popup/index.html' }
        : {}),
    },
    background: isFirefox
      ? { scripts: ['background.js'] }
      : { service_worker: 'background.js', type: 'module' },
  };

  if (existsSync(join(root, 'src/content/index.ts'))) {
    manifest.content_scripts = [
      {
        matches: site.contentScriptMatches,
        js: ['content.js'],
        // No `css` entry: the panel styles itself inside a shadow root, which
        // is what keeps Bootstrap and TYPO3's rules from reaching into it.
        // The page's own calendar is rendered before this runs, so waiting for
        // idle would show the old table first and then swap it.
        run_at: 'document_end',
      },
    ];
  }

  if (existsSync(join(root, 'src/options/index.html'))) {
    manifest.options_ui = { page: 'options/index.html', open_in_tab: true };
  }

  if (isFirefox) {
    manifest.browser_specific_settings = {
      gecko: {
        // Firefox requires a stable add-on id: without it, storage does not
        // survive a reload, and the add-on cannot be signed for permanent
        // installation. Change this before submitting to AMO if you would
        // rather key it to a domain you own.
        id: site.firefoxAddonId ?? 'better-cis@localhost',
        strict_min_version: '115.0',
        // Everything stays in local storage; nothing is sent anywhere. Firefox
        // will require this declaration, and "none" is the honest answer.
        data_collection_permissions: { required: ['none'] },
      },
    };
  }

  return manifest;
}

async function buildTarget(target) {
  const outdir = join(root, 'dist', target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  // Output format is per entry point, not per browser.
  //
  //  - Content scripts are executed as *classic* scripts in both browsers, so
  //    any top-level `import`/`export` would be a syntax error. Always IIFE.
  //  - Chrome runs the background as an ES module service worker; Firefox runs
  //    it as a classic event-page script.
  //
  // Leaving this implicit worked only by accident: the bundle happened to emit
  // no module syntax. A future import could change that silently.
  const groups = [
    {
      entries: present.filter((e) => e.out === 'background'),
      format: target === 'firefox' ? 'iife' : 'esm',
    },
    { entries: present.filter((e) => e.out !== 'background'), format: 'iife' },
  ].filter((group) => group.entries.length > 0);

  for (const group of groups) {
    const options = {
      entryPoints: group.entries.map((e) => ({ in: join(root, e.in), out: e.out })),
      outdir,
      bundle: true,
      format: group.format,
      target: ['chrome110', 'firefox115'],
      sourcemap: watch ? 'inline' : false,
      minify: !watch,
      logLevel: 'info',
      define: {
        'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
        __SITE_CONFIG__: JSON.stringify(site),
      },
    };

    if (watch) {
      const ctx = await context(options);
      await ctx.watch();
    } else {
      await build(options);
    }
  }

  await writeFile(
    join(outdir, 'manifest.json'),
    JSON.stringify(manifestFor(target), null, 2) + '\n',
  );

  // Static assets: HTML pages and icons, copied only when they exist.
  for (const dir of ['popup', 'options']) {
    const src = join(root, 'src', dir, 'index.html');
    if (existsSync(src)) {
      await mkdir(join(outdir, dir), { recursive: true });
      await cp(src, join(outdir, dir, 'index.html'));
    }
  }
  if (existsSync(join(root, 'src/icons'))) {
    await cp(join(root, 'src/icons'), join(outdir, 'icons'), { recursive: true });
  }
}

if (present.length === 0) {
  console.error('No entry points found under src/. Nothing to build.');
  process.exit(1);
}

await Promise.all([buildTarget('chrome'), buildTarget('firefox'), buildPreview()]);
console.log(
  `\n  Built ${present.map((e) => e.out).join(', ')} → dist/chrome and dist/firefox` +
    (watch ? ' (watching)' : ''),
);
