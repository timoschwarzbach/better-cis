/**
 * The link is the whole interface between the extension and the worker, and it
 * is decoded from untrusted input on a public endpoint. Both properties are
 * tested here: that a selection survives the trip, and that nothing else does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSubscribeUrl,
  decodeSelection,
  encodeSelection,
  googleCalendarUrl,
  isPlanToken,
  isSemesterToken,
  normaliseEndpoint,
  selectionFromUrl,
  webcalUrl,
} from '../src/lib/ical-link.ts';

/** Course keys as `enrichEvents` actually derives them, umlauts and all. */
const KEYS = [
  'V A113 Usability Engineering',
  'WP WP Strat. Marketing-Projekt',
  'Ü I177 Englisch Prof. Dr. Müller, B.',
  'S A118 Wiss.Arb.2 & Co',
];

test('a selection survives encoding', async () => {
  const encoded = await encodeSelection(KEYS);
  assert.deepEqual(await decodeSelection(encoded), KEYS);
});

test('the encoding is compact enough for a URL', async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `V A1${i} Modul mit langem Namen ${i}`);
  const encoded = await encodeSelection(twelve);

  assert.equal(encoded[0], '1', 'a dozen similar keys should compress');
  assert.ok(encoded.length < 400, `encoded length ${encoded.length}`);
  assert.deepEqual(await decodeSelection(encoded), twelve);
});

test('the uncompressed form round-trips too', async () => {
  // Deflate is skipped when it would not help, so this path is reached in
  // normal use — a single short course key.
  const encoded = await encodeSelection(['V A1 X']);
  assert.equal(encoded[0], '0');
  assert.deepEqual(await decodeSelection(encoded), ['V A1 X']);
});

test('malformed input decodes to null rather than a partial selection', async () => {
  for (const bad of [
    '',
    '1',
    '9abcd', // unknown version marker
    '1!!!!', // outside the base64url alphabet
    '1abcd', // valid alphabet, not valid deflate
    `0${Buffer.from('{"not":"an array"}').toString('base64url')}`,
    `0${Buffer.from('["ok", 5]').toString('base64url')}`, // not all strings
    `0${Buffer.from('not json').toString('base64url')}`,
  ]) {
    assert.equal(await decodeSelection(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('an oversized parameter is refused without being decompressed', async () => {
  assert.equal(await decodeSelection('1' + 'A'.repeat(9000)), null);

  // Well-formed but absurd: more keys than any timetable has.
  const many = Array.from({ length: 501 }, (_, i) => `K${i}`);
  assert.equal(await decodeSelection(await encodeSelection(many)), null);
});

test('a request URL yields the selection in either form', async () => {
  const compact = await encodeSelection(KEYS);
  assert.deepEqual(await selectionFromUrl(new URL(`https://w.dev/A23a_6.ics?c=${compact}`)), KEYS);

  // The hand-editable form, for anyone debugging their own feed.
  assert.deepEqual(
    await selectionFromUrl(new URL('https://w.dev/A23a_6.ics?course=V%20A1&course=V%20A2')),
    ['V A1', 'V A2'],
  );

  // No parameter is "the whole plan", which is distinct from an unreadable one.
  assert.equal(await selectionFromUrl(new URL('https://w.dev/A23a_6.ics')), null);
  assert.equal(await selectionFromUrl(new URL('https://w.dev/A23a_6.ics?c=zz')), 'invalid');
});

test('endpoints are normalised the way people paste them', () => {
  assert.equal(normaliseEndpoint('cis.example.workers.dev'), 'https://cis.example.workers.dev/');
  assert.equal(normaliseEndpoint('  https://cis.example.workers.dev  '), 'https://cis.example.workers.dev/');

  // The trailing slash is load-bearing: without it the path segment is lost
  // when the .ics filename is resolved against the base.
  assert.equal(normaliseEndpoint('https://example.com/ical'), 'https://example.com/ical/');
  assert.equal(normaliseEndpoint('https://example.com/ical?x=1#y'), 'https://example.com/ical/');

  for (const bad of ['', '   ', 'not a url', 'nodot']) {
    assert.equal(normaliseEndpoint(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('a loopback endpoint keeps http, so `wrangler dev` is reachable', () => {
  assert.equal(normaliseEndpoint('localhost:8787'), 'http://localhost:8787/');
  assert.equal(normaliseEndpoint('127.0.0.1:8787'), 'http://127.0.0.1:8787/');

  // An explicit scheme is always honoured, including https on loopback.
  assert.equal(normaliseEndpoint('https://localhost:8787'), 'https://localhost:8787/');

  // A host that merely starts with those letters is not loopback.
  assert.equal(normaliseEndpoint('localhost.example.com'), 'https://localhost.example.com/');
});

test('a subscription URL keeps the endpoint path and refuses a bad plan', async () => {
  const url = await buildSubscribeUrl({
    endpoint: 'https://example.com/ical',
    ref: { zenturie: 'A23a', semester: '6' },
    selection: null,
  });
  assert.equal(url, 'https://example.com/ical/A23a_6.ics');

  for (const ref of [
    { zenturie: '../etc', semester: '6' },
    { zenturie: 'A23a', semester: '../6' },
    { zenturie: '', semester: '6' },
  ]) {
    assert.equal(await buildSubscribeUrl({ endpoint: 'example.com', ref, selection: null }), null);
  }
});

test('the calendar-app links point at the same feed', async () => {
  const url = (await buildSubscribeUrl({
    endpoint: 'example.com',
    ref: { zenturie: 'A23a', semester: '6' },
    selection: ['V A1'],
  }))!;

  assert.ok(webcalUrl(url).startsWith('webcal://example.com/'));
  assert.ok(googleCalendarUrl(url).includes(encodeURIComponent(webcalUrl(url))));
});

test('plan tokens are an allowlist', () => {
  for (const good of ['A23a', 'W24b', 'X1']) assert.ok(isPlanToken(good));
  for (const bad of ['..', 'A23a/', 'A23a.', '', 'A'.repeat(13), 'a b']) {
    assert.ok(!isPlanToken(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }

  for (const good of ['1', '6', '12']) assert.ok(isSemesterToken(good));
  for (const bad of ['', '123', '6a', '-1']) {
    assert.ok(!isSemesterToken(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }
});
