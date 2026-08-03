/**
 * Tests against real fixtures cut from NORDAKADEMIE's published plan, so a
 * change in sked's output shows up here rather than in the extension.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseIcs } from '../src/lib/ics.ts';
import {
  applyAnnotations,
  enrichEvents,
  parseDescription,
  parsePlanAnnotations,
  parsePlanRef,
  parseRoomSwap,
  planUrls,
  retainAcknowledged,
  unacknowledgedIds,
} from '../src/lib/sked.ts';
import { buildCourseList, filterSelected, groupCourses } from '../src/lib/courses.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ics = readFileSync(join(here, 'fixtures/plan.ics'), 'utf8');
const planHtml = readFileSync(join(here, 'fixtures/plan.html'), 'utf8');

const events = enrichEvents(parseIcs(ics, { defaultTimeZone: 'Europe/Berlin' }).events);

test('plan URLs derive from the study group and semester', () => {
  assert.deepEqual(planUrls({ zenturie: 'A23a', semester: '6' }), {
    ics: 'https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene/A23a_6.ics',
    html: 'https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene/A23a_6.html',
  });

  // The CIS pages link to the HTML plan; that link is how the extension learns
  // which group the student is in without asking.
  assert.deepEqual(
    parsePlanRef('https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene/A23a_6.html'),
    { zenturie: 'A23a', semester: '6' },
  );
  assert.deepEqual(parsePlanRef('/fileadmin/Infos/Stundenplaene/W24b_2.ics'), {
    zenturie: 'W24b',
    semester: '2',
  });
  assert.equal(parsePlanRef('https://cis.nordakademie.de/mein-profil/'), null);
});

test('DESCRIPTION fields parse, and "-" placeholders are dropped', () => {
  const fields = parseDescription(
    'Veranstaltung: V A113 Usability Engineering\nDozent: Prof. Dr. phil. Iversen\n' +
      'Pause: inkl. 15 min Pause\nRaum: A005\nAnmerkung: -\nStatus: -',
  );
  assert.equal(fields.get('Veranstaltung'), 'V A113 Usability Engineering');
  assert.equal(fields.get('Raum'), 'A005');
  // "-" means "nothing recorded" and must not surface as content.
  assert.equal(fields.has('Anmerkung'), false);
  assert.equal(fields.has('Status'), false);
});

test('titles split into type, module code and name', () => {
  const usability = events.find((e) => e.title.includes('Usability'))!;
  assert.equal(usability.kind, 'V');
  assert.equal(usability.moduleCode, 'A113');
  assert.equal(usability.shortTitle, 'Usability Engineering');

  // Electives read "WP WP Digital Commerce" — the repeated token is the type,
  // not a module code.
  const elective = events.find((e) => e.title.includes('Digital Commerce'))!;
  assert.equal(elective.kind, 'WP');
  assert.equal(elective.moduleCode, undefined);
  assert.equal(elective.shortTitle, 'Digital Commerce');
});

test('structured fields beat the comma-jammed SUMMARY', () => {
  const event = events.find((e) => e.title.includes('Usability'))!;
  // SUMMARY crams four values into one string; nothing should be read from it.
  assert.match(event.summary, /,/);
  assert.equal(event.lecturer, 'Prof. Dr. phil. Iversen');
  assert.equal(event.room, 'A005');
  assert.equal(event.skedId, '231110');
});

test('simultaneous groups split; sequential co-teaching does not', () => {
  const courses = buildCourseList(events);

  // Englisch runs three groups at the same hour in different rooms. A student
  // attends one, so each must be separately selectable. Asserted on shape
  // rather than on the names themselves, which are pseudonyms.
  const englisch = courses.filter((c) => c.title === 'V I177 Englisch');
  assert.equal(englisch.length, 3);
  const sections = englisch.map((c) => c.section);
  assert.equal(sections.every(Boolean), true, 'each parallel group needs a section label');
  assert.equal(new Set(sections).size, 3, 'sections must be distinct');
  // Each group meets in its own room — that is what makes them separate groups.
  assert.equal(new Set(englisch.map((c) => c.rooms[0])).size, 3);

  // Internationale Beziehungen has three lecturers across different weeks.
  // That is one course, and splitting it would invent groups that do not exist.
  const intBez = courses.filter((c) => c.title.includes('Internationale Beziehungen'));
  assert.equal(intBez.length, 1, 'sequential co-teaching must not split');
  assert.equal(intBez[0]!.section, undefined);
  assert.ok(intBez[0]!.lecturers.length >= 1);
});

test('every split section is internally free of clashes', () => {
  const courses = buildCourseList(events);
  for (const course of courses.filter((c) => c.section)) {
    const own = events
      .filter((e) => e.courseKey === course.key)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < own.length; i++) {
      assert.ok(
        own[i]!.start >= own[i - 1]!.end,
        `section "${course.key}" still contains overlapping events`,
      );
    }
  }
});

test('the picker nests sections under their course', () => {
  const groups = groupCourses(buildCourseList(events));
  const englisch = groups.find((g) => g.title === 'V I177 Englisch')!;
  assert.equal(englisch.courses.length, 3);

  const usability = groups.find((g) => g.title.includes('Usability'))!;
  assert.equal(usability.courses.length, 1);

  // Lectures sort ahead of electives so they are not buried.
  const kinds = groups.map((g) => g.kind);
  assert.ok(kinds.indexOf('V') < kinds.indexOf('WP'), 'lectures should precede electives');
});

test('selecting courses removes the parallel-elective noise', () => {
  const courses = buildCourseList(events);
  const mine = [
    courses.find((c) => c.title.includes('Usability'))!.key,
    courses.find((c) => c.title === 'V I177 Englisch')!.key,
    courses.find((c) => c.title.includes('Digital Commerce'))!.key,
  ];

  const kept = filterSelected(events, mine);
  assert.ok(kept.length > 0);
  assert.ok(kept.length < events.length / 2, 'filtering should remove most of the feed');
  assert.deepEqual([...new Set(kept.map((e) => e.courseKey))].sort(), [...mine].sort());

  // No selection yet is not the same as selecting nothing.
  assert.equal(filterSelected(events, null).length, events.length);
  assert.equal(filterSelected(events, []).length, 0);
});

test('a selected Englisch group excludes its siblings at the same hour', () => {
  const courses = buildCourseList(events);
  const group = courses.find((c) => c.title === 'V I177 Englisch')!;
  const kept = filterSelected(events, [group.key]);

  assert.ok(kept.length > 0);
  // Only the chosen group's own sessions survive — the siblings run at the
  // same hour under a different lecturer.
  assert.ok(kept.every((e) => e.lecturer === group.section));
  // And the kept events never collide with each other.
  const sorted = [...kept].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i]!.start >= sorted[i - 1]!.end);
  }
});

test("sked's own change annotations are extracted from the HTML plan", () => {
  const annotations = parsePlanAnnotations(planHtml);

  assert.ok(annotations.markedIds.size > 0, 'red-border ids must be found');
  assert.ok(annotations.markedIds.has('227610'));
  assert.match(annotations.generatedAt ?? '', /^\d{2}\.\d{2}\.\d{4}/);

  const note = annotations.notes.find((n) => n.course.includes('Gebäudeautomation'));
  assert.ok(note, 'the change table row must be parsed');
  assert.equal(note!.date, 'Mo, 27.07.26');
  assert.equal(note!.time, '14:00 - 19:00 Uhr');
  assert.match(note!.change, /A103 ersetzt durch .*A004/);

  // The header row repeats once per week and must never become a note.
  assert.equal(annotations.notes.some((n) => n.date === 'Datum'), false);
});

test('annotations attach only to events sked actually flagged', () => {
  const annotations = parsePlanAnnotations(planHtml);
  const { flagged } = applyAnnotations(events, annotations);

  assert.ok(flagged.size > 0);
  for (const uid of flagged.keys()) {
    const event = events.find((e) => e.uid === uid)!;
    assert.ok(annotations.markedIds.has(event.skedId!));
  }

  const gebaeude = events.find(
    (e) => e.title.includes('Gebäudeautomation') && flagged.has(e.uid),
  );
  assert.ok(gebaeude, 'the room-swapped elective should be flagged');
  assert.match(flagged.get(gebaeude!.uid)?.change ?? '', /ersetzt durch/);
});

test('room substitutions are reduced to the two rooms that matter', () => {
  assert.deepEqual(parseRoomSwap('[H] A103 ersetzt durch [H] A004 TI Labor.'), {
    from: 'A103',
    to: 'A004 TI Labor',
  });
  assert.deepEqual(parseRoomSwap('A105 ersetzt durch H007'), { from: 'A105', to: 'H007' });

  // Wording that is not a substitution must be shown verbatim, not mangled.
  assert.equal(parseRoomSwap('Veranstaltung entfällt.'), null);
  assert.equal(parseRoomSwap(''), null);

  // Every substitution in the real fixture must parse.
  const { notes } = parsePlanAnnotations(planHtml);
  const swaps = notes.filter((n) => n.change.includes('ersetzt durch'));
  assert.ok(swaps.length > 0);
  for (const note of swaps) {
    const parsed = parseRoomSwap(note.change);
    assert.ok(parsed, `failed to parse: ${note.change}`);
    assert.equal(parsed!.from.includes('['), false, 'site code should be stripped');
    assert.equal(parsed!.to.includes('['), false, 'site code should be stripped');
  }
});

test('online sessions are recognised', () => {
  const online = events.filter((e) => e.online);
  for (const event of online) {
    assert.match(`${event.room ?? ''} ${event.status ?? ''} ${event.note ?? ''}`, /online/i);
  }
});

test('the whole fixture parses without warnings', () => {
  const { events: parsed, warnings, calendarName } = parseIcs(ics, {
    defaultTimeZone: 'Europe/Berlin',
  });
  assert.deepEqual(warnings, []);
  assert.equal(calendarName, 'A23 2023 - Angewandte Informatik A23a');
  assert.equal(parsed.length, events.length);
  // Every event must carry the fields the UI depends on.
  for (const event of events) {
    assert.ok(event.title, 'title missing');
    assert.ok(event.kind, `kind missing for ${event.title}`);
    assert.ok(event.courseKey, 'courseKey missing');
    assert.ok(event.end > event.start, `bad duration for ${event.title}`);
  }
});

/* ------------------------------------------------------------------ *
 * Dismissing the plan's own change flags (issue #1)
 *
 * The change strip has two independent sources: snapshot diffing, and the
 * flags sked publishes in the HTML plan. "Gelesen" used to acknowledge only
 * the first, so on a fresh install — where every mark comes from the second —
 * the bar stayed on screen and the button appeared dead.
 * ------------------------------------------------------------------ */

test('dismissed plan flags stop being shown', () => {
  const marked = ['227350', '227552', '227610'];

  // Nothing dismissed yet: every flag is live.
  assert.deepEqual([...unacknowledgedIds(marked, [])], marked);
  assert.deepEqual([...unacknowledgedIds(marked)], marked);

  // "Gelesen" acknowledges everything currently flagged.
  assert.equal(unacknowledgedIds(marked, marked).size, 0);

  assert.deepEqual([...unacknowledgedIds(marked, ['227552'])], ['227350', '227610']);
});

test('a flag raised after dismissal is shown again', () => {
  // The student read the two changes the plan had, then it published a third.
  const acknowledged = ['227350', '227552'];
  const marked = ['227350', '227552', '227999'];

  assert.deepEqual([...unacknowledgedIds(marked, acknowledged)], ['227999']);
});

test('dismissals survive a refresh but are forgotten once the plan drops them', () => {
  const acknowledged = ['227350', '227552'];

  // The plan still flags both, so both dismissals must be carried forward —
  // otherwise the next sync resurrects marks the student already read.
  assert.deepEqual(retainAcknowledged(['227350', '227552'], acknowledged).sort(), acknowledged);

  // It has stopped flagging one: remembering that dismissal is dead weight.
  assert.deepEqual(retainAcknowledged(['227350'], acknowledged), ['227350']);
  assert.deepEqual(retainAcknowledged([], acknowledged), []);

  // Re-flagged later counts as a new change, so it must not stay dismissed.
  const pruned = retainAcknowledged([], acknowledged);
  assert.deepEqual([...unacknowledgedIds(['227350'], pruned)], ['227350']);
});

test('the fixture plan flags changes that a dismissal then clears', () => {
  // Guards the whole path against real data rather than hand-made ids.
  const annotations = parsePlanAnnotations(planHtml);
  const flaggedIds = [...annotations.markedIds];
  assert.ok(flaggedIds.length > 0, 'fixture should flag something');

  const active = unacknowledgedIds(flaggedIds, flaggedIds);
  assert.equal(active.size, 0);

  const { flagged } = applyAnnotations(events, { ...annotations, markedIds: active });
  assert.equal(flagged.size, 0, 'nothing should stay marked once dismissed');
});
