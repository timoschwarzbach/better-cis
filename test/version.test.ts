/**
 * Version comparison decides whether a student is told to update, and the
 * release parser turns an untrusted API response into an href. Both are worth
 * pinning down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, isNewer, parseLatestRelease, shouldOfferUpdate } from '../src/lib/version.ts';

test('versions compare by numeric component, not as strings', () => {
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1);
  assert.equal(compareVersions('0.1.3', '0.1.2'), 1);
  assert.equal(compareVersions('0.1.2', '0.1.2'), 0);

  // The string comparison trap: "0.1.10" sorts before "0.1.9" alphabetically.
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);

  // Tags carry a leading v; the manifest version does not.
  assert.equal(compareVersions('v0.1.3', '0.1.3'), 0);

  // Missing components count as zero, so 0.1 and 0.1.0 are the same release.
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(compareVersions('0.1', '0.1.1'), -1);
});

test('only a strictly newer version prompts an update', () => {
  assert.equal(isNewer('0.1.3', '0.1.2'), true);
  assert.equal(isNewer('0.1.2', '0.1.2'), false);
  // A downgrade must never be offered — this happens when running a local
  // build ahead of the published release.
  assert.equal(isNewer('0.1.1', '0.1.2'), false);
});

test('the latest release is read out of the GitHub response', () => {
  const body = JSON.stringify({
    tag_name: 'v0.1.5',
    html_url: 'https://github.com/StaticFX/better-cis/releases/tag/v0.1.5',
    draft: false,
    prerelease: false,
  });

  assert.deepEqual(parseLatestRelease(body), {
    version: '0.1.5',
    url: 'https://github.com/StaticFX/better-cis/releases/tag/v0.1.5',
  });
});

test('a list of releases yields the newest usable one', () => {
  const body = JSON.stringify([
    { tag_name: 'v0.2.0', html_url: 'https://github.com/o/r/releases/tag/v0.2.0', draft: true },
    {
      tag_name: 'v0.1.9',
      html_url: 'https://github.com/o/r/releases/tag/v0.1.9',
      prerelease: true,
    },
    { tag_name: 'v0.1.4', html_url: 'https://github.com/o/r/releases/tag/v0.1.4' },
    { tag_name: 'v0.1.7', html_url: 'https://github.com/o/r/releases/tag/v0.1.7' },
  ]);

  // Drafts and prereleases are not something to send a student to, and 0.1.7
  // beats 0.1.4 despite coming later in the array.
  assert.deepEqual(parseLatestRelease(body)?.version, '0.1.7');
});

test('a malformed or hostile feed yields null rather than throwing', () => {
  for (const body of [
    'not json',
    '{}',
    '[]',
    JSON.stringify({ tag_name: 'v1.0.0' }), // no url
    JSON.stringify({ html_url: 'https://github.com/o/r' }), // no tag
    JSON.stringify({ tag_name: 'nightly', html_url: 'https://github.com/o/r' }),
    // The url becomes an href, so anything not on github.com is refused.
    JSON.stringify({ tag_name: 'v1.0.0', html_url: 'https://evil.example/x' }),
    JSON.stringify({ tag_name: 'v1.0.0', html_url: 'javascript:alert(1)' }),
  ]) {
    assert.equal(parseLatestRelease(body), null, `expected null for ${body}`);
  }
});

test('"Später" hides one version; "Nie wieder" hides them all', () => {
  const available = { version: '0.1.5' };

  // Fresh install: shown.
  assert.equal(
    shouldOfferUpdate({ available, updateChecks: true, dismissedUpdate: null }),
    true,
  );

  // "Später" dismissed exactly this version.
  assert.equal(
    shouldOfferUpdate({ available, updateChecks: true, dismissedUpdate: '0.1.5' }),
    false,
  );

  // ...and the next release speaks up again. That is the whole difference
  // between the two buttons.
  assert.equal(
    shouldOfferUpdate({
      available: { version: '0.1.6' },
      updateChecks: true,
      dismissedUpdate: '0.1.5',
    }),
    true,
  );

  // "Nie wieder" wins regardless of version.
  assert.equal(
    shouldOfferUpdate({ available, updateChecks: false, dismissedUpdate: null }),
    false,
  );
  assert.equal(
    shouldOfferUpdate({
      available: { version: '99.0.0' },
      updateChecks: false,
      dismissedUpdate: null,
    }),
    false,
  );

  // Nothing to offer.
  assert.equal(
    shouldOfferUpdate({ available: null, updateChecks: true, dismissedUpdate: null }),
    false,
  );
});
