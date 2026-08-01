/**
 * Building the list a student ticks their own courses out of.
 *
 * The hard part — deciding when one course is really several parallel sections
 * — is done in `sked.ts` at enrichment time, because it needs the timing of
 * every occurrence. What is left here is presentation: collapsing occurrences
 * into rows, and nesting sections under the course they belong to.
 */

import type { Course } from './types.js';
import type { SkedEvent } from './sked.js';

/** Order courses by type first, so lectures are not buried among electives. */
const KIND_ORDER: Record<string, number> = { V: 0, P: 1, Ü: 2, S: 3, WP: 4, Vg: 5, Z: 6 };

function rank(kind: string): number {
  return KIND_ORDER[kind] ?? 9;
}

/** Values sorted by how often they occur, most frequent first. */
function byFrequency(values: (string | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).map(([v]) => v);
}

export function buildCourseList(events: SkedEvent[]): Course[] {
  const byKey = new Map<string, SkedEvent[]>();
  for (const event of events) {
    const list = byKey.get(event.courseKey) ?? [];
    list.push(event);
    byKey.set(event.courseKey, list);
  }

  const courses: Course[] = [];
  for (const [key, list] of byKey) {
    const first = list[0]!;
    const starts = list.map((e) => e.start);

    courses.push({
      key,
      title: first.title,
      label: first.shortTitle || first.title,
      kind: first.kind,
      ...(first.moduleCode ? { moduleCode: first.moduleCode } : {}),
      ...(first.section ? { section: first.section } : {}),
      lecturers: byFrequency(list.map((e) => e.lecturer)),
      rooms: byFrequency(list.map((e) => e.room)),
      eventCount: list.length,
      firstSeen: Math.min(...starts),
      lastSeen: Math.max(...starts),
    });
  }

  courses.sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      a.label.localeCompare(b.label, 'de') ||
      (a.section ?? '').localeCompare(b.section ?? '', 'de'),
  );
  return courses;
}

export interface CourseGroup {
  /** The course title every entry shares. */
  title: string;
  label: string;
  kind: string;
  moduleCode?: string;
  /** More than one entry means the student must pick a section. */
  courses: Course[];
}

/** Nest parallel sections under one heading so the picker reads as a course list. */
export function groupCourses(courses: Course[]): CourseGroup[] {
  const groups = new Map<string, Course[]>();
  for (const course of courses) {
    const list = groups.get(course.title) ?? [];
    list.push(course);
    groups.set(course.title, list);
  }

  return [...groups.values()]
    .map((list) => {
      const first = list[0]!;
      return {
        title: first.title,
        label: first.label,
        kind: first.kind,
        ...(first.moduleCode ? { moduleCode: first.moduleCode } : {}),
        courses: list,
      };
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label, 'de'));
}

/** Keep only the events belonging to courses the student selected. */
export function filterSelected(events: SkedEvent[], selected: string[] | null): SkedEvent[] {
  // A null selection means the student has not chosen yet; showing an empty
  // calendar at that point would look broken rather than unconfigured.
  if (selected === null) return events;
  const wanted = new Set(selected);
  return events.filter((e) => wanted.has(e.courseKey));
}
