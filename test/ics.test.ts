import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIcs } from '../src/lib/ics.ts';
import { enrichEvents } from '../src/lib/sked.ts';
import { diffSnapshots, mergeChanges, occurrenceId } from '../src/lib/diff.ts';
import type { Snapshot } from '../src/lib/types.ts';

/** Wrap VEVENT bodies in a minimal VCALENDAR, using CRLF as real feeds do. */
function ics(...bodies: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'X-WR-CALNAME:Stundenplan',
    ...bodies.flatMap((b) => ['BEGIN:VEVENT', ...b.trim().split('\n'), 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}

const iso = (ms: number) => new Date(ms).toISOString();

test('parses a plain event with TZID local time', () => {
  const { events, calendarName } = parseIcs(
    ics(`
UID:evt-1
DTSTART;TZID=Europe/Berlin:20250310T100000
DTEND;TZID=Europe/Berlin:20250310T114500
SUMMARY:Analysis I
LOCATION:H\\, Raum 1.203
`),
  );

  assert.equal(calendarName, 'Stundenplan');
  assert.equal(events.length, 1);
  const event = events[0]!;
  // 10:00 Berlin in March is CET (UTC+1).
  assert.equal(iso(event.start), '2025-03-10T09:00:00.000Z');
  assert.equal(iso(event.end), '2025-03-10T10:45:00.000Z');
  assert.equal(event.summary, 'Analysis I');
  // The escaped comma must survive as a literal comma.
  assert.equal(event.location, 'H, Raum 1.203');
  assert.equal(event.cancelled, false);
});

test('unfolds continuation lines and decodes escapes', () => {
  const raw = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:evt-fold',
    'DTSTART:20250310T090000Z',
    'DTEND:20250310T100000Z',
    'SUMMARY:Einführung in die Theoretische',
    '  Informatik',
    'DESCRIPTION:Line one\\nLine two\\; with a semicolon',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const { events } = parseIcs(raw);
  assert.equal(events[0]!.summary, 'Einführung in die Theoretische Informatik');
  assert.equal(events[0]!.description, 'Line one\nLine two; with a semicolon');
});

test('keeps wall-clock time constant across a DST transition', () => {
  const { events } = parseIcs(
    ics(`
UID:weekly-1
DTSTART;TZID=Europe/Berlin:20250310T100000
DTEND;TZID=Europe/Berlin:20250310T114500
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
SUMMARY:Analysis I
`),
  );

  assert.equal(events.length, 4);
  const starts = events.map((e) => iso(e.start));
  assert.deepEqual(starts, [
    '2025-03-10T09:00:00.000Z', // CET
    '2025-03-17T09:00:00.000Z', // CET
    '2025-03-24T09:00:00.000Z', // CET
    '2025-03-31T08:00:00.000Z', // CEST — clocks moved, the lecture did not
  ]);

  // Duration must be preserved, not recomputed from the shifted offset.
  for (const event of events) {
    assert.equal(event.end - event.start, 105 * 60 * 1000);
  }
});

test('honours UNTIL, INTERVAL and EXDATE', () => {
  const { events } = parseIcs(
    ics(`
UID:weekly-2
DTSTART;TZID=Europe/Berlin:20250407T140000
DTEND;TZID=Europe/Berlin:20250407T154500
RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=2;UNTIL=20250520T235959Z
EXDATE;TZID=Europe/Berlin:20250505T140000
SUMMARY:Statistik Übung Gruppe 3
`),
  );

  const days = events.map((e) => iso(e.start).slice(0, 10));
  // Every other Monday from 7 Apr, with 5 May excluded, stopping before 20 May.
  assert.deepEqual(days, ['2025-04-07', '2025-04-21', '2025-05-19']);
});

test('a RECURRENCE-ID override replaces that single occurrence', () => {
  const { events } = parseIcs(
    ics(
      `
UID:weekly-3
DTSTART;TZID=Europe/Berlin:20250310T100000
DTEND;TZID=Europe/Berlin:20250310T114500
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
SUMMARY:Datenbanken
LOCATION:Raum A
`,
      `
UID:weekly-3
RECURRENCE-ID;TZID=Europe/Berlin:20250317T100000
DTSTART;TZID=Europe/Berlin:20250317T140000
DTEND;TZID=Europe/Berlin:20250317T154500
SUMMARY:Datenbanken
LOCATION:Raum B
STATUS:CANCELLED
`,
    ),
  );

  assert.equal(events.length, 3, 'the override must not add a fourth occurrence');
  const moved = events.find((e) => e.location === 'Raum B')!;
  assert.equal(iso(moved.start), '2025-03-17T13:00:00.000Z');
  assert.equal(moved.cancelled, true);
  assert.equal(events.filter((e) => e.location === 'Raum A').length, 2);
});

test('handles all-day events and DURATION', () => {
  const { events } = parseIcs(
    ics(
      `
UID:allday
DTSTART;VALUE=DATE:20250601
DTEND;VALUE=DATE:20250602
SUMMARY:Pfingstmontag
`,
      `
UID:dur
DTSTART:20250310T090000Z
DURATION:PT1H30M
SUMMARY:Kolloquium
`,
    ),
  );

  const allDay = events.find((e) => e.uid === 'allday')!;
  assert.equal(allDay.allDay, true);
  assert.equal(iso(allDay.start), '2025-06-01T00:00:00.000Z');

  const withDuration = events.find((e) => e.uid === 'dur')!;
  assert.equal(withDuration.end - withDuration.start, 90 * 60 * 1000);
});

test('skips malformed events instead of throwing, and reports why', () => {
  const { events, warnings } = parseIcs(
    ics(
      `
UID:ok
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Fine
`,
      `
DTSTART:20250311T090000Z
SUMMARY:No UID
`,
      `
UID:bad-date
DTSTART:not-a-date
SUMMARY:Broken
`,
    ),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]!.summary, 'Fine');
  assert.equal(warnings.length, 2);
});

test('a VALARM inside an event cannot hijack its fields', () => {
  const raw = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:alarmed',
    'DTSTART:20250310T090000Z',
    'DTEND:20250310T100000Z',
    'SUMMARY:Real title',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'SUMMARY:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const { events } = parseIcs(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.summary, 'Real title');
});

/* ------------------------------------------------------------------ *
 * Change detection
 * ------------------------------------------------------------------ */

const FEED = 'https://campus.example/ical/token';
const NOW = Date.UTC(2025, 2, 1);

function snapshot(body: string, fetchedAt = NOW): Snapshot {
  return {
    fetchedAt,
    feedUrl: FEED,
    events: enrichEvents(parseIcs(body).events),
  };
}

test('detects cancellation, room change and reschedule', () => {
  const before = snapshot(
    ics(
      `
UID:1
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Analysis I
LOCATION:Raum A
`,
      `
UID:2
DTSTART:20250311T090000Z
DTEND:20250311T100000Z
SUMMARY:Datenbanken
LOCATION:Raum B
`,
      `
UID:3
DTSTART:20250312T090000Z
DTEND:20250312T100000Z
SUMMARY:Statistik
`,
    ),
  );

  const after = snapshot(
    ics(
      `
UID:1
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Analysis I
LOCATION:Raum C
`,
      `
UID:2
DTSTART:20250311T130000Z
DTEND:20250311T140000Z
SUMMARY:Datenbanken
LOCATION:Raum B
STATUS:CANCELLED
`,
      `
UID:4
DTSTART:20250313T090000Z
DTEND:20250313T100000Z
SUMMARY:Neue Vorlesung
`,
    ),
  );

  const { changes, suspect } = diffSnapshots(before, after, { now: NOW });
  assert.equal(suspect, undefined);

  const kinds = changes.map((c) => `${c.kind}:${c.event.uid}`).sort();
  assert.deepEqual(kinds, [
    'added:4',
    'cancelled:2',
    'moved:1',
    'removed:3',
    'rescheduled:2',
  ]);
});

test('ignores events that already happened', () => {
  const past = Date.UTC(2025, 2, 20);
  const before = snapshot(
    ics(`
UID:old
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Vergangene Vorlesung
`),
  );
  const after = snapshot(ics(''), past);

  // The only difference is an event that ended ten days ago.
  const { changes } = diffSnapshots(before, after, { now: past });
  assert.deepEqual(changes, []);
});

test('refuses to report on a truncated download', () => {
  const bodies = Array.from({ length: 10 }, (_, i) =>
    `UID:e${i}\nDTSTART:2025031${i}T090000Z\nDTEND:2025031${i}T100000Z\nSUMMARY:Kurs ${i}`,
  );
  const before = snapshot(ics(...bodies));
  const after = snapshot(ics(...bodies.slice(0, 2)));

  const { changes, suspect } = diffSnapshots(before, after, { now: NOW });
  assert.deepEqual(changes, []);
  assert.match(suspect ?? '', /partial download/);
});

test('a first sync reports nothing, and a new feed URL resets history', () => {
  const after = snapshot(
    ics(`
UID:1
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Analysis I
`),
  );
  assert.deepEqual(diffSnapshots(null, after, { now: NOW }).changes, []);

  const other: Snapshot = { ...after, feedUrl: 'https://campus.example/ical/other', events: [] };
  assert.deepEqual(diffSnapshots(other, after, { now: NOW }).changes, []);
});

test('re-detecting a known change does not resurrect it as unread', () => {
  const before = snapshot(
    ics(`
UID:1
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Analysis I
LOCATION:Raum A
`),
  );
  const after = snapshot(
    ics(`
UID:1
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
SUMMARY:Analysis I
LOCATION:Raum C
`),
  );

  const first = diffSnapshots(before, after, { now: NOW }).changes;
  assert.equal(first.length, 1);

  const acknowledged = first.map((c) => ({ ...c, acknowledged: true }));
  // The same comparison runs again on the next refresh.
  const second = diffSnapshots(before, after, { now: NOW + 60_000 }).changes;
  const merged = mergeChanges(acknowledged, second, NOW + 60_000);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.acknowledged, true, 'the acknowledged flag must survive a re-detect');
});

test('occurrence ids distinguish siblings in a series', () => {
  const { events } = parseIcs(
    ics(`
UID:series
DTSTART:20250310T090000Z
DTEND:20250310T100000Z
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Analysis I
`),
  );
  const ids = new Set(events.map((e) => occurrenceId(e)));
  assert.equal(ids.size, 3, 'three occurrences must not collapse to one id');
});
