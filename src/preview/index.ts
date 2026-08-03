/**
 * A harness for checking the calendar against real data without installing the
 * extension.
 *
 * Injected into a live CIS page, it fetches the plan files itself — both are
 * same-origin from there — and drives the same view the content script does,
 * with settings held in memory. Nothing here ships: it exists so the UI can be
 * looked at, and screenshotted, against the real timetable.
 */

import { parseIcs } from '../lib/ics.js';
import { buildCourseList, groupCourses } from '../lib/courses.js';
import { enrichEvents, parsePlanAnnotations, parsePlanRef, planUrls } from '../lib/sked.js';
import { diffSnapshots } from '../lib/diff.js';
import { DEFAULT_SETTINGS, type Settings } from '../lib/storage.js';
import { createCalendar, type CalendarState } from '../content/calendar.js';
import type { Change, Snapshot } from '../lib/types.js';
import type { SkedEvent } from '../lib/sked.js';

declare global {
  interface Window {
    __betterCisPreview?: (options?: PreviewOptions) => Promise<string>;
  }
}

export interface PreviewOptions {
  /** Course keys to pre-select, so a filtered week can be inspected. */
  selectedCourses?: string[] | null;
  /**
   * Choose a plausible timetable automatically: every non-elective course, the
   * first section where a course splits into parallel groups, and exactly one
   * elective — which is what a real student's selection looks like.
   */
  autoSelect?: boolean;
  /** Force a specific plan instead of the one this page links to. */
  zenturie?: string;
  semester?: string;
  /**
   * Synthesise changes by comparing against a doctored earlier snapshot, so
   * the change presentation can be checked without waiting for the real plan
   * to move.
   */
  simulateChanges?: boolean;
}

const HOST_ID = 'better-cis-preview';

async function preview(options: PreviewOptions = {}): Promise<string> {
  const container = document.querySelector<HTMLElement>('div.stupla');
  if (!container) return 'no div.stupla on this page';
  const table = container.querySelector<HTMLElement>('table.contenttable');
  if (!table) return 'no table.contenttable inside div.stupla';

  const ref =
    options.zenturie && options.semester
      ? { zenturie: options.zenturie, semester: options.semester }
      : findPlanRef();
  if (!ref) return 'could not find a plan link on this page';

  const urls = planUrls(ref);
  const [icsText, htmlText] = await Promise.all([
    fetch(urls.ics).then((r) => r.text()),
    fetch(urls.html)
      .then((r) => r.text())
      .catch(() => ''),
  ]);

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    zenturie: ref.zenturie,
    semester: ref.semester,
    selectedCourses: options.selectedCourses ?? null,
  };

  const events = enrichEvents(parseIcs(icsText, { defaultTimeZone: settings.timeZone }).events);

  if (options.autoSelect) settings.selectedCourses = plausibleSelection(events);
  const snapshot: Snapshot<SkedEvent> = {
    fetchedAt: Date.now(),
    feedUrl: urls.ics,
    events,
  };

  const annotations = htmlText ? parsePlanAnnotations(htmlText) : null;

  let changes: Change<SkedEvent>[] = [];
  if (options.simulateChanges) changes = synthesiseChanges(snapshot);

  const state: CalendarState = {
    settings,
    snapshot,
    changes,
    status: { lastSyncAt: Date.now(), lastError: null },
    annotations: annotations
      ? {
          markedIds: [...annotations.markedIds],
          notes: annotations.notes,
          ...(annotations.generatedAt ? { generatedAt: annotations.generatedAt } : {}),
        }
      : null,
  };

  document.getElementById(HOST_ID)?.remove();
  table.style.display = 'none';

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  table.parentElement?.insertBefore(host, table);

  const calendar = createCalendar(shadow, {
    setSelection: (keys) => {
      state.settings = { ...state.settings, selectedCourses: keys };
      calendar.update(state);
    },
    acknowledgeAll: () => {
      state.changes = state.changes.map((c) => ({ ...c, acknowledged: true }));
      state.annotations = null;
      calendar.update(state);
    },
    setOriginalVisible: (visible) => {
      table.style.display = visible ? '' : 'none';
    },
    setEndpoint: (endpoint) => {
      state.settings = { ...state.settings, icalEndpoint: endpoint };
      calendar.update(state);
    },
    setLastCopied: (url) => {
      state.settings = { ...state.settings, icalLastCopied: url };
      calendar.update(state);
    },
  });
  calendar.update(state);

  return (
    `plan ${ref.zenturie}_${ref.semester} · ${events.length} events · ` +
    `${annotations?.markedIds.size ?? 0} flagged by sked · ${changes.length} simulated changes`
  );
}

/**
 * A selection resembling one student's: everything compulsory, one section
 * where a course runs parallel groups, and a single elective out of the
 * sixteen sharing the Monday slot.
 */
function plausibleSelection(events: SkedEvent[]): string[] {
  const groups = groupCourses(buildCourseList(events));
  const picked: string[] = [];
  let electives = 0;

  for (const group of groups) {
    if (group.kind === 'WP' && electives++ > 0) continue;
    // Where a course splits, a student belongs to exactly one section.
    picked.push(group.courses[0]!.key);
  }
  return picked;
}

function findPlanRef(): { zenturie: string; semester: string } | null {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const ref = parsePlanRef(anchor.href);
    if (ref) return ref;
  }
  return null;
}

/**
 * Build a plausible set of changes by rewinding a copy of the snapshot: move
 * one class to a different room, push another later, and drop a third. Real
 * diffing runs over the result, so what is rendered is produced by the same
 * code path as a genuine change.
 */
function synthesiseChanges(snapshot: Snapshot<SkedEvent>): Change<SkedEvent>[] {
  const upcoming = snapshot.events
    .filter((e) => e.end >= Date.now())
    .sort((a, b) => a.start - b.start);
  if (upcoming.length < 4) return [];

  const doctored = snapshot.events.map((event) => {
    if (event.uid === upcoming[0]!.uid) return { ...event, room: 'A103' };
    if (event.uid === upcoming[2]!.uid) {
      return { ...event, start: event.start - 3600_000, end: event.end - 3600_000 };
    }
    return event;
  });

  const before: Snapshot<SkedEvent> = { ...snapshot, events: doctored };
  return diffSnapshots(before, snapshot, { now: Date.now() }).changes;
}

window.__betterCisPreview = preview;
