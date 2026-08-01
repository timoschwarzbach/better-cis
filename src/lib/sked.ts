/**
 * Everything specific to sked campus, the timetable product NORDAKADEMIE runs.
 *
 * Two sources, deliberately:
 *
 *  - `<Zenturie>_<Semester>.ics` is the data. It is public, needs no
 *    authentication, and its DESCRIPTION field carries properly structured
 *    values that SUMMARY does not.
 *  - `<Zenturie>_<Semester>.html` is the annotation. sked marks events it has
 *    changed by emitting `#zf<id> { border: 2px solid red }` and listing them
 *    in a per-week table. The CIS homepage embed strips both, so this is
 *    information the site already has and simply does not show you.
 *
 * The two share an identity space: `.ics` UID `sked.de227350` is the same
 * event as HTML cell id `zf227350`.
 */

import type { CalEvent } from './types.js';
import type { ParsedEvent } from './ics.js';

/** Base path both files live under. */
const PLAN_BASE = 'https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene';

/** `sked.de227350` → `227350`, the number shared with the HTML's `zf227350`. */
const UID_PATTERN = /^sked\.de(\d+)$/;

/** Leading token of a Veranstaltung title, e.g. "V A113 Usability Engineering". */
const TITLE_PATTERN = /^(V|WP|Z|Vg|P|Ü|S)\s+(?:(WP|[A-Z]\d{3})\s+)?(.*)$/u;

export interface SkedEvent extends CalEvent {
  /** "V A113 Usability Engineering" — the DESCRIPTION `Veranstaltung` field. */
  title: string;
  /** Title with the type and module code stripped: "Usability Engineering". */
  shortTitle: string;
  /** V = Vorlesung, WP = Wahlpflicht, Z = Zenturienbetreuung, Vg = Vortrag. */
  kind: string;
  /** Module code such as `A113` or `I177`, when the title carries one. */
  moduleCode?: string;
  lecturer?: string;
  room?: string;
  /** DESCRIPTION `Anmerkung`, when it is not the placeholder "-". */
  note?: string;
  /** DESCRIPTION `Status`, e.g. "Onlinevorlesung". */
  status?: string;
  /** True when the room or status marks this as not physically on campus. */
  online: boolean;
  /** Numeric id shared with the HTML plan, for cross-referencing annotations. */
  skedId?: string;
  /** Distinguishes parallel sections of one course; absent when there is one. */
  section?: string;
}

/* ------------------------------------------------------------------ *
 * Feed locations
 * ------------------------------------------------------------------ */

export interface PlanRef {
  /** Study group, e.g. `A23a`. */
  zenturie: string;
  /** Semester number, e.g. `6`. */
  semester: string;
}

export function planUrls(ref: PlanRef): { ics: string; html: string } {
  const stem = `${PLAN_BASE}/${ref.zenturie}_${ref.semester}`;
  return { ics: `${stem}.ics`, html: `${stem}.html` };
}

/**
 * Recover the plan reference from any link to a plan file. The CIS pages link
 * to the HTML plan, which is how the extension discovers which group the
 * logged-in student belongs to without asking them.
 */
export function parsePlanRef(url: string): PlanRef | null {
  const m = /\/Stundenplaene\/([A-Za-z0-9]+)_([0-9]+)\.(?:html?|ics)(?:[?#]|$)/i.exec(url);
  return m ? { zenturie: m[1]!, semester: m[2]! } : null;
}

/* ------------------------------------------------------------------ *
 * DESCRIPTION parsing
 * ------------------------------------------------------------------ */

/**
 * sked writes DESCRIPTION as `Key: value` lines. Absent values are the literal
 * string "-", which must not be shown to the user as though it were content.
 */
export function parseDescription(description: string | undefined): Map<string, string> {
  const fields = new Map<string, string>();
  if (!description) return fields;

  for (const line of description.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || value === '' || value === '-') continue;
    fields.set(key, value);
  }
  return fields;
}

/** Split "V A113 Usability Engineering" into its parts. */
function splitTitle(title: string): { kind: string; moduleCode?: string; shortTitle: string } {
  const m = TITLE_PATTERN.exec(title.trim());
  if (!m) return { kind: '', shortTitle: title.trim() };

  const kind = m[1]!;
  const code = m[2];
  const rest = (m[3] ?? '').trim();

  // Electives are titled "WP WP Digital Commerce" — the type token is repeated
  // as the code, so treating it as a module code would be wrong.
  if (code && code !== 'WP') return { kind, moduleCode: code, shortTitle: rest };
  return { kind, shortTitle: rest };
}

/* ------------------------------------------------------------------ *
 * Enrichment and course identity
 * ------------------------------------------------------------------ */

/**
 * Turn raw parsed events into sked events with a course key.
 *
 * Course identity is the crux of this extension: a student sees 233 events but
 * attends about 81. Sixteen electives run in the same Monday-afternoon slot,
 * and Englisch runs as three simultaneous groups in different rooms.
 *
 * A course splits into selectable sections **only when its own occurrences
 * overlap in time** — that is what proves a student cannot attend all of them.
 * Grouping by lecturer instead would be wrong: "WP Internationale Beziehungen"
 * is taught by three different people on three different weeks, and
 * "V A118 Wiss.Arb.2" varies its lecturer list between occurrences. Neither is
 * a parallel section, and neither should be split.
 */
export function enrichEvents(events: ParsedEvent[]): SkedEvent[] {
  const enriched = events.map((event): SkedEvent => {
    const fields = parseDescription(event.description);
    const title = fields.get('Veranstaltung') ?? event.summary.split(',')[0]?.trim() ?? '';
    const { kind, moduleCode, shortTitle } = splitTitle(title);

    const room = fields.get('Raum') ?? event.location;
    const status = fields.get('Status');
    const note = fields.get('Anmerkung');

    const skedId = UID_PATTERN.exec(event.uid)?.[1];

    return {
      ...event,
      title,
      shortTitle,
      kind,
      ...(moduleCode ? { moduleCode } : {}),
      ...(fields.get('Dozent') ? { lecturer: fields.get('Dozent')! } : {}),
      ...(room ? { room } : {}),
      ...(note ? { note } : {}),
      ...(status ? { status } : {}),
      online: /online/i.test(`${room ?? ''} ${status ?? ''} ${note ?? ''}`),
      ...(skedId ? { skedId } : {}),
      // Replaced below, once sections are known.
      courseKey: title,
    };
  });

  return assignSections(enriched);
}

/** Do any two events in the list overlap in time? */
function hasOverlap(events: SkedEvent[]): boolean {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return true;
  }
  return false;
}

/**
 * Would partitioning by `discriminator` produce sections that are each
 * internally conflict-free? A discriminator that still leaves a student with
 * two simultaneous events has not actually identified the sections.
 */
function partitionsCleanly(events: SkedEvent[], discriminator: (e: SkedEvent) => string): boolean {
  const buckets = new Map<string, SkedEvent[]>();
  for (const event of events) {
    const key = discriminator(event);
    const list = buckets.get(key) ?? [];
    list.push(event);
    buckets.set(key, list);
  }
  if (buckets.size < 2) return false;
  for (const list of buckets.values()) if (hasOverlap(list)) return false;
  return true;
}

function assignSections(events: SkedEvent[]): SkedEvent[] {
  const byTitle = new Map<string, SkedEvent[]>();
  for (const event of events) {
    const list = byTitle.get(event.title) ?? [];
    list.push(event);
    byTitle.set(event.title, list);
  }

  const out: SkedEvent[] = [];
  for (const [title, list] of byTitle) {
    if (!hasOverlap(list)) {
      // One course, no parallel sections: every occurrence is the same entry.
      for (const event of list) out.push({ ...event, courseKey: title });
      continue;
    }

    // Try discriminators in order of how meaningful they are to a student.
    const candidates: { name: string; fn: (e: SkedEvent) => string }[] = [
      { name: 'lecturer', fn: (e) => e.lecturer ?? '' },
      { name: 'room', fn: (e) => e.room ?? '' },
      { name: 'lecturer+room', fn: (e) => `${e.lecturer ?? ''} · ${e.room ?? ''}` },
    ];
    const chosen = candidates.find((c) => partitionsCleanly(list, c.fn));

    if (!chosen) {
      // Nothing separates them cleanly. Splitting on a bad guess would hide
      // real classes, so keep them together and let the user see the clash.
      for (const event of list) out.push({ ...event, courseKey: title });
      continue;
    }

    for (const event of list) {
      const section = chosen.fn(event);
      out.push({ ...event, section, courseKey: `${title} ${section}` });
    }
  }

  out.sort((a, b) => a.start - b.start || a.uid.localeCompare(b.uid));
  return out;
}

/* ------------------------------------------------------------------ *
 * HTML plan annotations
 * ------------------------------------------------------------------ */

export interface PlanChangeNote {
  /** `Datum` column, as printed, e.g. "Mo, 27.07.26". */
  date: string;
  /** `Uhrzeit` column, e.g. "14:00 - 19:00 Uhr". */
  time: string;
  /** `Veranstaltung` column. */
  course: string;
  /** `Änderung` column, e.g. "[H] A103 ersetzt durch [H] A004 TI Labor." */
  change: string;
}

export interface PlanAnnotations {
  /** sked ids the plan marks with a red border, i.e. "this one changed". */
  markedIds: Set<string>;
  /** Rows from the per-week change tables. */
  notes: PlanChangeNote[];
  /** The plan's own "Stand: 31.07.2026, 12:31 Uhr" generation stamp. */
  generatedAt?: string;
}

/**
 * Extract sked's change annotations from the HTML plan using regular
 * expressions rather than DOMParser, which does not exist in a Chrome MV3
 * service worker. The targets are narrow and machine-generated, so this is not
 * the usual mistake of trying to parse arbitrary HTML.
 */
export function parsePlanAnnotations(html: string): PlanAnnotations {
  const markedIds = new Set<string>();

  // sked emits one <style> per week: `#zf227610,#zf227610 { border: 2px solid red; }`
  for (const block of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = block[1] ?? '';
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/border\s*:\s*[^;]*red/i.test(rule[2] ?? '')) continue;
      for (const id of (rule[1] ?? '').matchAll(/#zf(\d+)/g)) markedIds.add(id[1]!);
    }
  }

  const notes: PlanChangeNote[] = [];
  for (const table of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const body = table[0];
    if (!/Änderung/.test(body)) continue;

    for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...(row[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        stripTags(c[1] ?? ''),
      );
      if (cells.length < 4) continue;
      // Skip the header row, which repeats once per week.
      if (cells[0] === 'Datum') continue;
      if (!cells.some(Boolean)) continue;
      notes.push({
        date: cells[0]!,
        time: cells[1]!,
        course: cells[2]!,
        change: cells[3]!,
      });
    }
  }

  const generatedAt = /Stand:\s*([^<\n]{4,40}?)\s*(?:-->|<|$)/.exec(html)?.[1]?.trim();

  return { markedIds, notes, ...(generatedAt ? { generatedAt } : {}) };
}

/** Reduce a fragment of generated markup to its visible text. */
function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  szlig: 'ß',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    .replace(/ /g, ' ');
}

/**
 * Read a room substitution out of sked's change wording.
 *
 * The published form is "[H] A105 ersetzt durch [H] H007." — the bracketed
 * token is a site code that repeats on both sides and carries nothing for a
 * student deciding which door to walk through, so it is dropped. Anything not
 * matching this shape is left alone and shown verbatim.
 */
export function parseRoomSwap(note: string): { from: string; to: string } | null {
  const m = /^(?:\[[^\]]*\]\s*)?(.+?)\s+ersetzt\s+durch\s+(?:\[[^\]]*\]\s*)?(.+?)\.?$/u.exec(
    note.trim(),
  );
  if (!m) return null;
  const from = m[1]!.trim();
  const to = m[2]!.trim();
  return from && to ? { from, to } : null;
}

/**
 * Attach sked's annotations to the events they describe.
 *
 * Only the id match is trusted. The change-table rows are matched on printed
 * date and time, which is fuzzy enough that a wrong match is plausible, so a
 * note is only ever attached to an event whose id sked already flagged.
 */
export function applyAnnotations(
  events: SkedEvent[],
  annotations: PlanAnnotations,
): { events: SkedEvent[]; flagged: Map<string, PlanChangeNote | undefined> } {
  const flagged = new Map<string, PlanChangeNote | undefined>();

  for (const event of events) {
    if (!event.skedId || !annotations.markedIds.has(event.skedId)) continue;

    const startTime = new Date(event.start).toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
    const note = annotations.notes.find(
      (n) => n.course === event.title && n.time.startsWith(startTime),
    );
    flagged.set(event.uid, note);
  }

  return { events, flagged };
}
