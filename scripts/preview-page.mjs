/**
 * Generates dist/preview.html: the calendar rendered against a real published
 * plan, in a page that can be opened directly from disk.
 *
 * Used to look at the UI without the reload cycle of an unpacked extension.
 * The plan files are public, so this fetches them at build time and embeds
 * them, then stubs `fetch` so the preview harness runs unmodified.
 *
 *   node scripts/preview-page.mjs [zenturie] [semester]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const zenturie = process.argv[2] ?? 'A23a';
const semester = process.argv[3] ?? '6';

const base = 'https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene';
const icsUrl = `${base}/${zenturie}_${semester}.ics`;
const htmlUrl = `${base}/${zenturie}_${semester}.html`;

async function grab(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  // text() always decodes UTF-8, which is what these files actually are
  // despite the server labelling them ISO-8859-15.
  return response.text();
}

const [ics, planHtml, bundle] = await Promise.all([
  grab(icsUrl),
  grab(htmlUrl).catch(() => ''),
  readFile(join(root, 'dist/preview.js'), 'utf8'),
]);

const page = `<!doctype html>
<meta charset="utf-8">
<title>better-cis preview — ${zenturie}_${semester}</title>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 24px; background: #eef1f5; font-family: "Open Sans", sans-serif; }
  .shell { max-width: 1140px; margin: 0 auto; }
  .note { margin: 0 0 14px; font-size: 13px; color: #5b6470; }
  .note b { color: #00387a; }
  .stupla { background: #fff; padding: 16px; border-radius: 3px; }
  h2 { margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #333; }
  #controls { margin: 16px 0 0; font-size: 13px; }
  #controls button { margin-right: 6px; padding: 5px 10px; cursor: pointer; }
  #out { margin-top: 10px; font-size: 12px; color: #5b6470; font-family: ui-monospace, monospace; }
</style>
<div class="shell">
  <p class="note">
    <b>better-cis preview</b> — plan ${zenturie}_${semester}, embedded at build time.
    The block below stands in for the CIS page's own widget.
  </p>
  <div class="stupla">
    <h2>Ihr Stundenplan</h2>
    <table class="contenttable"><tbody><tr><td>original CIS table (hidden by the extension)</td></tr></tbody></table>
  </div>
  <div id="controls">
    <button data-mode="fresh">First run (nothing selected)</button>
    <button data-mode="selected">With courses selected</button>
    <button data-mode="changes">With changes</button>
    <div id="out"></div>
  </div>
</div>
<script id="plan-ics" type="text/plain">${ics.replace(/<\/script>/gi, '<\\/script>')}</script>
<script id="plan-html" type="text/plain">${planHtml.replace(/<\/script>/gi, '<\\/script>')}</script>
<script>
// Serve the embedded plan files to the harness, which otherwise fetches them.
const PLAN = {
  ${JSON.stringify(icsUrl)}: document.getElementById('plan-ics').textContent,
  ${JSON.stringify(htmlUrl)}: document.getElementById('plan-html').textContent,
};
window.fetch = async (input) => {
  const url = String(input);
  if (url in PLAN) return new Response(PLAN[url], { status: 200 });
  return new Response('', { status: 404 });
};
</script>
<script>${bundle}</script>
<script>
const out = document.getElementById('out');
// The stub page has no plan link, so the reference is supplied directly.
const REF = { zenturie: ${JSON.stringify(zenturie)}, semester: ${JSON.stringify(semester)} };
const MODES = {
  fresh: {},
  // A plausible load: one elective, one Englisch group, and the core lectures.
  selected: { autoSelect: true },
  changes: { autoSelect: true, simulateChanges: true },
};

async function run(mode) {
  out.textContent = await window.__betterCisPreview({ ...REF, ...MODES[mode] });
}

for (const b of document.querySelectorAll('#controls button')) {
  b.addEventListener('click', () => run(b.dataset.mode));
}
run('fresh');
</script>
`;

await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist/preview.html'), page);
console.log(`dist/preview.html written — plan ${zenturie}_${semester}, ${ics.length} bytes of ics`);
