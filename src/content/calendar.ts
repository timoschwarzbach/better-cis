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

import {
  buildCourseList,
  filterSelected,
  groupCourses,
  KIND_LABELS,
  type CourseGroup,
} from '../lib/courses.js';
import {
  buildSubscribeUrl,
  googleCalendarUrl,
  normaliseEndpoint,
  webcalUrl,
} from '../lib/ical-link.js';
import { defaultIcalEndpoint, selfHostGuide } from '../lib/site.js';
import { shouldOfferUpdate } from '../lib/version.js';
import {
  applyAnnotations,
  parseRoomSwap,
  planUrls,
  unacknowledgedIds,
  type PlanRef,
  type SkedEvent,
} from '../lib/sked.js';
import { CALENDAR_CSS } from './styles.js';
import type { Settings, StoredAnnotations, SyncStatus, UpdateInfo } from '../lib/storage.js';
import type { Change, Course, Snapshot } from '../lib/types.js';

export interface CalendarState {
  settings: Settings;
  snapshot: Snapshot<SkedEvent> | null;
  changes: Change<SkedEvent>[];
  status: SyncStatus;
  annotations: StoredAnnotations | null;
  /** Result of the last release check, when one has run. */
  update?: UpdateInfo | null;
}

/** Why one occurrence is highlighted, and the best wording available for it. */
interface Mark {
  change?: Change<SkedEvent>;
  /** sked's own description of the change, when the plan published one. */
  note?: string;
  /**
   * Already read.
   *
   * "Gelesen" answers "stop reminding me", not "this never moved" — the room
   * really did change, and the card has to keep saying so until the change
   * ages out of the plan. Only the strip filters on this.
   */
  acknowledged: boolean;
}

export interface CalendarActions {
  /** Persist the student's course selection. */
  setSelection(keys: string[]): unknown;
  /** Mark every detected change as seen. */
  acknowledgeAll(): unknown;
  /** Show or hide the original CIS table. */
  setOriginalVisible(visible: boolean): void;
  /** Point the subscription link at a different worker; null restores the default. */
  setEndpoint(endpoint: string | null): unknown;
  /** Hide the update banner for this version only. */
  dismissUpdate(version: string): unknown;
  /** Stop checking for updates at all. */
  disableUpdateChecks(): unknown;
  /** Remember which link was copied, so a later selection change can be flagged. */
  setLastCopied(url: string): unknown;
}

const WEEKDAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** How long the copy button confirms for. */
const COPY_FEEDBACK_MS = 2000;

export function createCalendar(shadow: ShadowRoot, actions: CalendarActions) {
  let state: CalendarState | null = null;
  /** Monday of the displayed week, as `YYYY-MM-DD` in the plan's time zone. */
  let weekCursor: string | null = null;
  let pickerOpen = false;
  let draftSelection: Set<string> | null = null;
  let showOriginal = false;
  let subscribeOpen = false;
  /**
   * Which feed the dialog is offering.
   *
   * `original` is the plan file straight from CIS. It is worse in every way
   * except one that matters: nothing sits between the student and the
   * university. That trade is theirs to make, so both are on offer.
   *
   * Starts as null — deliberately nothing preselected. Choosing the routed
   * feed is the point at which someone agrees to a third party seeing which
   * courses they take, and an agreement that was already ticked when the box
   * appeared is not one they gave.
   */
  let subscribeSource: 'service' | 'original' | null = null;
  /** Built asynchronously, because encoding the selection compresses it. */
  let subscribeUrl: string | null = null;
  /** What `subscribeUrl` was built from, so a rebuild only happens on a change. */
  let subscribeUrlKey = '';
  /** Why there is no link, when that is not simply "not built yet". */
  let subscribeProblem: string | null = null;
  /**
   * When the link was last copied, for the button's confirmation.
   *
   * Held here rather than on the button because persisting the copy re-renders
   * the whole panel, which would rebuild the button and discard the feedback
   * before anyone saw it.
   */
  let copiedAt: number | null = null;

  /* ---------------------------------------------------------------- *
   * Stable DOM
   *
   * Built once rather than per render. A <dialog> that is removed and
   * recreated loses its place in the top layer, and with it the focus and
   * scroll position of whoever is halfway through the course list — and a
   * background sync re-renders while that list is open. Only the *contents*
   * of these three nodes are rebuilt.
   *
   * <dialog> rather than a positioned overlay because this panel lives on
   * someone else's page: the top layer escapes the host's stacking contexts,
   * transforms and overflow entirely, and brings focus trapping, background
   * inertness and Esc-to-close with it.
   * ---------------------------------------------------------------- */

  const style = document.createElement('style');
  style.textContent = CALENDAR_CSS;
  const panel = el('div', 'panel');
  const modal = document.createElement('dialog');
  modal.className = 'modal';
  shadow.append(style, panel, modal);

  // Esc and the close button both arrive here, so one place resets the flags.
  modal.addEventListener('close', () => {
    if (!pickerOpen && !subscribeOpen) return;
    pickerOpen = false;
    subscribeOpen = false;
    draftSelection = null;
    render();
  });

  // A click whose target is the dialog itself landed on the backdrop: the
  // content fills the box, so anything inside it hits a descendant instead.
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.close();
  });

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
   * The week to land on: this one when the plan covers it, otherwise the next
   * one it does. Shared by the initial render and the "Heute" button, so the
   * button cannot disagree with where the calendar opens — during the holidays
   * both land on the first week back rather than on an empty grid.
   */
  function currentWeek(weeks: string[]): string {
    const thisWeek = weekStartOf(dayKey(Date.now()));
    if (weeks.includes(thisWeek)) return thisWeek;
    return weeks.find((week) => week >= thisWeek) ?? weeks[weeks.length - 1] ?? thisWeek;
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
      if (change.kind === 'removed') continue; // no card left to mark
      marked.set(change.event.uid, {
        change,
        note: change.officialNote,
        acknowledged: change.acknowledged === true,
      });
    }

    const annotations = state.annotations;
    if (annotations && annotations.markedIds.length > 0 && state.snapshot) {
      // Every flag, read or not. Which of them are still unread is recorded
      // per mark below, so the card and the strip can disagree.
      const { flagged } = applyAnnotations(state.snapshot.events, {
        markedIds: new Set(annotations.markedIds),
        notes: annotations.notes,
      });

      const unread = unacknowledgedIds(annotations.markedIds, annotations.acknowledgedIds);
      const skedIdByUid = new Map(state.snapshot.events.map((e) => [e.uid, e.skedId]));

      for (const [uid, note] of flagged) {
        const skedId = skedIdByUid.get(uid);
        const isUnread = skedId !== undefined && unread.has(skedId);
        const existing = marked.get(uid);

        if (existing) {
          // Keep the diff's richer classification, but take sked's wording.
          if (!existing.note && note) existing.note = note.change;
          // Read only once *both* sources have been read: a plan flag that is
          // still unread should keep the strip up on its own.
          existing.acknowledged = existing.acknowledged && !isUnread;
        } else {
          marked.set(uid, {
            ...(note ? { note: note.change } : {}),
            acknowledged: !isUnread,
          });
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

    // Rebuilding the list would otherwise throw it back to the top
    // mid-selection. Toggling a checkbox no longer re-renders at all, but a
    // background sync landing while the picker is open still can.
    const scrollTop = shadow.querySelector('.picker-list')?.scrollTop ?? 0;

    clear(panel);

    const events = visibleEvents();
    const weeks = availableWeeks(events);

    if (weekCursor === null) weekCursor = currentWeek(weeks);

    panel.append(renderBar(weeks));

    const update = renderUpdate();
    if (update) panel.append(update);

    if (state.status.lastError) panel.append(el('div', 'error', state.status.lastError));

    // The prompt stays put while the picker is open over it: swapping in the
    // unfiltered grid behind the modal would show all 233 events for a moment
    // and then hide most of them again.
    if (state.settings.selectedCourses === null) {
      panel.append(renderPrompt());
    } else {
      const weekEvents = events.filter((e) => weekStartOf(dayKey(e.start)) === weekCursor);
      const strip = renderChangeStrip(weekEvents);
      if (strip) panel.append(strip);
      panel.append(renderGrid(weekEvents));
    }

    renderModal(scrollTop);
  }

  /** Bring the dialog in line with the open flags. */
  function renderModal(scrollTop: number): void {
    if (!pickerOpen && !subscribeOpen) {
      if (modal.open) modal.close();
      clear(modal);
      return;
    }

    clear(modal);
    modal.append(pickerOpen ? renderPicker() : renderSubscribe());

    // Only on the transition into open: showModal() on an already-open dialog
    // throws, and re-showing would drop focus back to the top.
    if (!modal.open) modal.showModal();

    const list = modal.querySelector('.picker-list');
    if (list && scrollTop > 0) list.scrollTop = scrollTop;
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
    const today = el('button', 'nav-today', 'Heute');
    today.title = 'Zur aktuellen Woche';
    // Disabled rather than hidden: a button that comes and goes as you page
    // through the term makes the toolbar jump.
    today.disabled = weekCursor === currentWeek(weeks);
    today.addEventListener('click', () => {
      weekCursor = currentWeek(weeks);
      render();
    });

    nav.append(prev, next, today);

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
      if (pickerOpen) subscribeOpen = false;
      render();
    });
    actionsBar.append(pick);

    const subscribe = el('button', 'ghost', 'Abonnieren');
    subscribe.title = 'Diese Kurse als Kalender abonnieren';
    subscribe.addEventListener('click', () => {
      subscribeOpen = !subscribeOpen;
      if (subscribeOpen) {
        pickerOpen = false;
        draftSelection = null;
      }
      render();
    });
    actionsBar.append(subscribe);

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

  /**
   * The "a newer release exists" banner.
   *
   * Nothing updates a sideloaded extension by itself, so this is how a fix
   * reaches anyone. It stays out of the way: one line, two ways to make it go
   * away for good, and no colour that competes with a real change.
   */
  function renderUpdate(): HTMLElement | null {
    const available = state?.update?.available;
    if (
      !available ||
      !shouldOfferUpdate({
        available,
        updateChecks: state!.settings.updateChecks,
        dismissedUpdate: state!.settings.dismissedUpdate,
      })
    ) {
      return null;
    }

    const bar = el('div', 'update');
    bar.append(el('span', 'update-text', `Version ${available.version} ist verfügbar.`));

    const notes = el('a', 'update-link', 'Was ist neu?');
    notes.href = available.url;
    notes.target = '_blank';
    notes.rel = 'noopener noreferrer';
    bar.append(notes, el('div', 'spacer'));

    const later = el('button', 'link', 'Später');
    later.title = 'Bis zur nächsten Version ausblenden';
    later.addEventListener('click', () => {
      void actions.dismissUpdate(available.version);
      render();
    });

    const never = el('button', 'link', 'Nie wieder');
    never.title = 'Nicht mehr nach Updates suchen';
    never.addEventListener('click', () => {
      void actions.disableUpdateChecks();
      render();
    });

    bar.append(later, never);
    return bar;
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
    // Unread only. The cards below stay marked either way — "Gelesen" silences
    // the reminder, it does not claim the timetable went back to normal.
    const inWeek = weekEvents.filter((e) => marked.get(e.uid)?.acknowledged === false);
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

  /** Title bar shared by both modals, including the close affordance. */
  function modalHead(title: string, hint: string): HTMLElement {
    const head = el('div', 'modal-head');
    head.append(el('h3', undefined, title), el('span', 'hint', hint), el('div', 'spacer'));

    const close = el('button', 'icon', '×');
    close.title = 'Schließen';
    close.setAttribute('aria-label', 'Schließen');
    close.addEventListener('click', () => modal.close());

    head.append(close);
    return head;
  }

  function renderPicker(): HTMLElement {
    const wrap = el('div', 'picker');
    wrap.append(
      modalHead('Deine Kurse', 'Wo mehrere Gruppen parallel laufen, wähle die, in der du bist.'),
    );

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
      // Close now rather than waiting for the write to come back around
      // through storage: the selection is already committed to the draft.
      render();
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

  /* ---------------------------------------------------------------- *
   * Calendar subscription
   * ---------------------------------------------------------------- */

  /** The configured worker, falling back to whatever the build shipped with. */
  function endpoint(): string | null {
    return state?.settings.icalEndpoint ?? defaultIcalEndpoint();
  }

  function planRef(): PlanRef | null {
    const { zenturie, semester } = state!.settings;
    return zenturie && semester ? { zenturie, semester } : null;
  }

  /**
   * Rebuild the subscription link when what it encodes has changed.
   *
   * Asynchronous because the selection is compressed into the URL, so the
   * dialog renders first and fills the field when this settles. The key guard
   * is what stops the re-render it triggers from looping.
   */
  function refreshSubscribeUrl(): void {
    const base = endpoint();
    const ref = planRef();
    const selection = state!.settings.selectedCourses;
    const key = JSON.stringify([base, ref, selection]);
    if (key === subscribeUrlKey) return;

    subscribeUrlKey = key;
    subscribeUrl = null;
    subscribeProblem = null;

    if (!ref) {
      subscribeProblem = 'Der Plan ist noch nicht geladen.';
      return;
    }
    if (!base) return;

    void buildSubscribeUrl({ endpoint: base, ref, selection }).then((url) => {
      // A newer request has superseded this one; its result is stale.
      if (subscribeUrlKey !== key) return;
      subscribeUrl = url;
      // A stored endpoint can be unusable — an older build's default, or a
      // value that was valid when it was typed and is not a URL any more.
      subscribeProblem = url ? null : 'Der Endpunkt ist keine gültige Adresse.';
      if (subscribeOpen) render();
    });
  }

  function renderSubscribe(): HTMLElement {
    refreshSubscribeUrl();

    const wrap = el('div', 'subscribe');
    wrap.append(
      modalHead('Kalender abonnieren', 'Zwei Wege — such dir einen aus.'),
    );

    const body = el('div', 'subscribe-body');
    body.append(renderSourceChoice());

    if (subscribeSource === null) {
      body.append(
        el('div', 'subscribe-note', 'Wähle oben, worauf der Link zeigen soll.'),
      );
    } else {
      // The original needs no endpoint, so it stays available even where
      // nobody has deployed a worker.
      const needsEndpoint = subscribeSource === 'service' && !endpoint();
      body.append(needsEndpoint ? renderEndpointPrompt() : renderSubscribeLink());
      body.append(renderSourceNotice());
    }

    wrap.append(body);
    wrap.append(renderEndpointRow());
    return wrap;
  }

  /** The two feeds, with the trade-off stated on each. */
  function renderSourceChoice(): HTMLElement {
    const box = el('div', 'sources');

    const total = state!.snapshot?.events.length ?? 0;
    const mine = state!.snapshot
      ? filterSelected(state!.snapshot.events, state!.settings.selectedCourses).length
      : 0;

    const options: { value: 'service' | 'original'; title: string; sub: string }[] = [
      {
        value: 'service',
        title: 'Nur meine Kurse',
        sub:
          `${mine} von ${total} Terminen, mit lesbaren Titeln, Raum und Dozent. ` +
          'Läuft über unseren Dienst.',
      },
      {
        value: 'original',
        title: 'Original von CIS',
        sub: `Alle ${total} Termine deiner Zenturie, unverändert. Direkt von cis.nordakademie.de.`,
      },
    ];

    for (const option of options) {
      const row = el('label', 'source-row');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'better-cis-source';
      radio.checked = subscribeSource === option.value;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        subscribeSource = option.value;
        render();
      });

      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', option.title), el('div', 'row-sub', option.sub));
      row.append(radio, main);
      box.append(row);
    }

    return box;
  }

  /**
   * What each choice actually means for the student's data.
   *
   * Stated rather than buried: one of these links hands a third party a record
   * of which courses someone takes, every time their phone polls it.
   */
  function renderSourceNotice(): HTMLElement {
    if (subscribeSource === 'original') {
      return el(
        'div',
        'subscribe-notice',
        'Dieser Link geht direkt an cis.nordakademie.de — niemand sitzt dazwischen. ' +
          'Dafür bekommst du den Plan der ganzen Zenturie, und die Titel sind die des ' +
          'Originalfeeds: „WP WP Strat. Marketing-Projekt,Prof. Dr. …,H008".',
      );
    }

    const host = hostOf(endpoint()) ?? 'unseren Dienst';
    const box = el(
      'div',
      'subscribe-notice warn',
      `Achtung: Dieser Link läuft nicht direkt über CIS, sondern über ${host}. ` +
        'Dieser Dienst holt den öffentlichen Plan, filtert ihn auf deine Kurse und ' +
        'schreibt die Termine lesbar um. Deine Kursauswahl steht im Link — der Dienst ' +
        'sieht also bei jedem Abruf deines Kalenders, welche Kurse du belegst, und wer ' +
        'den Link hat, sieht deinen Stundenplan. Wenn du das nicht möchtest, nimm das ' +
        'Original von CIS',
    );

    // Self-hosting is the third answer to the trade-off this notice describes,
    // so it belongs in the notice rather than only in the advanced row.
    const link = guideLink('betreibe den Dienst selbst');
    if (link) box.append(document.createTextNode(' oder '), link);
    box.append(document.createTextNode('.'));

    return box;
  }

  /**
   * Link to the self-hosting guide, or nothing when none is configured.
   *
   * Opened by the student rather than fetched by the extension, so it needs no
   * host permission — see `selfHostGuide`.
   */
  function guideLink(text: string): HTMLAnchorElement | null {
    const guide = selfHostGuide();
    if (!guide) return null;

    const link = el('a', 'guide-link', text);
    link.href = guide;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  /** Shown when nobody has deployed a worker and none is configured yet. */
  function renderEndpointPrompt(): HTMLElement {
    const box = el('div', 'subscribe-empty');
    const text = el(
      'p',
      undefined,
      'Dafür wird ein Endpunkt gebraucht, der den Plan gefiltert ausliefert. ' +
        'Du kannst in ein paar Minuten einen eigenen als Cloudflare Worker ' +
        'betreiben — kostenlos, ohne Datenbank, ohne Konfiguration — und die ' +
        'Adresse unten eintragen.',
    );

    const link = guideLink('Anleitung auf GitHub');
    if (link) text.append(document.createTextNode(' '), link);

    box.append(text);
    return box;
  }

  /** The link currently on offer, which is only async for the service one. */
  function activeSubscribeUrl(): string | null {
    if (subscribeSource === 'original') {
      const ref = planRef();
      return ref ? planUrls(ref).ics : null;
    }
    return subscribeUrl;
  }

  function renderSubscribeLink(): HTMLElement {
    const box = el('div', 'subscribe-link');
    const url = activeSubscribeUrl();

    const field = document.createElement('input');
    field.type = 'text';
    field.readOnly = true;
    field.className = 'url';
    field.value = url ?? subscribeProblem ?? 'wird erzeugt …';
    field.addEventListener('focus', () => field.select());
    box.append(field);

    const row = el('div', 'subscribe-actions');

    const confirming = copiedAt !== null && Date.now() - copiedAt < COPY_FEEDBACK_MS;
    const copy = el('button', 'primary', confirming ? 'Kopiert' : 'Kopieren');
    copy.disabled = url === null;
    copy.addEventListener('click', () => {
      if (!url) return;
      void copyToClipboard(url, field).then(() => {
        copiedAt = Date.now();
        // Re-renders the panel, which is why the confirmation lives in state.
        void actions.setLastCopied(url);
        render();
        setTimeout(() => {
          copiedAt = null;
          if (subscribeOpen) render();
        }, COPY_FEEDBACK_MS);
      });
    });
    row.append(copy);

    if (url) {
      const google = el('a', 'button-link', 'Google Kalender');
      google.href = googleCalendarUrl(url);
      google.target = '_blank';
      google.rel = 'noopener noreferrer';
      row.append(google);

      // webcal: is what makes Apple Calendar and Outlook offer to *subscribe*
      // rather than import a one-off copy that never updates.
      const webcal = el('a', 'button-link', 'Apple / Outlook');
      webcal.href = webcalUrl(url);
      row.append(webcal);
    }

    box.append(row);

    // Only meaningful for the service link, and only against one from the same
    // endpoint: the original never changes, and a link copied from a different
    // endpoint differs for a reason that has nothing to do with the selection.
    const copied = state!.settings.icalLastCopied;
    const base = normaliseEndpoint(endpoint() ?? '');
    if (
      subscribeSource === 'service' &&
      url &&
      copied &&
      copied !== url &&
      base &&
      copied.startsWith(base)
    ) {
      box.append(
        el(
          'div',
          'subscribe-warning',
          'Deine Kursauswahl hat sich geändert. Der alte Link liefert weiter die alten ' +
            'Kurse — kopiere den neuen und ersetze das Abo in deiner Kalender-App.',
        ),
      );
    }

    // The privacy half of this used to live here; it is in the notice below
    // now, where it belongs to whichever source is actually selected.
    box.append(
      el('div', 'subscribe-note', 'Kalender-Apps fragen den Link etwa stündlich ab.'),
    );
    return box;
  }

  function renderEndpointRow(): HTMLElement {
    const details = el('details', 'advanced');
    // Open by default while there is nothing to show, since entering an
    // endpoint is then the only thing left to do here.
    details.open = !endpoint();
    details.append(el('summary', undefined, 'Erweitert: eigener Endpunkt'));

    const row = el('div', 'advanced-row');
    const field = document.createElement('input');
    field.type = 'url';
    field.className = 'url';
    field.placeholder = defaultIcalEndpoint() ?? 'https://…workers.dev';
    field.value = state!.settings.icalEndpoint ?? '';
    row.append(field);

    // Not .ghost: that is the toolbar's white-on-navy button, which would be
    // invisible against this panel.
    const save = el('button', 'secondary', 'Übernehmen');
    const status = el('span', 'hint');

    const apply = () => {
      const raw = field.value.trim();
      if (raw === '') {
        // An empty field means "go back to the endpoint this build ships with",
        // which is the only way to undo a custom one.
        void actions.setEndpoint(null);
        render();
        return;
      }
      const normalised = normaliseEndpoint(raw);
      if (!normalised) {
        status.textContent = 'Das sieht nicht nach einer Adresse aus.';
        return;
      }
      void actions.setEndpoint(normalised);
      render();
    };

    save.addEventListener('click', apply);
    // Enter is what anyone typing into a single field will reach for, and
    // there is no form here to do it for us.
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      apply();
    });
    row.append(save);
    details.append(row, status);

    const guide = guideLink('Eigene Instanz auf Cloudflare betreiben');
    if (guide) {
      const hint = el('p', 'advanced-hint');
      hint.append(
        document.createTextNode(
          'Der Code liegt im Ordner worker/ und läuft als Cloudflare Worker — ' +
            'kostenlos, ohne Datenbank, ohne Bindings. ',
        ),
        guide,
      );
      details.append(hint);
    }

    return details;
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

/**
 * Copy text, with the old selection-based route as a fallback.
 *
 * `navigator.clipboard` is the right API but it rejects when the document is
 * not focused, which happens often enough in a content script on someone
 * else's page. The fallback is deprecated and works everywhere.
 */
async function copyToClipboard(value: string, field: HTMLInputElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    field.focus();
    field.select();
    document.execCommand('copy');
  }
}

/**
 * Hostname of an endpoint, for naming the third party in the warning. Saying
 * "läuft über cis-ical.example.workers.dev" is a statement someone can act on;
 * "läuft über unseren Dienst" is not.
 */
function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
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
