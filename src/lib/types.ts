/** A single occurrence of a class, exam, or appointment. */
export interface CalEvent {
  /** iCalendar UID. Stable across refreshes for the same event. */
  uid: string;
  /**
   * For an occurrence of a recurring series, the original start time as an ISO
   * string. Combined with `uid` this identifies one occurrence uniquely; a bare
   * UID is not enough because a weekly lecture shares one UID across the term.
   */
  recurrenceId?: string;
  /** Start/end as epoch milliseconds (UTC). */
  start: number;
  end: number;
  /** True for all-day events (DTSTART;VALUE=DATE). */
  allDay: boolean;
  summary: string;
  location?: string;
  description?: string;
  /** STATUS:CANCELLED — campus systems use this for dropped sessions. */
  cancelled: boolean;
  /** Which course this occurrence belongs to. See `courseKeyOf`. */
  courseKey: string;
}

/** A course the user can toggle on or off, derived by grouping events. */
export interface Course {
  key: string;
  /** Full title as the feed states it, e.g. "V A113 Usability Engineering". */
  title: string;
  /** Title without the type and module code, for display. */
  label: string;
  /** V = Vorlesung, WP = Wahlpflicht, Z = Zenturienbetreuung, Vg = Vortrag. */
  kind: string;
  moduleCode?: string;
  /**
   * Set only when the course runs as parallel sections the student must choose
   * between; holds whatever distinguishes them (usually the lecturer).
   */
  section?: string;
  /** Everyone who teaches it, in order of how often they appear. */
  lecturers: string[];
  rooms: string[];
  /** How many occurrences are in the feed. Useful for sorting the picker. */
  eventCount: number;
  /** Earliest and latest occurrence, so stale courses can be de-emphasised. */
  firstSeen: number;
  lastSeen: number;
}

/**
 * What we persist between refreshes so changes can be detected.
 *
 * Generic over the event type so the sked-enriched fields survive a round trip
 * through storage, without `types.ts` having to import from `sked.ts` — which
 * would be a cycle, since `sked.ts` builds on `CalEvent`.
 */
export interface Snapshot<E extends CalEvent = CalEvent> {
  /** When this snapshot was fetched (epoch ms). */
  fetchedAt: number;
  /** Source feed URL, so a changed subscription invalidates the history. */
  feedUrl: string;
  events: E[];
}

export type ChangeKind =
  | 'added'
  | 'removed'
  | 'cancelled'
  | 'uncancelled'
  | 'rescheduled'
  | 'moved'
  | 'renamed';

/** One detected difference between two snapshots. */
export interface Change<E extends CalEvent = CalEvent> {
  kind: ChangeKind;
  /** Occurrence key: `uid` or `uid|recurrenceId`. */
  id: string;
  courseKey: string;
  /** The event as it now stands; for `removed`, the event as it last stood. */
  event: E;
  /** The prior state, for kinds that describe a modification. */
  previous?: E;
  /** When we first noticed this change (epoch ms). */
  detectedAt: number;
  /** Set once the user has seen it, so the badge can clear. */
  acknowledged?: boolean;
  /**
   * sked's own wording for this change, when the HTML plan flagged it, e.g.
   * "[H] A103 ersetzt durch [H] A004 TI Labor."
   */
  officialNote?: string;
}
