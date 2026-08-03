/**
 * The counterpart to the reader in `ics.ts`: turns sked events back into an
 * iCalendar file a phone calendar can subscribe to.
 *
 * This exists because the upstream feed is subscribable but not usable. Its
 * SUMMARY is four values comma-jammed into one line ("WP WP Strat.
 * Marketing-Projekt,Prof. Dr. rer. pol. Kortmann,inkl. 30 min Pause,H008"),
 * which is what every calendar app then shows on every entry. Everything worth
 * reading is in DESCRIPTION, already parsed by `enrichEvents`, so re-emitting
 * from `SkedEvent` costs little and fixes the display.
 *
 * Times are written as UTC instants. `SkedEvent.start`/`end` are epoch
 * milliseconds, so there is nothing to convert and no VTIMEZONE block to get
 * wrong — the DST correctness already lives in the reader's `zonedToUtc`.
 */

import { KIND_LABELS } from './courses.js';
import { parseDescription, parseRoomSwap, type SkedEvent } from './sked.js';

export interface WriteOptions {
  /** NAME/X-WR-CALNAME, i.e. what the calendar app labels the subscription. */
  calendarName: string;
  /**
   * Value for DTSTAMP, as epoch milliseconds.
   *
   * Deliberately an input rather than `Date.now()`: identical events must
   * produce identical bytes, or every poll looks like a change and the ETag
   * never matches. Pass the upstream feed's Last-Modified.
   */
  dtstamp: number;
  productId?: string;
  /** Advertised polling interval, in minutes. */
  refreshMinutes?: number;
  /** Keep cancelled events as STATUS:CANCELLED rather than dropping them. */
  includeCancelled?: boolean;
  /**
   * sked's own wording for events it has changed ("A105 ersetzt durch H007"),
   * keyed by event uid. Read out of the HTML plan, which the ICS feed does not
   * carry, so it has to be supplied from outside.
   */
  notes?: ReadonlyMap<string, string>;
}

const DEFAULT_PRODUCT_ID = '-//better-cis//iCal//DE';

/** RFC 5545 caps a content line at 75 octets, excluding the line break. */
const MAX_LINE_OCTETS = 75;

/**
 * Control characters, which RFC 5545 cannot represent in a TEXT value. CR and
 * LF are excluded on purpose: they are folded into the `\n` escape instead.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function writeIcs(events: SkedEvent[], options: WriteOptions): string {
  const {
    calendarName,
    dtstamp,
    productId = DEFAULT_PRODUCT_ID,
    refreshMinutes = 60,
    includeCancelled = true,
    notes,
  } = options;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(productId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeText(calendarName)}`,
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-PUBLISHED-TTL:PT${refreshMinutes}M`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshMinutes}M`,
  ];

  const stamp = utcDateTime(dtstamp);

  for (const event of events) {
    if (event.cancelled && !includeCancelled) continue;
    lines.push(...eventLines(event, stamp, notes?.get(event.uid)));
  }

  lines.push('END:VCALENDAR');

  // A trailing CRLF: the last line is a content line like any other, and some
  // parsers drop a final line that is not terminated.
  return lines.map(fold).join('\r\n') + '\r\n';
}

function eventLines(event: SkedEvent, stamp: string, officialNote: string | undefined): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uidFor(event)}`,
    `DTSTAMP:${stamp}`,
    ...dateLine('DTSTART', event.start, event.allDay),
    ...dateLine('DTEND', event.end, event.allDay),
    `SUMMARY:${escapeText(summaryFor(event))}`,
  ];

  if (event.room) lines.push(`LOCATION:${escapeText(event.room)}`);

  const description = descriptionFor(event, officialNote);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);

  lines.push(
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'SEQUENCE:0',
    'END:VEVENT',
  );
  return lines;
}

/**
 * A stable identity for the exported occurrence.
 *
 * Suffixed rather than passed through, so that a student subscribed to both
 * this feed and the raw one does not have two calendars fighting over the same
 * UID. Stable across regenerations, so clients update events instead of
 * accumulating duplicates.
 */
function uidFor(event: SkedEvent): string {
  const base = event.recurrenceId ? `${event.uid}-${event.recurrenceId}` : event.uid;
  return `${base.replace(/[^\w.@:+-]/g, '_')}@better-cis`;
}

/**
 * What the calendar app puts on the entry.
 *
 * The type is spelled out rather than left as sked's letter code: outside this
 * extension there is no legend, and "Übung" next to "Vorlesung" of the same
 * module is the difference the student is actually looking for.
 */
function summaryFor(event: SkedEvent): string {
  const title = event.shortTitle || event.title || 'Termin';
  const label = KIND_LABELS[event.kind];
  return label ? `${title} (${label})` : title;
}

function descriptionFor(event: SkedEvent, officialNote: string | undefined): string {
  const lines: string[] = [];

  if (event.lecturer) lines.push(`Dozent: ${event.lecturer}`);
  if (event.moduleCode) lines.push(`Modul: ${event.moduleCode}`);
  if (event.room) lines.push(`Raum: ${event.room}`);

  // Not carried on SkedEvent, but the raw DESCRIPTION is — and "inkl. 30 min
  // Pause" changes when a five-hour block actually ends.
  const pause = parseDescription(event.description).get('Pause');
  if (pause) lines.push(pause);

  if (event.status) lines.push(`Status: ${event.status}`);

  for (const note of [event.note, officialNote]) {
    if (!note) continue;
    const swap = parseRoomSwap(note);
    lines.push(swap ? `Raumwechsel: ${swap.from} → ${swap.to}` : note);
  }

  // Distinct lines only: sked frequently publishes the same wording in both the
  // event's Anmerkung and the week's change table.
  return [...new Set(lines)].join('\n');
}

/* ------------------------------------------------------------------ *
 * Value formatting
 * ------------------------------------------------------------------ */

function dateLine(name: string, ms: number, allDay: boolean): string[] {
  if (!Number.isFinite(ms)) return [];
  return allDay ? [`${name};VALUE=DATE:${utcDate(ms)}`] : [`${name}:${utcDateTime(ms)}`];
}

/** `20260727T120000Z` */
function utcDateTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** `20260727` — the reader anchors all-day events to UTC midnight, so this round-trips. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Escape a TEXT value. Backslash first, or the escapes added below would
 * themselves be escaped a second time.
 *
 * Control characters are stripped rather than escaped: RFC 5545 has no
 * representation for them, and a stray one would end the line early.
 */
function escapeText(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|[\r\n]/g, '\\n');
}

/**
 * Fold a content line to 75 **octets**, continuing with a leading space.
 *
 * Octets, not characters: course titles carry "Ü" (2 bytes) and change notes
 * carry "→" (3 bytes). Folding on `String.length` would both overshoot the
 * limit and risk splitting a surrogate pair.
 */
function fold(line: string): string {
  // Fast path only when every character is one octet, so a line of umlauts
  // cannot slip through under the character count.
  if (line.length <= MAX_LINE_OCTETS && !NON_ASCII.test(line)) return line;

  const chunks: string[] = [];
  let current = '';
  let octets = 0;

  for (const char of line) {
    const size = utf8Length(char);
    if (octets + size > MAX_LINE_OCTETS) {
      chunks.push(current);
      current = '';
      // The continuation's leading space is itself part of the octet budget.
      octets = 1;
    }
    current += char;
    octets += size;
  }
  chunks.push(current);

  return chunks.join('\r\n ');
}

const NON_ASCII = /[^\u0000-\u007F]/;

/** Byte length of one code point in UTF-8. `for…of` yields whole code points. */
function utf8Length(char: string): number {
  const code = char.codePointAt(0)!;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}
