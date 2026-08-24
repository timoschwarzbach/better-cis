/**
 * Styles for the injected calendar.
 *
 * Delivered as a string into a shadow root rather than as a stylesheet in the
 * manifest: the CIS pages carry Bootstrap plus TYPO3's own rules, and a shadow
 * boundary is the only reliable way to stop `table.contenttable` and friends
 * from reaching in.
 *
 * The palette is sampled from the live site — navy #00387A is the header, and
 * #E6742B is the one accent the site already uses — so the panel reads as part
 * of CIS. Orange is reserved exclusively for changes; nothing else may use it,
 * which is what makes a change impossible to miss.
 */

export const CALENDAR_CSS = /* css */ `
:host {
  --navy: #00387a;
  --navy-deep: #003366;
  --ink: #1a1a1a;
  --ink-soft: #5b6470;
  --ink-faint: #8b95a1;
  --paper: #ffffff;
  --paper-sunk: #f7f9fc;
  --rail: #dde5ee;
  --rail-strong: #c3d0df;
  --accent: #e6742b;
  --accent-wash: #fdf1e8;
  /* Today's column head. A tint rather than --navy itself: see .day.today. */
  --today-wash: #dce9f8;
  --online: #0a5aab;

  --gap: 8px;
  --radius: 3px;

  display: block;
  font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.45;
  /* Times must align down each column for the board to be scannable. */
  font-variant-numeric: tabular-nums;
}

*, *::before, *::after { box-sizing: border-box; }

.panel {
  border: 1px solid var(--rail);
  border-radius: var(--radius);
  background: var(--paper);
  overflow: hidden;
}

/* ---------------------------------------------------------------- *
 * Header
 * ---------------------------------------------------------------- */

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--navy);
  color: #fff;
}

.week {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.week-no {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.72;
  white-space: nowrap;
}

.week-range { font-size: 15px; font-weight: 600; white-space: nowrap; }

.nav { display: flex; gap: 4px; }

button {
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  border-radius: var(--radius);
  border: 1px solid transparent;
  transition: background-color 120ms ease, border-color 120ms ease;
}

button:disabled { opacity: 0.35; cursor: default; }

.nav button {
  width: 30px;
  height: 28px;
  line-height: 1;
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.22);
  color: #fff;
  font-size: 15px;
}
.nav button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.24); }

/* The arrows are square; this one has to fit a word. */
.nav button.nav-today {
  width: auto;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 600;
}

.spacer { flex: 1 1 auto; }

.bar-actions { display: flex; align-items: center; gap: 8px; }

.ghost {
  padding: 5px 11px;
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.28);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.24); }

.status {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
  white-space: nowrap;
}

:is(button, [tabindex]):focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* ---------------------------------------------------------------- *
 * Change strip — the one place orange is allowed
 * ---------------------------------------------------------------- */

.changes {
  border-bottom: 1px solid var(--rail);
  background: var(--accent-wash);
  padding: 9px 14px;
}

.changes-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #a8501a;
}

.changes ul { margin: 6px 0 0; padding: 0; list-style: none; display: grid; gap: 3px; }
.changes li { font-size: 13px; color: #6b3a12; }
.changes li b { font-weight: 600; }

.dismiss {
  margin-left: auto;
  padding: 3px 9px;
  font-size: 12px;
  font-weight: 600;
  background: transparent;
  border-color: #e0b795;
  color: #a8501a;
}
.dismiss:hover { background: #f8e3d2; }

/* ---------------------------------------------------------------- *
 * Week grid
 * ---------------------------------------------------------------- */

.grid {
  display: grid;
  grid-template-columns: repeat(var(--days, 5), minmax(0, 1fr));
  gap: 1px;
  background: var(--rail);
}

.day {
  background-image: url("https://www.nordakademie.de/hs-fs/hubfs/Website%20Relaunch%202022/Header%20und%20Hintergrundbilder/TEAM_NAK_2025/2024_Sauer_Joachim_ohne_web_DSC7615.jpg");
  background-size: cover;
  display: flex;
  flex-direction: column;
  min-height: 120px;
}

.day-head {
  padding: 7px 10px 6px;
  border-bottom: 2px solid var(--rail);
  background: var(--paper-sunk);
}

.day-name {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--navy);
}

.day-date { font-size: 12px; color: var(--ink-soft); }

/* Today was filled with --navy, the same colour as the toolbar sitting
   directly above the grid. Where today is the leftmost column the two blocks
   met and read as one shape, so the bar appeared to grow a foot (#2). A tint
   marks the day without competing with the toolbar; the heavier border is what
   carries the emphasis the fill used to. */
.day.today .day-head {
  background: var(--today-wash);
  border-bottom-color: var(--navy);
}
.day.today .day-date { color: var(--navy); font-weight: 600; }

.day-body { padding: var(--gap); display: flex; flex-direction: column; gap: 6px; flex: 1; }

.empty {
  margin: auto;
  padding: 14px 4px;
  font-size: 12px;
  color: var(--ink-faint);
}

/* ---------------------------------------------------------------- *
 * Event card
 * ---------------------------------------------------------------- */

.event {
  position: relative;
  padding: 8px 10px 8px 11px;
  border: 1px solid var(--rail);
  border-left: 3px solid var(--rail-strong);
  border-radius: var(--radius);
  background: var(--paper);
}

.event .time {
  font-size: 13px;
  font-weight: 700;
  color: var(--navy);
  white-space: nowrap;
}

.event .dur { font-weight: 400; font-size: 11px; color: var(--ink-faint); margin-left: 5px; }

.event .title {
  margin-top: 1px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.event .meta {
  margin-top: 3px;
  font-size: 12px;
  color: var(--ink-soft);
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
}

.event .room { font-weight: 600; color: var(--ink); }
.event .room.online { color: var(--online); }

.event .code {
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--ink-faint);
}

/* A changed event: accent rule, and the old value shown struck beside the new. */
.event.changed { border-left-color: var(--accent); background: var(--accent-wash); }

.event .swap { color: #a8501a; font-weight: 600; }
.event .swap s { font-weight: 400; opacity: 0.65; text-decoration-thickness: 1px; }

.tag {
  display: inline-block;
  padding: 0 5px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  vertical-align: 1px;
}
.tag.change { background: var(--accent); color: #fff; }
.tag.online { background: #e4eefb; color: var(--online); }

/* The interval between two classes — what a commuter actually wants to know. */
.gap-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  font-size: 11px;
  color: var(--ink-faint);
}
.gap-note::before, .gap-note::after {
  content: "";
  flex: 1;
  border-top: 1px dashed var(--rail-strong);
}

/* ---------------------------------------------------------------- *
 * Onboarding + course picker
 * ---------------------------------------------------------------- */

.prompt { padding: 22px 18px; text-align: center; }
.prompt h3 { margin: 0 0 5px; font-size: 16px; font-weight: 700; color: var(--navy); }
.prompt p { margin: 0 auto 14px; max-width: 46ch; font-size: 13px; color: var(--ink-soft); }

.primary {
  padding: 8px 16px;
  background: var(--navy);
  border-color: var(--navy);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.primary:hover:not(:disabled) { background: var(--navy-deep); }

/* ---------------------------------------------------------------- *
 * Modal shell
 *
 * The dialog is in the top layer, so nothing on the host page can stack
 * above it or clip it — which is the whole reason for using <dialog>
 * rather than a positioned overlay on a page we do not control.
 * ---------------------------------------------------------------- */

.modal {
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--paper-sunk);
  color: var(--ink);
  width: min(680px, calc(100vw - 32px));
  max-height: min(84vh, 780px);
  /* The header and footer stay put; the list inside does the scrolling. */
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 24, 56, 0.32);
}
/* Scoped to [open]: an unscoped display would defeat the user agent's own
   "dialog:not([open]) { display: none }" and leave the modal on screen. */
.modal[open] { display: flex; flex-direction: column; }
.modal::backdrop { background: rgba(0, 24, 56, 0.42); }

.modal > * {
  display: flex;
  flex-direction: column;
  /* Without min-height:0 a flex child refuses to shrink below its content,
     and the inner list scrolls the whole dialog instead of itself. */
  min-height: 0;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: none;
  padding: 11px 14px;
  border-bottom: 1px solid var(--rail);
  background: var(--paper);
}
.modal-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
.modal-head .hint { font-size: 12px; color: var(--ink-soft); max-width: 46ch; }

button.icon {
  flex: none;
  width: 26px;
  height: 26px;
  line-height: 1;
  padding: 0;
  border-color: var(--rail-strong);
  background: var(--paper);
  color: var(--ink-soft);
  font-size: 17px;
}
button.icon:hover { background: var(--paper-sunk); color: var(--ink); }

.picker-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 14px 14px;
  display: grid;
  align-content: start;
  /* Load-bearing. The list used to be sized by max-height, so its own height
     was content-derived; inside the modal it is a flex child with a definite
     height instead, and "auto" tracks then size themselves against that
     available space — crushing 25 course groups into the visible box rather
     than overflowing it. min-content pins each row to its content, so the
     container scrolls. */
  grid-auto-rows: min-content;
  gap: 10px;
}

.course-group {
  border: 1px solid var(--rail);
  border-radius: var(--radius);
  background: var(--paper);
  overflow: hidden;
}

.course-group > .group-head {
  padding: 6px 11px;
  border-bottom: 1px solid var(--rail);
  background: var(--paper-sunk);
  font-size: 12px;
  font-weight: 700;
  color: var(--navy);
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.group-head .kind {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
}
/* Say out loud when a course forces a choice between parallel groups. */
.group-head .pick-one {
  margin-left: auto;
  font-weight: 600;
  font-size: 11px;
  color: var(--accent);
  text-transform: none;
  letter-spacing: 0;
}

label.row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 11px;
  cursor: pointer;
}
label.row + label.row { border-top: 1px solid var(--rail); }
label.row:hover { background: var(--paper-sunk); }
label.row input { margin: 3px 0 0; flex: none; width: 15px; height: 15px; accent-color: var(--navy); }

.row-main { min-width: 0; }
.row-title { font-size: 13px; font-weight: 600; }
.row-sub { font-size: 12px; color: var(--ink-soft); }
.row-count { margin-left: auto; font-size: 11px; color: var(--ink-faint); white-space: nowrap; }

.picker-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  padding: 10px 14px;
  border-top: 1px solid var(--rail);
  background: var(--paper);
}
.picker-foot .count { font-size: 12px; color: var(--ink-soft); }

.link {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--navy);
  text-decoration: underline;
}

.error {
  padding: 10px 14px;
  border-bottom: 1px solid #f0c9c4;
  background: #fdf0ee;
  font-size: 13px;
  color: #8c2f22;
}

/* Update banner. Deliberately quiet — it is housekeeping, not a timetable
   change, so it stays away from --accent and reads as one calm line. */
.update {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 14px;
  border-bottom: 1px solid var(--rail);
  background: var(--paper-sunk);
  font-size: 12px;
  color: var(--ink-soft);
}
.update-text { color: var(--ink); }
.update-link { color: var(--navy); font-weight: 600; text-decoration: underline; }
.update .link { font-size: 12px; font-weight: 600; color: var(--ink-soft); }
.update .link:hover { color: var(--navy); }

/* ---------------------------------------------------------------- *
 * Subscription dialog — shares the modal shell and header with the
 * picker, so both toolbar buttons open the same kind of thing
 * ---------------------------------------------------------------- */

.subscribe-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: grid;
  align-content: start;
  /* Same definite-height trap as .picker-list. */
  grid-auto-rows: min-content;
  gap: 12px;
}

.subscribe-link, .subscribe-empty { display: grid; gap: 10px; }

/* Which feed to subscribe to. Radios rather than a toggle: the two are not
   more/less of one thing, they are different sources with different costs. */
.sources {
  display: grid;
  gap: 1px;
  border: 1px solid var(--rail);
  border-radius: var(--radius);
  background: var(--rail);
  overflow: hidden;
}

label.source-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 11px;
  background: var(--paper);
  cursor: pointer;
}
label.source-row:hover { background: var(--paper-sunk); }
label.source-row input {
  margin: 2px 0 0;
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--navy);
}
label.source-row:has(input:checked) { background: var(--paper-sunk); }
label.source-row:has(input:checked) .row-title { color: var(--navy); }
.subscribe-empty p { margin: 0; font-size: 13px; color: var(--ink-soft); max-width: 62ch; }

input.url {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--rail-strong);
  border-radius: var(--radius);
  background: var(--paper);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--ink);
  /* The link is long by design; let it scroll rather than wrap the layout. */
  text-overflow: ellipsis;
}
input.url:focus { outline: 2px solid var(--navy); outline-offset: -1px; }

.subscribe-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* Secondary action on a light surface.
   Note this is *not* .ghost: that one is drawn for the navy toolbar, in white
   on a translucent white background, and is invisible down here. */
.secondary,
.button-link {
  display: inline-flex;
  align-items: center;
  padding: 5px 11px;
  border: 1px solid var(--rail-strong);
  border-radius: var(--radius);
  background: var(--paper);
  font-size: 13px;
  font-weight: 600;
  color: var(--navy);
  text-decoration: none;
  white-space: nowrap;
}
.secondary:hover:not(:disabled),
.button-link:hover { background: var(--paper-sunk); }

.subscribe-note { font-size: 12px; color: var(--ink-faint); }

/* What the chosen link actually does with the student's data. The warn
   variant is the one that hands a third party a record of their courses. */
.subscribe-notice {
  padding: 9px 11px;
  border: 1px solid var(--rail);
  border-left: 3px solid var(--rail-strong);
  border-radius: var(--radius);
  background: var(--paper);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-soft);
}
.subscribe-notice.warn {
  border-color: #f0d8bf;
  border-left-color: var(--accent);
  background: var(--accent-wash);
  color: var(--ink);
}

/* The one place --accent is right outside the change feed: this *is* a
   change, and it is the failure mode of putting the selection in the URL. */
.subscribe-warning {
  padding: 8px 11px;
  border-left: 3px solid var(--accent);
  background: var(--accent-wash);
  font-size: 12px;
  color: var(--ink);
}

.advanced {
  flex: none;
  border-top: 1px solid var(--rail);
  padding: 10px 14px;
  background: var(--paper);
}
.advanced > summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--navy);
}
.advanced .hint { font-size: 12px; color: var(--ink-soft); }
.advanced-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-soft);
  max-width: 62ch;
}

/* Inline link inside running prose, in both the notice and the advanced row. */
.guide-link { color: var(--navy); font-weight: 600; text-decoration: underline; }
.advanced-row { display: flex; align-items: center; gap: 8px; margin: 9px 0 4px; }
.advanced-row input.url { font-size: 12px; }

/* ---------------------------------------------------------------- *
 * Narrow screens — day columns stop working well below ~880px
 * ---------------------------------------------------------------- */

@media (max-width: 880px) {
  .grid { grid-template-columns: 1fr; }
  .day { min-height: 0; }
  .day-head { display: flex; align-items: baseline; gap: 8px; border-bottom-width: 1px; }
  .day:not(.has-events) { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
