/**
 * Version comparison and release-feed parsing.
 *
 * The extension is installed from a GitHub release rather than a store, so
 * nothing updates it automatically — which is why it has to say when a newer
 * build exists. A bugfix that ships to nobody is not a fix.
 *
 * Pure and dependency-free, so the comparison is testable without a network.
 */

export interface Release {
  /** Normalised, without the tag's leading `v`. */
  version: string;
  /** Where a human goes to read what changed and download it. */
  url: string;
}

/**
 * Compare two dotted version strings, returning the usual -1 / 0 / 1.
 *
 * Only the numeric components are compared. Tags are produced by
 * `npm version patch` in CI, so they are always `vX.Y.Z`; anything else sorts
 * by whatever leading number it carries rather than throwing.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((piece) => {
        const n = Number.parseInt(piece, 10);
        return Number.isNaN(n) ? 0 : n;
      });

  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Is `candidate` a version worth telling someone about? */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Whether the update banner belongs on screen.
 *
 * The two ways to dismiss it are deliberately different, and the difference is
 * the whole point: "Später" hides one version and a later one speaks up again,
 * "Nie wieder" stops the checking itself. Kept out of the view so the
 * distinction can be tested without a DOM.
 */
export function shouldOfferUpdate(state: {
  available: { version: string } | null | undefined;
  updateChecks: boolean;
  dismissedUpdate: string | null;
}): boolean {
  if (!state.available || !state.updateChecks) return false;
  return state.dismissedUpdate !== state.available.version;
}

/**
 * Read the newest usable release out of a GitHub API response.
 *
 * Accepts either the single object from `/releases/latest` or the array from
 * `/releases`, since the two differ only in shape. Drafts and prereleases are
 * skipped: neither is something to send a student to.
 *
 * Returns null rather than throwing — a release feed that has changed shape
 * must not be able to break a timetable.
 */
export function parseLatestRelease(body: string): Release | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const releases: Release[] = [];

  for (const entry of candidates) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record['draft'] === true || record['prerelease'] === true) continue;

    const tag = record['tag_name'];
    const url = record['html_url'];
    if (typeof tag !== 'string' || typeof url !== 'string') continue;

    const version = tag.trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(version)) continue;
    // Only ever point at GitHub: this string ends up in an href.
    if (!/^https:\/\/github\.com\//i.test(url)) continue;

    releases.push({ version, url });
  }

  if (releases.length === 0) return null;
  return releases.sort((a, b) => compareVersions(b.version, a.version))[0]!;
}
