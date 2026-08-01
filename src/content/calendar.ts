/**
 * The injected calendar, as a self-contained view.
 *
 * Kept independent of the extension messaging layer so it can be driven by
 * anything that supplies a `CalendarState` — the content script in normal use,
 * and a preview harness that fetches the feed directly when the UI itself is
 * what needs checking.
 *
 * All rendering goes through `textContent`. The feed is third-party data
 * arriving as course titles and room names, and building this UI with
 * `innerHTML` would turn a timetable entry into script injection.
 */

import { buildCourseList, filterSelected, groupCourses, type CourseGroup } from '../lib/courses.js';
import { applyAnnotations, parseRoomSwap, type SkedEvent } from '../lib/sked.js';
import { CALENDAR_CSS } from './styles.js';
import type { Settings, StoredAnnotations, SyncStatus } from '../lib/storage.js';
import type { Change, Course, Snapshot } from '../lib/types.js';

export interface CalendarState {
  settings: Settings;
  snapshot: Snapshot<SkedEvent> | null;
  changes: Change<SkedEvent>[];
  status: SyncStatus;
  annotations: StoredAnnotations | null;
}

/** Why one occurrence is highlighted, and the best wording available for it. */
interface Mark {
  change?: Change<SkedEvent>;
  /** sked's own description of the change, when the plan published one. */
  note?: string;
}

export interface CalendarActions {
  /** Persist the student's course selection. */
  setSelection(keys: string[]): unknown;
  /** Mark every detected change as seen. */
  acknowledgeAll(): unknown;
  /** Show or hide the original CIS table. */
  setOriginalVisible(visible: boolean): void;
}

const WEEKDAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/**
 * sked's single-letter type codes, spelled out. "V" and "WP" are the
 * timetable system's vocabulary, not a student's.
 */
const KIND_LABELS: Record<string, string> = {
  V: 'Vorlesung',
  WP: 'Wahlpflicht',
  Z: 'Betreuung',
  Vg: 'Vortrag',
  P: 'Praktikum',
  Ü: 'Übung',
  S: 'Seminar',
};

export function createCalendar(shadow: ShadowRoot, actions: CalendarActions) {
  let state: CalendarState | null = null;
  /** Monday of the displayed week, as `YYYY-MM-DD` in the plan's time zone. */
  let weekCursor: string | null = null;
  let pickerOpen = false;
  let draftSelection: Set<string> | null = null;
  let showOriginal = false;

  /* ---------------------------------------------------------------- *
   * Dates, computed in the plan's time zone rather than the browser's
   * ---------------------------------------------------------------- */

  const zone = () => state?.settings.timeZone ?? 'Europe/Berlin';

  /** `YYYY-MM-DD` for an instant, as seen in the plan's time zone. */
  const dayKey = (ms: number): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));

  const formatTime = (ms: number): string =>
    new Intl.DateTimeFormat('de-DE', {
      timeZone: zone(),
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));

  /* ---------------------------------------------------------------- *
   * Data shaping
   * ---------------------------------------------------------------- */

  function visibleEvents(): SkedEvent[] {
    if (!state?.snapshot) return [];
    const { selectedCourses, hideUnselected } = state.settings;
    if (!hideUnselected) return state.snapshot.events;
    return filterSelected(state.snapshot.events, selectedCourses);
  }

  /** Every week that has at least one visible event, ascending. */
  function availableWeeks(events: SkedEvent[]): string[] {
    return [...new Set(events.map((e) => weekStartOf(dayKey(e.start))))].sort();
  }

  /**
   * Which occurrences to show as changed, and what to say about each.
   *
   * Two independent sources. Snapshot diffing catches anything that moved
   * since we last looked; sked's own flags additionally cover changes made
   * before this extension was ever installed. Where sked supplies wording
   * ("A105 ersetzt durch H007") it is preferred over anything inferred,
   * because it is what the registrar actually published.
   */
  function markedEvents(): Map<string, Mark> {
    const marked = new Map<string, Mark>();
    if (!state) return marked;

    for (const change of state.changes) {
      if (change.acknowledged) continue;
      if (change.kind === 'removed') continue; // no card left to mark
      marked.set(change.event.uid, { change, note: change.officialNote });
    }

    const annotations = state.annotations;
    if (annotations && annotations.markedIds.length > 0 && state.snapshot) {
      const { flagged } = applyAnnotations(state.snapshot.events, {
        markedIds: new Set(annotations.markedIds),
        notes: annotations.notes,
      });
      for (const [uid, note] of flagged) {
        const existing = marked.get(uid);
        if (existing) {
          // Keep the diff's richer classification, but take sked's wording.
          if (!existing.note && note) existing.note = note.change;
        } else {
          marked.set(uid, { ...(note ? { note: note.change } : {}) });
        }
      }
    }
    return marked;
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function render(): void {
    if (!state) return;

    // A re-render rebuilds the whole tree, which would otherwise throw the
    // course list back to the top mid-selection. Toggling a checkbox no longer
    // re-renders at all, but a background sync landing while the picker is
    // open still can.
    const scrollTop = shadow.querySelector('.picker-list')?.scrollTop ?? 0;

    clear(shadow);

    const style = document.createElement('style');
    style.textContent = CALENDAR_CSS;
    shadow.append(style);

    const panel = el('div', 'panel');
    shadow.append(panel);

    const events = visibleEvents();
    const weeks = availableWeeks(events);

    // Land on the current week if it has anything, else the next one that does.
    if (weekCursor === null) {
      const thisWeek = weekStartOf(dayKey(Date.now()));
      weekCursor = weeks.includes(thisWeek)
        ? thisWeek
        : (weeks.find((w) => w >= thisWeek) ?? weeks[weeks.length - 1] ?? thisWeek);
    }

    panel.append(renderBar(weeks));

    if (state.status.lastError) panel.append(el('div', 'error', state.status.lastError));

    const notChosenYet = state.settings.selectedCourses === null;
    if (notChosenYet && !pickerOpen) {
      panel.append(renderPrompt());
    } else {
      const weekEvents = events.filter((e) => weekStartOf(dayKey(e.start)) === weekCursor);
      const strip = renderChangeStrip(weekEvents);
      if (strip) panel.append(strip);
      panel.append(renderGrid(weekEvents));
    }

    if (pickerOpen) {
      panel.append(renderPicker());
      const list = shadow.querySelector('.picker-list');
      if (list && scrollTop > 0) list.scrollTop = scrollTop;
    }
  }

  function renderBar(weeks: string[]): HTMLElement {
    const bar = el('div', 'bar');
    const index = weeks.indexOf(weekCursor!);

    const nav = el('div', 'nav');
    const prev = el('button', undefined, '‹');
    prev.title = 'Vorherige Woche';
    prev.disabled = index <= 0;
    prev.addEventListener('click', () => {
      weekCursor = weeks[index - 1] ?? weekCursor;
      render();
    });
    const next = el('button', undefined, '›');
    next.title = 'Nächste Woche';
    next.disabled = index < 0 || index >= weeks.length - 1;
    next.addEventListener('click', () => {
      weekCursor = weeks[index + 1] ?? weekCursor;
      render();
    });
    nav.append(prev, next);

    const week = el('div', 'week');
    week.append(
      el('span', 'week-no', `KW ${isoWeekNumber(weekCursor!)}`),
      el(
        'span',
        'week-range',
        `${formatDayMonth(weekCursor!)} – ${formatDayMonth(addDays(weekCursor!, 4))}`,
      ),
    );

    bar.append(nav, week, el('div', 'spacer'));

    const actionsBar = el('div', 'bar-actions');
    const selected = state!.settings.selectedCourses;
    const total = state!.snapshot ? buildCourseList(state!.snapshot.events).length : 0;

    const pick = el(
      'button',
      'ghost',
      selected === null ? 'Kurse wählen' : `Kurse (${selected.length}/${total})`,
    );
    pick.addEventListener('click', () => {
      pickerOpen = !pickerOpen;
      draftSelection = pickerOpen ? new Set(selected ?? []) : null;
      render();
    });
    actionsBar.append(pick);

    const toggle = el('button', 'ghost', showOriginal ? 'Original ausblenden' : 'Original');
    toggle.title = 'Die ursprüngliche CIS-Tabelle ein- oder ausblenden';
    toggle.addEventListener('click', () => {
      showOriginal = !showOriginal;
      actions.setOriginalVisible(showOriginal);
      render();
    });
    actionsBar.append(toggle, el('span', 'status', syncLabel()));

    bar.append(actionsBar);
    return bar;
  }

  function syncLabel(): string {
    const at = state?.status.lastSyncAt;
    if (!at) return 'noch nicht geladen';
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return 'gerade aktualisiert';
    if (minutes < 60) return `vor ${minutes} Min aktualisiert`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `vor ${hours} Std aktualisiert`;
    return `vor ${Math.round(hours / 24)} Tagen aktualisiert`;
  }

  function renderPrompt(): HTMLElement {
    const wrap = el('div', 'prompt');
    const total = state!.snapshot?.events.length ?? 0;
    wrap.append(
      el('h3', undefined, 'Welche Kurse sind deine?'),
      el(
        'p',
        undefined,
        `Der Plan enthält ${total} Termine für deine Zenturie — darunter alle ` +
          `Wahlpflichtfächer und alle Englisch-Gruppen. Wähle deine aus, dann zeigt ` +
          `der Kalender nur noch das, wo du auch hin musst.`,
      ),
    );
    const button = el('button', 'primary', 'Kurse auswählen');
    button.addEventListener('click', () => {
      pickerOpen = true;
      draftSelection = new Set(state!.settings.selectedCourses ?? []);
      render();
    });
    wrap.append(button);
    return wrap;
  }

  function renderChangeStrip(weekEvents: SkedEvent[]): HTMLElement | null {
    const marked = markedEvents();
    const inWeek = weekEvents.filter((e) => marked.has(e.uid));
    if (inWeek.length === 0) return null;

    const wrap = el('div', 'changes');
    const head = el('div', 'changes-head');
    head.append(
      el(
        'span',
        undefined,
        inWeek.length === 1 ? '1 Änderung diese Woche' : `${inWeek.length} Änderungen diese Woche`,
      ),
    );

    const dismiss = el('button', 'dismiss', 'Gelesen');
    dismiss.addEventListener('click', () => void actions.acknowledgeAll());
    head.append(dismiss);
    wrap.append(head);

    const list = el('ul');
    for (const event of inWeek) {
      const item = el('li');
      const when = `${WEEKDAYS_DE[weekdayIndex(dayKey(event.start))]} ${formatTime(event.start)}`;
      item.append(
        el('b', undefined, `${when} ${event.shortTitle || event.title}`),
        document.createTextNode(` — ${describe(event, marked.get(event.uid))}`),
      );
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  /** Prefer sked's own wording; fall back to what the diff observed. */
  function describe(event: SkedEvent, mark: Mark | undefined): string {
    if (mark?.note) return mark.note;
    const change = mark?.change;
    if (!change) return 'vom Plan als geändert markiert';

    switch (change.kind) {
      case 'added':
        return 'neu im Plan';
      case 'cancelled':
        return 'fällt aus';
      case 'uncancelled':
        return 'findet doch statt';
      case 'rescheduled':
        return `verschoben von ${formatTime(change.previous!.start)} auf ${formatTime(event.start)}`;
      case 'moved':
        return `Raum ${change.previous?.room || '—'} → ${event.room || '—'}`;
      case 'renamed':
        return `umbenannt (vorher „${change.previous?.shortTitle ?? change.previous?.summary}")`;
      default:
        return 'geändert';
    }
  }

  function renderGrid(weekEvents: SkedEvent[]): HTMLElement {
    const grid = el('div', 'grid');

    const byDay = new Map<string, SkedEvent[]>();
    for (const event of weekEvents) {
      const key = dayKey(event.start);
      const list = byDay.get(key) ?? [];
      list.push(event);
      byDay.set(key, list);
    }

    // Show the weekend only when something is actually scheduled on it.
    const weekendUsed = [5, 6].some((offset) => byDay.has(addDays(weekCursor!, offset)));
    const dayCount = weekendUsed ? 7 : 5;
    grid.style.setProperty('--days', String(dayCount));

    const today = dayKey(Date.now());
    const marked = markedEvents();

    for (let offset = 0; offset < dayCount; offset++) {
      const key = addDays(weekCursor!, offset);
      const dayEvents = (byDay.get(key) ?? []).sort((a, b) => a.start - b.start);

      const day = el('div', 'day');
      if (key === today) day.classList.add('today');
      if (dayEvents.length > 0) day.classList.add('has-events');

      const head = el('div', 'day-head');
      head.append(
        el('div', 'day-name', WEEKDAYS_DE[offset]!),
        el('div', 'day-date', formatDayMonth(key)),
      );
      day.append(head);

      const body = el('div', 'day-body');
      if (dayEvents.length === 0) {
        body.append(el('div', 'empty', 'frei'));
      } else {
        dayEvents.forEach((event, i) => {
          const previous = dayEvents[i - 1];
          if (previous) {
            const gap = event.start - previous.end;
            // Only worth mentioning if it is long enough to leave campus for.
            if (gap >= 45 * 60000) body.append(el('div', 'gap-note', `${formatDuration(gap)} frei`));
          }
          body.append(renderEvent(event, marked));
        });
      }
      day.append(body);
      grid.append(day);
    }

    return grid;
  }

  function renderEvent(event: SkedEvent, marked: Map<string, Mark>): HTMLElement {
    const card = el('div', 'event');
    const mark = marked.get(event.uid);
    const change = mark?.change;
    const isChanged = marked.has(event.uid);
    if (isChanged) card.classList.add('changed');

    const time = el('div', 'time', `${formatTime(event.start)}–${formatTime(event.end)}`);
    time.append(el('span', 'dur', formatDuration(event.end - event.start)));
    card.append(time);

    const title = el('div', 'title');
    if (event.moduleCode) title.append(el('span', 'code', event.moduleCode));
    title.append(document.createTextNode(event.shortTitle || event.title));
    if (isChanged) title.append(document.createTextNode(' '), el('span', 'tag change', 'geändert'));
    card.append(title);

    const meta = el('div', 'meta');
    if (event.room) meta.append(el('span', event.online ? 'room online' : 'room', event.room));
    if (event.online && !/online/i.test(event.room ?? '')) {
      meta.append(el('span', 'tag online', 'online'));
    }
    if (event.lecturer) meta.append(el('span', undefined, event.lecturer));
    if (meta.childNodes.length > 0) card.append(meta);

    // A room swap is the common case; show it the way a departure board would,
    // with the superseded value struck through beside the one that replaced it.
    // sked's own wording is preferred, then whatever the diff worked out.
    const swapped =
      (mark?.note ? parseRoomSwap(mark.note) : null) ??
      (change?.kind === 'moved' && change.previous?.room && event.room
        ? { from: change.previous.room, to: event.room }
        : null);

    if (swapped) {
      const swap = el('div', 'swap');
      swap.append(el('s', undefined, swapped.from), document.createTextNode(` → ${swapped.to}`));
      card.append(swap);
    } else if (mark?.note) {
      // Not a substitution we recognise — show exactly what the plan said.
      card.append(el('div', 'swap', mark.note));
    }

    if (event.note) card.append(el('div', 'meta', event.note));
    return card;
  }

  /* ---------------------------------------------------------------- *
   * Course picker
   * ---------------------------------------------------------------- */

  function renderPicker(): HTMLElement {
    const wrap = el('div', 'picker');

    const head = el('div', 'picker-head');
    head.append(
      el('h3', undefined, 'Deine Kurse'),
      el('span', 'hint', 'Wo mehrere Gruppen parallel laufen, wähle die, in der du bist.'),
    );
    wrap.append(head);

    const all = state!.snapshot ? buildCourseList(state!.snapshot.events) : [];
    const draft = draftSelection ?? new Set<string>();

    // Every checkbox, by course key, so a change can update siblings and the
    // running total in place rather than triggering a full re-render.
    const inputs = new Map<string, HTMLInputElement>();
    const count = el('div', 'count');
    const events = state!.snapshot?.events ?? [];
    const updateCount = () => {
      const kept = events.filter((e) => draft.has(e.courseKey)).length;
      count.textContent =
        `${draft.size} von ${all.length} Kursen · ${kept} von ${events.length} Terminen`;
    };

    const list = el('div', 'picker-list');
    for (const group of groupCourses(all)) {
      list.append(renderCourseGroup(group, draft, inputs, updateCount));
    }
    wrap.append(list);

    const foot = el('div', 'picker-foot');
    updateCount();
    foot.append(count);

    const selectNone = el('button', 'link', 'Auswahl zurücksetzen');
    selectNone.addEventListener('click', () => {
      draft.clear();
      for (const input of inputs.values()) input.checked = false;
      draftSelection = draft;
      updateCount();
    });
    foot.append(selectNone, el('div', 'spacer'));

    const save = el('button', 'primary', 'Speichern');
    save.addEventListener('click', () => {
      void actions.setSelection([...draft]);
      pickerOpen = false;
      draftSelection = null;
    });
    foot.append(save);
    wrap.append(foot);
    return wrap;
  }

  function renderCourseGroup(
    group: CourseGroup,
    draft: Set<string>,
    inputs: Map<string, HTMLInputElement>,
    onChange: () => void,
  ): HTMLElement {
    const box = el('div', 'course-group');
    const head = el('div', 'group-head');
    head.append(
      el('span', 'kind', KIND_LABELS[group.kind] ?? group.kind),
      el('span', undefined, group.label),
    );
    if (group.courses.length > 1) {
      head.append(el('span', 'pick-one', `${group.courses.length} Gruppen — eine wählen`));
    }
    box.append(head);
    for (const course of group.courses) {
      box.append(renderCourseRow(course, draft, group, inputs, onChange));
    }
    return box;
  }

  function renderCourseRow(
    course: Course,
    draft: Set<string>,
    group: CourseGroup,
    inputs: Map<string, HTMLInputElement>,
    onChange: () => void,
  ): HTMLElement {
    const row = el('label', 'row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = draft.has(course.key);
    inputs.set(course.key, box);

    box.addEventListener('change', () => {
      if (box.checked) {
        draft.add(course.key);
        // Parallel groups are mutually exclusive by construction: they run at
        // the same hour, so ticking one unticks its siblings rather than
        // creating a clash the student then has to spot.
        if (group.courses.length > 1) {
          for (const sibling of group.courses) {
            if (sibling.key === course.key) continue;
            draft.delete(sibling.key);
            const siblingBox = inputs.get(sibling.key);
            if (siblingBox) siblingBox.checked = false;
          }
        }
      } else {
        draft.delete(course.key);
      }
      draftSelection = draft;
      // Deliberately no re-render: rebuilding the tree here would scroll the
      // list back to the top on every tick.
      onChange();
    });

    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', course.section ? course.section : course.label));

    const parts: string[] = [];
    if (!course.section && course.lecturers.length) parts.push(course.lecturers[0]!);
    if (course.rooms.length) parts.push(course.rooms.slice(0, 2).join(', '));
    if (parts.length) main.append(el('div', 'row-sub', parts.join(' · ')));

    row.append(box, main, el('div', 'row-count', `${course.eventCount}×`));
    return row;
  }

  return {
    update(next: CalendarState): void {
      state = next;
      render();
    },
    /** Re-render without new data, so relative timestamps stay honest. */
    refresh(): void {
      if (state) render();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Monday of the week containing `key`, as `YYYY-MM-DD`. */
export function weekStartOf(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 = Sunday. Shift so Monday is the origin.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function formatDayMonth(key: string): string {
  const [, m, d] = key.split('-') as [string, string, string];
  return `${d}.${m}.`;
}

/** "3:00 h" / "45 min" — how long a block actually runs. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h}:${String(m).padStart(2, '0')} h`;
}

export function isoWeekNumber(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  // ISO: week 1 is the one containing the first Thursday.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
}
