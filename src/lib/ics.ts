/**
 * A small, dependency-free iCalendar (RFC 5545) reader, scoped to what campus
 * timetable feeds actually emit: VEVENTs, TZID-qualified local times, weekly
 * recurrence with exceptions, and per-occurrence overrides.
 *
 * It deliberately does not aim to be a general iCalendar implementation.
 * Anything it cannot interpret is skipped rather than guessed at, and the
 * reasons land in `ParseResult.warnings` so a feed that changes shape shows up
 * as a visible warning instead of silently missing classes.
 */

import type { CalEvent } from './types.js';

export type ParsedEvent = Omit<CalEvent, 'courseKey'>;

export interface ParseResult {
  events: ParsedEvent[];
  /** Calendar-level NAME/X-WR-CALNAME, if the feed provides one. */
  calendarName?: string;
  warnings: string[];
}

export interface ParseOptions {
  /**
   * Time zone assumed for date-times that carry neither a TZID nor a `Z`
   * suffix ("floating" times). RFC 5545 says to interpret those in the
   * viewer's local zone, which is the sane default for a timetable.
   */
  defaultTimeZone?: string;
  /**
   * Recurring series are expanded up to this many milliseconds past the last
   * DTSTART, bounded further by UNTIL/COUNT. Two years covers a degree
   * programme's worth of feed without letting an unbounded RRULE run away.
   */
  expandHorizonMs?: number;
  /** Hard ceiling on occurrences generated per series. */
  maxOccurrencesPerSeries?: number;
}

interface ContentLine {
  name: string;
  params: Map<string, string>;
  value: string;
}

interface DateValue {
  /** Epoch milliseconds. */
  ms: number;
  allDay: boolean;
  /** Wall-clock components, retained so recurrence can step in local time. */
  local: LocalTime;
  timeZone: string | null;
}

interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DEFAULT_HORIZON_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OCCURRENCES = 800;

/** Weekday codes in RFC 5545 order, indexed to match `Date.getUTCDay()`. */
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export function parseIcs(text: string, options: ParseOptions = {}): ParseResult {
  const defaultZone =
    options.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const horizon = options.expandHorizonMs ?? DEFAULT_HORIZON_MS;
  const maxOccurrences = options.maxOccurrencesPerSeries ?? DEFAULT_MAX_OCCURRENCES;
  const warnings: string[] = [];

  const lines = unfold(text);
  let calendarName: string | undefined;

  // Collect VEVENT blocks. Nested components (VALARM) are skipped wholesale so
  // their DTSTART/TRIGGER lines cannot be mistaken for the event's own.
  const blocks: ContentLine[][] = [];
  let current: ContentLine[] | null = null;
  let nestedDepth = 0;

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === 'BEGIN') {
      const component = line.value.toUpperCase();
      if (component === 'VEVENT' && current === null) {
        current = [];
        continue;
      }
      if (current !== null) nestedDepth++;
      continue;
    }

    if (line.name === 'END') {
      const component = line.value.toUpperCase();
      if (component === 'VEVENT' && current !== null && nestedDepth === 0) {
        blocks.push(current);
        current = null;
        continue;
      }
      if (current !== null && nestedDepth > 0) nestedDepth--;
      continue;
    }

    if (current !== null) {
      if (nestedDepth === 0) current.push(line);
      continue;
    }

    if (line.name === 'X-WR-CALNAME' || line.name === 'NAME') {
      calendarName ??= unescapeText(line.value);
    }
  }

  if (current !== null) warnings.push('Feed ended inside a VEVENT; last event dropped.');

  // Split into base events and per-occurrence overrides (RECURRENCE-ID), so an
  // override can replace the occurrence its series would have generated.
  const bases: ParsedEvent[] = [];
  const overrides = new Map<string, ParsedEvent[]>();
  const seriesRules: { event: ParsedEvent; block: ContentLine[]; base: DateValue }[] = [];

  for (const block of blocks) {
    const built = buildEvent(block, defaultZone, warnings);
    if (!built) continue;
    const { event, dtstart, rrule, recurrenceId } = built;

    if (recurrenceId) {
      const list = overrides.get(event.uid) ?? [];
      list.push(event);
      overrides.set(event.uid, list);
      continue;
    }

    if (rrule) {
      seriesRules.push({ event, block, base: dtstart });
    } else {
      bases.push(event);
    }
  }

  const events: ParsedEvent[] = [...bases];

  for (const series of seriesRules) {
    const expanded = expandSeries(series.block, series.event, series.base, defaultZone, {
      horizon,
      maxOccurrences,
      warnings,
    });
    events.push(...expanded);
  }

  // Apply overrides: an override wins over any generated occurrence sharing its
  // UID and RECURRENCE-ID. Overrides with no matching occurrence are still kept,
  // since they represent a session that was moved into a new slot.
  for (const [uid, list] of overrides) {
    for (const override of list) {
      const idx = events.findIndex(
        (e) => e.uid === uid && e.recurrenceId === override.recurrenceId,
      );
      if (idx >= 0) events[idx] = override;
      else events.push(override);
    }
  }

  events.sort((a, b) => a.start - b.start || a.uid.localeCompare(b.uid));
  return { events, calendarName, warnings };
}

/* ------------------------------------------------------------------ *
 * Lexing
 * ------------------------------------------------------------------ */

/**
 * Undo RFC 5545 line folding. A continuation line begins with a single space
 * or tab, which is removed along with the preceding line break.
 */
function unfold(text: string): string[] {
  const out: string[] = [];
  // Normalise line endings first; feeds in the wild mix CRLF, LF, and CR.
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Split `NAME;PARAM=value:content` into its parts. Parameter values may be
 * double-quoted, and a quoted value may legally contain a colon — so the
 * name/value split cannot be a naive `indexOf(':')`.
 */
function parseLine(raw: string): ContentLine | null {
  if (raw.trim() === '') return null;

  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;

  const head = raw.slice(0, colon);
  const value = raw.slice(colon + 1);

  const parts = splitUnquoted(head, ';');
  const name = (parts[0] ?? '').toUpperCase().trim();
  if (!name) return null;

  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i]!;
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const key = param.slice(0, eq).toUpperCase().trim();
    let val = param.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    params.set(key, val);
  }

  return { name, params, value };
}

function splitUnquoted(input: string, separator: string): string[] {
  const out: string[] = [];
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === separator && !inQuotes) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

/** Reverse the TEXT escaping rules: `\\`, `\;`, `\,`, and `\n`/`\N`. */
function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++i];
    if (next === undefined) break;
    if (next === 'n' || next === 'N') out += '\n';
    else out += next; // covers \\ , \; , \, and any stray escape
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Dates and time zones
 * ------------------------------------------------------------------ */

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds
 * (positive east of Greenwich). Derived from Intl rather than a bundled tz
 * database, so it stays correct as the browser's zone data is updated.
 */
function zoneOffsetAt(utcMs: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24, // hourCycle h23 still yields 24 for midnight in some engines
    get('minute'),
    get('second'),
  );
  return asIfUtc - utcMs;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Convert wall-clock components in `timeZone` to a UTC instant.
 *
 * The offset depends on the instant we are solving for, so this guesses using
 * the offset at the naive UTC reading, then re-checks. The second pass matters
 * on DST boundaries: a 02:30 wall time on a spring-forward day would otherwise
 * land an hour off.
 */
function zonedToUtc(local: LocalTime, timeZone: string): number {
  const naive = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const firstGuess = naive - zoneOffsetAt(naive, timeZone);
  const refinedOffset = zoneOffsetAt(firstGuess, timeZone);
  return naive - refinedOffset;
}

/** Parse DATE (`YYYYMMDD`) or DATE-TIME (`YYYYMMDDTHHMMSS[Z]`). */
function parseDateValue(
  line: ContentLine,
  defaultZone: string,
  warnings: string[],
): DateValue | null {
  const value = line.value.trim();
  const tzid = line.params.get('TZID') ?? null;
  const isDateOnly = line.params.get('VALUE')?.toUpperCase() === 'DATE' || /^\d{8}$/.test(value);

  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) {
      warnings.push(`Unparseable date "${value}" on ${line.name}.`);
      return null;
    }
    const local: LocalTime = {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
    // All-day events are zone-independent by definition; anchoring them to UTC
    // midnight keeps the calendar grid from shifting them into the day before.
    return {
      ms: Date.UTC(local.year, local.month - 1, local.day),
      allDay: true,
      local,
      timeZone: null,
    };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) {
    warnings.push(`Unparseable date-time "${value}" on ${line.name}.`);
    return null;
  }

  const local: LocalTime = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  const isUtc = m[7] === 'Z';
  const zone = isUtc ? 'UTC' : (tzid ?? defaultZone);

  let ms: number;
  if (isUtc) {
    ms = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  } else {
    try {
      ms = zonedToUtc(local, zone);
    } catch {
      // An unknown TZID (some systems emit proprietary zone names) would
      // otherwise throw out of Intl and lose the whole event.
      warnings.push(`Unknown time zone "${zone}"; treating as ${defaultZone}.`);
      ms = zonedToUtc(local, defaultZone);
    }
  }

  return { ms, allDay: false, local, timeZone: zone };
}

/** Parse a DURATION value (e.g. `PT1H30M`) into milliseconds. */
function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const [weeks, days, hours, minutes, seconds] = [m[2], m[3], m[4], m[5], m[6]].map((v) =>
    v ? Number(v) : 0,
  );
  const total =
    (weeks! * 7 + days!) * 86400000 + hours! * 3600000 + minutes! * 60000 + seconds! * 1000;
  return sign * total;
}

/* ------------------------------------------------------------------ *
 * Event construction
 * ------------------------------------------------------------------ */

interface BuiltEvent {
  event: ParsedEvent;
  dtstart: DateValue;
  rrule?: string;
  recurrenceId?: string;
}

function buildEvent(
  block: ContentLine[],
  defaultZone: string,
  warnings: string[],
): BuiltEvent | null {
  const first = (name: string) => block.find((l) => l.name === name);

  const dtstartLine = first('DTSTART');
  if (!dtstartLine) {
    warnings.push('Skipped a VEVENT with no DTSTART.');
    return null;
  }
  const dtstart = parseDateValue(dtstartLine, defaultZone, warnings);
  if (!dtstart) return null;

  let end: number;
  const dtendLine = first('DTEND');
  const durationLine = first('DURATION');
  if (dtendLine) {
    const parsed = parseDateValue(dtendLine, defaultZone, warnings);
    end = parsed ? parsed.ms : dtstart.ms;
  } else if (durationLine) {
    const dur = parseDuration(durationLine.value);
    end = dtstart.ms + (dur ?? 0);
  } else {
    // RFC 5545: no DTEND means a date-only event lasts one day, and a
    // date-time event has zero duration.
    end = dtstart.allDay ? dtstart.ms + 86400000 : dtstart.ms;
  }

  const uid = first('UID')?.value.trim();
  if (!uid) {
    warnings.push('Skipped a VEVENT with no UID.');
    return null;
  }

  const recurrenceIdLine = first('RECURRENCE-ID');
  let recurrenceId: string | undefined;
  if (recurrenceIdLine) {
    const parsed = parseDateValue(recurrenceIdLine, defaultZone, warnings);
    if (parsed) recurrenceId = new Date(parsed.ms).toISOString();
  }

  const status = first('STATUS')?.value.trim().toUpperCase();

  const event: ParsedEvent = {
    uid,
    ...(recurrenceId ? { recurrenceId } : {}),
    start: dtstart.ms,
    end,
    allDay: dtstart.allDay,
    summary: unescapeText(first('SUMMARY')?.value ?? '').trim(),
    cancelled: status === 'CANCELLED',
  };

  const location = unescapeText(first('LOCATION')?.value ?? '').trim();
  if (location) event.location = location;

  const description = unescapeText(first('DESCRIPTION')?.value ?? '').trim();
  if (description) event.description = description;

  const built: BuiltEvent = { event, dtstart };
  const rrule = first('RRULE')?.value;
  if (rrule) built.rrule = rrule;
  if (recurrenceId) built.recurrenceId = recurrenceId;
  return built;
}

/* ------------------------------------------------------------------ *
 * Recurrence
 * ------------------------------------------------------------------ */

interface ExpandContext {
  horizon: number;
  maxOccurrences: number;
  warnings: string[];
}

function expandSeries(
  block: ContentLine[],
  template: ParsedEvent,
  dtstart: DateValue,
  defaultZone: string,
  ctx: ExpandContext,
): ParsedEvent[] {
  const rruleLine = block.find((l) => l.name === 'RRULE');
  if (!rruleLine) return [template];

  const rule = new Map<string, string>();
  for (const part of rruleLine.value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) rule.set(part.slice(0, eq).toUpperCase().trim(), part.slice(eq + 1).trim());
  }

  const freq = rule.get('FREQ')?.toUpperCase();
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    ctx.warnings.push(`Unsupported RRULE FREQ "${freq ?? 'missing'}"; kept only the first date.`);
    return [template];
  }

  const interval = Math.max(1, Number(rule.get('INTERVAL') ?? '1') || 1);
  const count = rule.has('COUNT') ? Number(rule.get('COUNT')) : null;
  const duration = template.end - template.start;
  const zone = dtstart.timeZone ?? defaultZone;

  let until: number | null = null;
  const untilRaw = rule.get('UNTIL');
  if (untilRaw) {
    const parsed = parseDateValue({ name: 'UNTIL', params: new Map(), value: untilRaw }, zone, ctx.warnings);
    if (parsed) until = parsed.ms;
  }

  // EXDATE may appear several times and hold comma-separated lists.
  const excluded = new Set<number>();
  for (const line of block) {
    if (line.name !== 'EXDATE') continue;
    for (const piece of line.value.split(',')) {
      const parsed = parseDateValue(
        { name: 'EXDATE', params: line.params, value: piece },
        defaultZone,
        ctx.warnings,
      );
      if (parsed) excluded.add(parsed.ms);
    }
  }

  const byDay = (rule.get('BYDAY') ?? '')
    .split(',')
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);
  const byMonthDay = (rule.get('BYMONTHDAY') ?? '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);

  const horizonEnd = dtstart.ms + ctx.horizon;
  const starts: number[] = [];

  const emit = (ms: number) => {
    if (until !== null && ms > until) return false;
    if (ms > horizonEnd) return false;
    if (!excluded.has(ms)) starts.push(ms);
    return !(count !== null && starts.length >= count);
  };

  if (freq === 'WEEKLY') {
    // Days of the week the series lands on; absent BYDAY, it repeats on the
    // same weekday as DTSTART.
    const dowOffsets =
      byDay.length > 0
        ? byDay
            .map((d) => WEEKDAYS.indexOf(d.slice(-2) as (typeof WEEKDAYS)[number]))
            .filter((i) => i >= 0)
        : [new Date(dtstart.ms).getUTCDay()];

    // Anchor to the Monday of DTSTART's week in *local* terms, then step by
    // whole weeks so DST transitions never drift the wall-clock time.
    const anchor = { ...dtstart.local };
    const anchorDow = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day)).getUTCDay();
    const mondayShift = (anchorDow + 6) % 7;

    outer: for (let week = 0; ; week += interval) {
      const weekStartUtc = Date.UTC(anchor.year, anchor.month - 1, anchor.day - mondayShift + week * 7);
      if (weekStartUtc > horizonEnd + 7 * 86400000) break;

      for (const dow of [...dowOffsets].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
        const dayShift = (dow + 6) % 7;
        const dayUtc = weekStartUtc + dayShift * 86400000;
        const d = new Date(dayUtc);
        const ms = zonedToUtc(
          {
            year: d.getUTCFullYear(),
            month: d.getUTCMonth() + 1,
            day: d.getUTCDate(),
            hour: dtstart.local.hour,
            minute: dtstart.local.minute,
            second: dtstart.local.second,
          },
          zone,
        );
        if (ms < dtstart.ms) continue;
        if (!emit(ms)) break outer;
      }
      if (starts.length > ctx.maxOccurrences) break;
    }
  } else if (freq === 'DAILY') {
    for (let i = 0; starts.length <= ctx.maxOccurrences; i += interval) {
      const ms = shiftLocal(dtstart.local, zone, { days: i });
      if (ms > horizonEnd) break;
      if (!emit(ms)) break;
    }
  } else {
    // MONTHLY / YEARLY. Timetables use these for exams and one-off block
    // sessions, where BYMONTHDAY or a plain "same date each month" is the norm.
    const stepMonths = freq === 'YEARLY' ? 12 * interval : interval;
    const days = byMonthDay.length > 0 ? byMonthDay : [dtstart.local.day];
    outerMonthly: for (let i = 0; ; i += stepMonths) {
      const probe = shiftLocal(dtstart.local, zone, { months: i });
      if (probe > horizonEnd) break;
      for (const day of days) {
        const ms = shiftLocal({ ...dtstart.local, day }, zone, { months: i });
        if (ms < dtstart.ms) continue;
        if (!emit(ms)) break outerMonthly;
      }
      if (starts.length > ctx.maxOccurrences) break;
    }
    if (byDay.length > 0) {
      ctx.warnings.push('BYDAY on a MONTHLY/YEARLY rule is not applied; dates may be approximate.');
    }
  }

  return starts.map((start) => ({
    ...template,
    start,
    end: start + duration,
    recurrenceId: new Date(start).toISOString(),
  }));
}

/** Step a wall-clock time by whole days or months, then resolve back to UTC. */
function shiftLocal(
  local: LocalTime,
  zone: string,
  by: { days?: number; months?: number },
): number {
  const shifted = new Date(
    Date.UTC(local.year, local.month - 1 + (by.months ?? 0), local.day + (by.days ?? 0)),
  );
  return zonedToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    zone,
  );
}
