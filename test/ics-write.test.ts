/**
 * The writer's contract is that a calendar app reading its output sees the same
 * timetable the extension shows. The round trip through the real parser is the
 * test that actually says that; the rest cover the RFC details that are easy to
 * get subtly wrong and impossible to notice by eye.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseIcs } from '../src/lib/ics.ts';
import { writeIcs } from '../src/lib/ics-write.ts';
import { enrichEvents, type SkedEvent } from '../src/lib/sked.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ics = readFileSync(join(here, 'fixtures/plan.ics'), 'utf8');

const ZONE = 'Europe/Berlin';
const STAMP = Date.UTC(2026, 6, 31, 10, 34, 16);

const events = enrichEvents(parseIcs(ics, { defaultTimeZone: ZONE }).events);

const write = (list: SkedEvent[] = events, options = {}) =>
  writeIcs(list, { calendarName: 'A23a', dtstamp: STAMP, ...options });

/** A synthetic event, for the fields the fixture happens not to exercise. */
function event(overrides: Partial<SkedEvent> = {}): SkedEvent {
  return {
    uid: 'sked.de1',
    start: Date.UTC(2026, 6, 27, 12, 0),
    end: Date.UTC(2026, 6, 27, 14, 0),
    allDay: false,
    summary: 'raw',
    cancelled: false,
    courseKey: 'V A113 Usability Engineering',
    title: 'V A113 Usability Engineering',
    shortTitle: 'Usability Engineering',
    kind: 'V',
    online: false,
    ...overrides,
  };
}

test('a written calendar parses back to the same events', () => {
  const round = parseIcs(write(), { defaultTimeZone: ZONE });

  // The fixture parses with zero warnings; anything the writer emits that the
  // reader cannot interpret would show up here.
  assert.deepEqual(round.warnings, []);
  assert.equal(round.events.length, events.length);
  assert.equal(round.calendarName, 'A23a');

  const before = events.map((e) => `${e.start}|${e.end}|${e.allDay}`).sort();
  const after = round.events.map((e) => `${e.start}|${e.end}|${e.allDay}`).sort();
  assert.deepEqual(after, before);
});

test('times survive as UTC instants across the DST boundary', () => {
  // 27 July is CEST (UTC+2), 27 December is CET (UTC+1). Writing local times
  // without a VTIMEZONE would put one of these an hour out.
  const summer = event({ start: Date.UTC(2026, 6, 27, 12, 0), end: Date.UTC(2026, 6, 27, 14, 0) });
  const winter = event({
    uid: 'sked.de2',
    start: Date.UTC(2026, 11, 27, 13, 0),
    end: Date.UTC(2026, 11, 27, 15, 0),
  });

  const text = write([summer, winter]);
  assert.match(text, /DTSTART:20260727T120000Z/);
  assert.match(text, /DTSTART:20261227T130000Z/);

  const round = parseIcs(text, { defaultTimeZone: ZONE });
  assert.deepEqual(
    round.events.map((e) => e.start).sort(),
    [summer.start, winter.start].sort(),
  );
});

test('the unusable feed SUMMARY is replaced by a readable one', () => {
  const text = write([event()]);
  assert.match(text, /SUMMARY:Usability Engineering \(Vorlesung\)/);

  // The raw feed's own SUMMARY is the thing being fixed, so it must not survive.
  assert.doesNotMatch(text, /SUMMARY:raw/);
});

test('room, lecturer and break land where a calendar app shows them', () => {
  const text = write([
    event({
      room: 'H008',
      lecturer: 'Prof. Dr. Kortmann',
      moduleCode: 'A113',
      description: 'Veranstaltung: V A113 Usability Engineering\nPause: inkl. 30 min Pause',
    }),
  ]);

  assert.match(text, /LOCATION:H008/);
  const [, description] = /DESCRIPTION:(.*)/.exec(text.replace(/\r\n /g, '')) ?? [];
  assert.ok(description?.includes('Dozent: Prof. Dr. Kortmann'));
  assert.ok(description?.includes('Modul: A113'));
  assert.ok(description?.includes('inkl. 30 min Pause'));
});

test("sked's room swap wording becomes a plain room change", () => {
  const notes = new Map([['sked.de1', '[H] A105 ersetzt durch [H] H007.']]);
  const text = write([event()], { notes }).replace(/\r\n /g, '');
  assert.match(text, /Raumwechsel: A105 → H007/);
});

test('a cancelled event is marked, or dropped on request', () => {
  const cancelled = event({ cancelled: true });

  assert.match(write([cancelled]), /STATUS:CANCELLED/);
  assert.match(write([event()]), /STATUS:CONFIRMED/);

  const dropped = write([cancelled], { includeCancelled: false });
  assert.doesNotMatch(dropped, /BEGIN:VEVENT/);
});

test('UIDs are suffixed and stable', () => {
  const text = write([event()]);
  assert.match(text, /UID:sked\.de1@better-cis/);

  // Two writes of the same input must be byte-identical, or every poll looks
  // like a change to the subscriber.
  assert.equal(write(), write());
});

test('lines fold at 75 octets, counting bytes rather than characters', () => {
  const text = write([
    event({
      // 60 characters, 120 octets: a character-based fold would leave this
      // line over the limit and could split a multi-byte sequence.
      shortTitle: 'Ü'.repeat(60),
      room: '→'.repeat(40),
    }),
  ]);

  for (const line of text.split('\r\n')) {
    assert.ok(
      Buffer.byteLength(line, 'utf8') <= 75,
      `line over 75 octets: ${Buffer.byteLength(line, 'utf8')}`,
    );
  }

  // Folding must be reversible, not merely short.
  const round = parseIcs(text, { defaultTimeZone: ZONE });
  assert.equal(round.events[0]?.summary, `${'Ü'.repeat(60)} (Vorlesung)`);
  assert.equal(round.events[0]?.location, '→'.repeat(40));
});

test('TEXT special characters are escaped', () => {
  const text = write([event({ shortTitle: 'A;B,C\\D', note: 'zwei\nZeilen' })]);
  assert.match(text, /SUMMARY:A\\;B\\,C\\\\D \(Vorlesung\)/);

  const round = parseIcs(text, { defaultTimeZone: ZONE });
  assert.equal(round.events[0]?.summary, 'A;B,C\\D (Vorlesung)');
  assert.ok(round.events[0]?.description?.includes('zwei\nZeilen'));
});

test('an all-day event stays on its day', () => {
  const text = write([
    event({ allDay: true, start: Date.UTC(2026, 6, 27), end: Date.UTC(2026, 6, 28) }),
  ]);
  assert.match(text, /DTSTART;VALUE=DATE:20260727/);

  const round = parseIcs(text, { defaultTimeZone: ZONE });
  assert.equal(round.events[0]?.allDay, true);
  assert.equal(round.events[0]?.start, Date.UTC(2026, 6, 27));
});
