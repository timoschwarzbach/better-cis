/**
 * The worker's handler, driven directly with a stub upstream.
 *
 * `handle` takes its fetch as a dependency precisely so this can run under
 * `node --test` without wrangler or a network: the interesting behaviour is
 * routing, filtering and error mapping, none of which needs an edge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { handle } from '../worker/src/handler.ts';
import { encodeSelection } from '../src/lib/ical-link.ts';
import { parseIcs } from '../src/lib/ics.ts';
import { enrichEvents } from '../src/lib/sked.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ics = readFileSync(join(here, 'fixtures/plan.ics'), 'utf8');
const planHtml = readFileSync(join(here, 'fixtures/plan.html'), 'utf8');

const LAST_MODIFIED = 'Fri, 31 Jul 2026 10:34:16 GMT';

/** Records what was fetched, so "did not touch the origin" is assertable. */
function stub(overrides: { ics?: () => Response; html?: () => Response } = {}) {
  const requested: string[] = [];
  return {
    requested,
    deps: {
      fetchUpstream: async (url: string) => {
        requested.push(url);
        if (url.endsWith('.ics')) {
          return (
            overrides.ics?.() ??
            new Response(ics, { headers: { 'Last-Modified': LAST_MODIFIED } })
          );
        }
        return overrides.html?.() ?? new Response(planHtml);
      },
    },
  };
}

const get = (path: string, init?: RequestInit, s = stub()) =>
  handle(new Request(`https://ical.example.dev${path}`, init), s.deps);

const eventCount = (body: string) => (body.match(/BEGIN:VEVENT/g) ?? []).length;

const allEvents = enrichEvents(parseIcs(ics, { defaultTimeZone: 'Europe/Berlin' }).events);

test('the whole plan is served when no selection is given', async () => {
  const response = await get('/A23a_6.ics');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/calendar; charset=utf-8');

  const body = await response.text();
  assert.match(body, /^BEGIN:VCALENDAR/);
  assert.equal(eventCount(body), allEvents.length);
});

test('a selection filters to exactly those courses', async () => {
  const key = 'WP WP Mergers and Aquisitions';
  const expected = allEvents.filter((e) => e.courseKey === key).length;
  assert.ok(expected > 0, 'fixture should contain the course under test');

  const compact = await get(`/A23a_6.ics?c=${await encodeSelection([key])}`);
  assert.equal(eventCount(await compact.text()), expected);

  // The plaintext form has to agree with the compact one, or a hand-edited
  // link would quietly serve something else.
  const plain = await get(`/A23a_6.ics?course=${encodeURIComponent(key)}`);
  assert.equal(eventCount(await plain.text()), expected);
});

test('an unknown course key serves an empty calendar, not an error', async () => {
  const response = await get('/A23a_6.ics?course=Kurs%20den%20es%20nicht%20gibt');
  assert.equal(response.status, 200);

  const body = await response.text();
  assert.equal(eventCount(body), 0);
  assert.match(body, /BEGIN:VCALENDAR/);
});

test('the ETag is stable across identical requests and honours If-None-Match', async () => {
  const first = await get('/A23a_6.ics');
  const etag = first.headers.get('ETag');
  assert.ok(etag);

  // Stability is the point: DTSTAMP comes from the upstream Last-Modified, so
  // an unchanged plan must not look like a change on every poll.
  assert.equal((await get('/A23a_6.ics')).headers.get('ETag'), etag);

  const conditional = await get('/A23a_6.ics', { headers: { 'If-None-Match': etag! } });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), '');
});

test('a changed plan changes the ETag', async () => {
  // replaceAll, not replace: the first occurrence is in the feed's SUMMARY,
  // which the writer discards, so changing only that would correctly produce
  // an identical calendar.
  const other = stub({
    ics: () =>
      new Response(ics.replaceAll('H008', 'A105'), {
        headers: { 'Last-Modified': LAST_MODIFIED },
      }),
  });

  const before = (await get('/A23a_6.ics')).headers.get('ETag');
  const after = (await get('/A23a_6.ics', undefined, other)).headers.get('ETag');
  assert.notEqual(before, after);
});

test('a path that is not a plan never reaches the origin', async () => {
  for (const path of ['/A23a_.%2e%2fetc.ics', '/../../etc/passwd', '/A23a_6.ics.bak', '/x']) {
    const s = stub();
    const response = await handle(new Request(`https://ical.example.dev${path}`), s.deps);
    assert.equal(response.status, 404, `expected 404 for ${path}`);
    assert.deepEqual(s.requested, [], `${path} should not have been fetched upstream`);
  }
});

test('an unreadable selection is a 400 and is not guessed at', async () => {
  const s = stub();
  const response = await handle(
    new Request('https://ical.example.dev/A23a_6.ics?c=%21%21'),
    s.deps,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(s.requested, []);
});

test('upstream failures map to honest statuses', async () => {
  const missing = stub({ ics: () => new Response('', { status: 404 }) });
  assert.equal((await get('/ZZZZ_9.ics', undefined, missing)).status, 404);

  const broken = stub({ ics: () => new Response('', { status: 500 }) });
  assert.equal((await get('/A23a_6.ics', undefined, broken)).status, 502);

  const garbage = stub({ ics: () => new Response('<html>maintenance</html>') });
  assert.equal((await get('/A23a_6.ics', undefined, garbage)).status, 502);

  const offline = {
    fetchUpstream: async () => {
      throw new Error('network');
    },
  };
  assert.equal((await handle(new Request('https://ical.example.dev/A23a_6.ics'), offline)).status, 502);
});

test('the HTML plan is best-effort, exactly as in the extension', async () => {
  const noHtml = stub({ html: () => new Response('', { status: 500 }) });
  const response = await get('/A23a_6.ics', undefined, noHtml);

  // A missing annotation source costs change notes, never the calendar.
  assert.equal(response.status, 200);
  assert.equal(eventCount(await response.text()), allEvents.length);
});

test('notes=0 skips the second upstream request', async () => {
  const s = stub();
  await handle(new Request('https://ical.example.dev/A23a_6.ics?notes=0'), s.deps);
  assert.deepEqual(
    s.requested.filter((url) => url.endsWith('.html')),
    [],
  );
});

test('only GET and HEAD are answered', async () => {
  assert.equal((await get('/A23a_6.ics', { method: 'POST' })).status, 405);

  const head = await get('/A23a_6.ics', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(head.headers.get('ETag'));
});

test('the root explains how to use the endpoint', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /text\/plain/);
  assert.match(await response.text(), /<Zenturie>_<Semester>\.ics/);
});
