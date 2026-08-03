/**
 * The request handler behind the subscription links, kept free of any
 * Cloudflare-specific API so it can be exercised directly under `node --test`
 * with a stub fetch. Everything platform-shaped — the edge cache, the `cf`
 * fetch options — lives in `index.ts`.
 *
 * The pipeline is deliberately the same one the extension runs:
 *
 *     parseIcs → enrichEvents → filterSelected → writeIcs
 *
 * That is not code reuse for its own sake. `courseKey` is derived, not read
 * from the feed — a course splits into sections based on which of its own
 * occurrences overlap — so the only way the keys in a link can still mean
 * something here is to run the identical derivation.
 */

import { selectionFromUrl, isPlanToken, isSemesterToken } from '../../src/lib/ical-link.js';
import { filterSelected } from '../../src/lib/courses.js';
import { parseIcs } from '../../src/lib/ics.js';
import { writeIcs } from '../../src/lib/ics-write.js';
import {
  applyAnnotations,
  enrichEvents,
  parsePlanAnnotations,
  planUrls,
  type PlanRef,
} from '../../src/lib/sked.js';

export interface HandlerDeps {
  /**
   * Fetches an upstream plan file. Supplied by the caller so the edge cache and
   * its TTL stay out of here, and so tests can serve a fixture.
   */
  fetchUpstream(url: string): Promise<Response>;
}

/** IANA zone for the floating times in the plan; the feed is a German campus. */
const PLAN_TIME_ZONE = 'Europe/Berlin';

/** How long a calendar client should wait before polling again. */
const REFRESH_MINUTES = 60;

/** `/A23a_6.ics` */
const PLAN_PATH = /^\/([A-Za-z0-9]{1,12})_([0-9]{1,2})\.ics$/;

export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Nur GET.\n', 405, { Allow: 'GET, HEAD' });
  }

  const url = new URL(request.url);

  if (url.pathname === '/' || url.pathname === '') return text(usage(url), 200);

  const match = PLAN_PATH.exec(url.pathname);
  if (!match) return text('Nicht gefunden.\n\n' + usage(url), 404);

  const ref: PlanRef = { zenturie: match[1]!, semester: match[2]! };

  // The path regex already constrains these, but `planUrls` interpolates into a
  // URL and this is a public endpoint: check against the shared allowlist too,
  // so the guarantee does not rest on one regex staying correct.
  if (!isPlanToken(ref.zenturie) || !isSemesterToken(ref.semester)) {
    return text('Ungültiger Plan.\n', 400);
  }

  const selection = await selectionFromUrl(url);
  if (selection === 'invalid') {
    return text('Die Kursauswahl im Link ist unlesbar.\n', 400);
  }

  const upstream = planUrls(ref);

  let icsText: string;
  let lastModified: number | null;
  try {
    const response = await deps.fetchUpstream(upstream.ics);
    if (response.status === 404) {
      return text(`Für ${ref.zenturie} im ${ref.semester}. Semester gibt es keinen Plan.\n`, 404);
    }
    if (!response.ok) return text('Der Plan ist gerade nicht abrufbar.\n', 502);

    // `text()` always decodes UTF-8 regardless of the declared charset, which
    // is what silently fixes the feed's incorrect ISO-8859-15 header.
    icsText = await response.text();
    lastModified = parseHttpDate(response.headers.get('Last-Modified'));
  } catch {
    return text('Der Plan ist gerade nicht abrufbar.\n', 502);
  }

  if (!/BEGIN:VCALENDAR/i.test(icsText)) {
    return text('Der Plan kam in einem unerwarteten Format.\n', 502);
  }

  const parsed = parseIcs(icsText, { defaultTimeZone: PLAN_TIME_ZONE });
  const enriched = enrichEvents(parsed.events);
  const events = filterSelected(enriched, selection);

  // sked publishes its own wording for changed events in the HTML plan only.
  // Best-effort, exactly as in the extension's background sync: a student would
  // rather have a calendar without change notes than no calendar.
  const notes =
    url.searchParams.get('notes') === '0'
      ? undefined
      : await fetchNotes(deps, upstream.html, enriched);

  const body = writeIcs(events, {
    calendarName: calendarName(parsed.calendarName, ref, selection),
    // Not `Date.now()`: identical input has to produce identical bytes, or the
    // ETag changes on every poll and clients re-import the whole term.
    dtstamp: lastModified ?? feedStamp(icsText) ?? 0,
    refreshMinutes: REFRESH_MINUTES,
    ...(notes ? { notes } : {}),
  });

  const etag = `W/"${hash(body)}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: calendarHeaders(etag) });
  }

  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: calendarHeaders(etag),
  });
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

async function fetchNotes(
  deps: HandlerDeps,
  htmlUrl: string,
  events: ReturnType<typeof enrichEvents>,
): Promise<Map<string, string> | undefined> {
  try {
    const response = await deps.fetchUpstream(htmlUrl);
    if (!response.ok) return undefined;

    const annotations = parsePlanAnnotations(await response.text());
    const { flagged } = applyAnnotations(events, annotations);

    const notes = new Map<string, string>();
    for (const [uid, note] of flagged) {
      if (note?.change) notes.set(uid, note.change);
    }
    return notes.size > 0 ? notes : undefined;
  } catch {
    return undefined;
  }
}

function calendarName(
  feedName: string | undefined,
  ref: PlanRef,
  selection: string[] | null,
): string {
  const base = feedName?.trim() || `${ref.zenturie} · ${ref.semester}. Semester`;
  return selection ? `${base} (meine Kurse)` : base;
}

function calendarHeaders(etag: string): Record<string, string> {
  return {
    'Content-Type': 'text/calendar; charset=utf-8',
    // Long enough that many subscribers do not become many requests to CIS,
    // short enough that a room change lands the same morning.
    'Cache-Control': 'public, max-age=900',
    ETag: etag,
    // The plan is public, and this lets browser-based calendar tools read it.
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  };
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    },
  });
}

function usage(url: URL): string {
  return [
    'better-cis — gefilterte Stundenplan-Abos',
    '',
    `  ${url.origin}/<Zenturie>_<Semester>.ics`,
    '',
    'Beispiele:',
    `  ${url.origin}/A23a_6.ics                     ganzer Plan`,
    `  ${url.origin}/A23a_6.ics?course=<Kurs>       einzelne Kurse, wiederholbar`,
    `  ${url.origin}/A23a_6.ics?c=<Auswahl>         kompakte Auswahl aus der Extension`,
    '',
    'Parameter: notes=0 schaltet die Änderungshinweise aus.',
    '',
    'Die Daten stammen unverändert von cis.nordakademie.de.',
    '',
  ].join('\n');
}

/**
 * Fallback generation stamp, read from the feed itself.
 *
 * sked writes the same DTSTAMP on every event, so the first one is the moment
 * the plan was generated — a stable value to fall back on when the origin sends
 * no Last-Modified.
 */
function feedStamp(icsText: string): number | null {
  const m = /^DTSTAMP:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/m.exec(icsText);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function parseHttpDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A hash of the body, for the ETag. Not a checksum anyone relies on for
 * integrity — it only has to change whenever the calendar does.
 *
 * Two FNV-1a passes from different offset bases rather than one: a single
 * 32-bit value collides often enough to be worth avoiding, and a collision
 * against the immediately preceding version would serve a stale timetable
 * until the next change.
 */
function hash(body: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}-${body.length.toString(36)}`;
}
