/**
 * Background sync.
 *
 * Pulls the two plan files on a timer, works out what changed, and keeps a
 * badge count of changes affecting the student's own courses. The pages never
 * fetch anything themselves: doing it here keeps the work off the page's
 * critical path and out of reach of the site's CSP.
 */

import { api } from '../lib/browser.js';
import { parseIcs } from '../lib/ics.js';
import {
  applyAnnotations,
  enrichEvents,
  parsePlanAnnotations,
  planUrls,
  retainAcknowledged,
  type SkedEvent,
} from '../lib/sked.js';
import { diffSnapshots, mergeChanges } from '../lib/diff.js';
import {
  acknowledge,
  acknowledgeAll,
  getAnnotations,
  getChanges,
  getSettings,
  getSnapshot,
  getSyncStatus,
  getUpdate,
  setAnnotations,
  setChanges,
  setSettings,
  setSnapshot,
  setSyncStatus,
  setUpdate,
  type Settings,
} from '../lib/storage.js';
import { releaseFeed } from '../lib/site.js';
import { isNewer, parseLatestRelease } from '../lib/version.js';
import type { Change, Snapshot } from '../lib/types.js';

const ALARM_NAME = 'better-cis-refresh';
/** A plan this large is an error page, not a calendar. */
const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

type SkedSnapshot = Snapshot<SkedEvent>;
type SkedChange = Change<SkedEvent>;

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export class SyncError extends Error {
  constructor(
    message: string,
    /** True when retrying later might succeed (network, 5xx, timeout). */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

async function fetchText(url: string, what: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    throw new SyncError(
      aborted
        ? `The ${what} did not respond within 30 seconds.`
        : `Could not reach the ${what}. Check your connection or the VPN.`,
      true,
    );
  }
  clearTimeout(timer);

  if (response.status === 404) {
    throw new SyncError(
      `No plan found at ${url}. The study group or semester is probably wrong — ` +
        `check them in the extension settings.`,
      false,
    );
  }
  if (!response.ok) {
    throw new SyncError(`The ${what} returned HTTP ${response.status}.`, response.status >= 500);
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    throw new SyncError(`The ${what} is implausibly large; refusing to parse it.`, false);
  }

  // `Response.text()` always decodes as UTF-8 and ignores the Content-Type
  // charset. That is exactly what is wanted here: the server labels these
  // files ISO-8859-15 while actually serving UTF-8, which is why the plan
  // renders "VeranstaltungsplanÂ" in the browser but comes out clean here.
  const text = await response.text();
  if (text.length > MAX_BYTES) {
    throw new SyncError(`The ${what} is implausibly large; refusing to parse it.`, false);
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

export interface SyncOutcome {
  ok: boolean;
  error?: string;
  newChanges?: number;
  eventCount?: number;
  warnings?: string[];
  /** Set when the annotation fetch failed but the calendar itself is fine. */
  degraded?: string;
}

let inFlight: Promise<SyncOutcome> | null = null;

/** Refresh the plan. Concurrent callers share one fetch. */
export function sync(): Promise<SyncOutcome> {
  inFlight ??= runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function resolvePlan(settings: Settings): { ics: string; html: string } | null {
  if (!settings.zenturie || !settings.semester) return null;
  return planUrls({ zenturie: settings.zenturie, semester: settings.semester });
}

async function runSync(): Promise<SyncOutcome> {
  const settings = await getSettings();
  const urls = resolvePlan(settings);
  if (!urls) {
    return {
      ok: false,
      error: 'No study group configured yet. Open a CIS page and it will be detected automatically.',
    };
  }

  let icsText: string;
  try {
    icsText = await fetchText(urls.ics, 'timetable feed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setSyncStatus({ lastError: message });
    await updateBadge();
    return { ok: false, error: message };
  }

  if (!/BEGIN:VCALENDAR/i.test(icsText)) {
    const message = 'The feed did not contain a calendar. The plan file may have been moved.';
    await setSyncStatus({ lastError: message });
    await updateBadge();
    return { ok: false, error: message };
  }

  const now = Date.now();
  const parsed = parseIcs(icsText, { defaultTimeZone: settings.timeZone });
  const events = enrichEvents(parsed.events);

  // The annotations are a bonus, not a dependency. If the HTML plan is
  // unavailable the calendar must still refresh, so this failure is reported
  // as degraded rather than fatal.
  let degraded: string | undefined;
  let flagged = new Map<string, { change: string } | undefined>();
  if (settings.useHtmlAnnotations) {
    try {
      const html = await fetchText(urls.html, 'plan annotations');
      const annotations = parsePlanAnnotations(html);

      // Dismissals have to survive the refresh: the plan keeps flagging an
      // event for as long as it considers the change recent, so dropping them
      // here would bring every "Gelesen" mark back within the half hour.
      // Pruned to what is still flagged, so the list cannot grow forever.
      const previousAnnotations = await getAnnotations();
      const acknowledgedIds = retainAcknowledged(
        annotations.markedIds,
        previousAnnotations?.acknowledgedIds ?? [],
      );

      await setAnnotations({
        markedIds: [...annotations.markedIds],
        notes: annotations.notes,
        acknowledgedIds,
        ...(annotations.generatedAt ? { generatedAt: annotations.generatedAt } : {}),
      });
      flagged = applyAnnotations(events, annotations).flagged;
    } catch (error) {
      degraded = error instanceof Error ? error.message : String(error);
    }
  }

  const next: SkedSnapshot = { fetchedAt: now, feedUrl: urls.ics, events };
  const previous = (await getSnapshot()) as SkedSnapshot | null;
  const { changes: detected, suspect } = diffSnapshots(previous, next, { now });

  if (suspect) {
    // Keep the old snapshot: overwriting it would make the suspect download the
    // new baseline, and the real changes would never be reported.
    await setSyncStatus({ lastError: suspect });
    await updateBadge();
    return { ok: false, error: suspect, warnings: parsed.warnings };
  }

  // Attach sked's own wording where it flagged the same event, so the UI can
  // say "A103 ersetzt durch A004" rather than only "room changed".
  const annotated: SkedChange[] = detected.map((change) => {
    const note = flagged.get(change.event.uid);
    return note ? { ...change, officialNote: note.change } : change;
  });

  const merged = mergeChanges((await getChanges()) as SkedChange[], annotated, now);
  await setSnapshot(next);
  await setChanges(merged);
  await setSyncStatus({ lastSyncAt: now, lastError: null });
  await updateBadge();

  // Piggybacks on the sync rather than running its own alarm, and is throttled
  // to once a day inside. Awaited but never allowed to throw: a release feed
  // being down has nothing to do with whether the timetable loaded.
  await checkForUpdate(settings, now);

  return {
    ok: true,
    newChanges: detected.length,
    eventCount: events.length,
    warnings: parsed.warnings,
    ...(degraded ? { degraded } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Update check
 * ------------------------------------------------------------------ */

/** Nothing about a release is urgent enough to ask more than once a day. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Ask whether a newer release exists.
 *
 * This is the only request the extension makes to anywhere other than the
 * campus system, which is why it is switched off completely — no request at
 * all — rather than merely hidden when the student says "Nie wieder".
 */
async function checkForUpdate(settings: Settings, now: number): Promise<void> {
  const feed = releaseFeed();
  if (!feed || !settings.updateChecks) return;

  const stored = await getUpdate();
  if (stored && now - stored.checkedAt < UPDATE_CHECK_INTERVAL_MS) return;

  try {
    const body = await fetchText(feed, 'release feed');
    const release = parseLatestRelease(body);
    const current = api.runtime.getManifest().version;

    await setUpdate({
      checkedAt: now,
      available: release && isNewer(release.version, current) ? release : null,
    });
  } catch {
    // Record the attempt anyway, so an unreachable feed is retried tomorrow
    // rather than on every single sync.
    await setUpdate({ checkedAt: now, available: stored?.available ?? null });
  }
}

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

async function updateBadge(): Promise<void> {
  const [settings, changes, status] = await Promise.all([
    getSettings(),
    getChanges(),
    getSyncStatus(),
  ]);

  const action =
    api.action ?? (api as unknown as { browserAction?: typeof chrome.action }).browserAction;
  if (!action) return;

  if (status.lastError) {
    await action.setBadgeText({ text: '!' });
    await action.setBadgeBackgroundColor({ color: '#b3261e' });
    return;
  }

  // Only changes to the student's own courses are worth interrupting them over:
  // sixteen electives run in one slot, and fifteen of them are someone else's.
  const selected = settings.selectedCourses;
  const relevant = changes.filter(
    (c) => !c.acknowledged && (selected === null || selected.includes(c.courseKey)),
  );

  await action.setBadgeText({ text: relevant.length > 0 ? String(relevant.length) : '' });
  await action.setBadgeBackgroundColor({ color: '#1a73e8' });
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

async function rescheduleAlarm(): Promise<void> {
  const { refreshIntervalMinutes } = await getSettings();
  await api.alarms.clear(ALARM_NAME);
  api.alarms.create(ALARM_NAME, {
    // Browsers clamp sub-minute periods; keep well above that floor.
    periodInMinutes: Math.max(15, refreshIntervalMinutes),
  });
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void sync();
});

api.runtime.onInstalled.addListener(() => {
  void rescheduleAlarm();
  void sync();
});

api.runtime.onStartup.addListener(() => {
  void rescheduleAlarm();
  void sync();
});

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

export type Request =
  | { type: 'sync' }
  | { type: 'getState' }
  | { type: 'setSettings'; patch: Partial<Settings> }
  | { type: 'discoveredPlan'; zenturie: string; semester: string }
  | { type: 'acknowledgeAll' }
  | { type: 'acknowledge'; ids: string[] };

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'sync':
      return sync();

    case 'getState': {
      const [settings, snapshot, changes, status, annotations, update] = await Promise.all([
        getSettings(),
        getSnapshot(),
        getChanges(),
        getSyncStatus(),
        getAnnotations(),
        getUpdate(),
      ]);
      return { settings, snapshot, changes, status, annotations, update };
    }

    case 'discoveredPlan': {
      // A content script found the plan link on a CIS page. Adopt it only if
      // nothing is configured yet, so a manual override is never overwritten.
      const settings = await getSettings();
      if (settings.zenturie === request.zenturie && settings.semester === request.semester) {
        return { ok: true, changed: false };
      }
      if (settings.zenturie && settings.semester) return { ok: true, changed: false };

      await setSettings({ zenturie: request.zenturie, semester: request.semester });
      void sync();
      return { ok: true, changed: true };
    }

    case 'setSettings': {
      const previous = await getSettings();
      const settings = await setSettings(request.patch);

      // A different plan is a different calendar; the change history described
      // the old one and would otherwise read as a term-wide upheaval.
      const planChanged =
        previous.zenturie !== settings.zenturie || previous.semester !== settings.semester;
      if (planChanged) {
        await setChanges([]);
        await setSyncStatus({ lastError: null, lastSyncAt: null });
      }
      if (previous.refreshIntervalMinutes !== settings.refreshIntervalMinutes) {
        await rescheduleAlarm();
      }
      await updateBadge();

      if (planChanged && settings.zenturie && settings.semester) return sync();
      return { ok: true };
    }

    case 'acknowledgeAll':
      await acknowledgeAll();
      await updateBadge();
      return { ok: true };

    case 'acknowledge':
      await acknowledge(request.ids);
      await updateBadge();
      return { ok: true };
  }
}

api.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handle(request).then(sendResponse, (error: unknown) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  // Keeps the message channel open for the async response above.
  return true;
});
