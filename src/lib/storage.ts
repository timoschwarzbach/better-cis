/**
 * Persistence layer.
 *
 * Everything lives in `storage.local` rather than `storage.sync`. Sync would be
 * pleasant for carrying course selections between devices, but it caps items at
 * 8 KB and the whole area at 100 KB — a term's worth of events blows through
 * that, and a partially-written selection is worse than an unsynced one.
 */

import { api } from './browser.js';
import type { Change, Snapshot } from './types.js';

export interface Settings {
  /**
   * Study group ("Zenturie") and semester, which together name the plan files.
   * Discovered automatically from the plan link the CIS pages already render,
   * so a student normally never types these.
   */
  zenturie: string | null;
  semester: string | null;
  /**
   * Course keys the user ticked. `null` means "not chosen yet", which the UI
   * shows as an onboarding prompt — distinct from an empty array, which is a
   * deliberate "show me nothing".
   */
  selectedCourses: string[] | null;
  /** Hide unselected courses entirely, or just fade them. */
  hideUnselected: boolean;
  /** Minutes between background refreshes. */
  refreshIntervalMinutes: number;
  /** Replace the page's own calendar rather than sitting alongside it. */
  replaceNativeCalendar: boolean;
  /** Also fetch the HTML plan for sked's own change annotations. */
  useHtmlAnnotations: boolean;
  /** IANA zone used for floating times in the feed. */
  timeZone: string;
}

export const DEFAULT_SETTINGS: Settings = {
  zenturie: null,
  semester: null,
  selectedCourses: null,
  hideUnselected: true,
  // The feed advertises REFRESH-INTERVAL:PT10M, but browsers throttle
  // background alarms and a timetable does not change by the minute.
  refreshIntervalMinutes: 30,
  replaceNativeCalendar: true,
  useHtmlAnnotations: true,
  timeZone: 'Europe/Berlin',
};

const KEYS = {
  settings: 'settings',
  snapshot: 'snapshot',
  changes: 'changes',
  annotations: 'annotations',
  lastError: 'lastError',
  lastSyncAt: 'lastSyncAt',
} as const;

/**
 * sked's own change flags, as read from the HTML plan. Stored separately from
 * the snapshot because they describe the *plan*, not our view of it: they
 * survive independently of whether we have seen two snapshots yet.
 */
export interface StoredAnnotations {
  /** sked ids the plan marks as changed. A Set does not survive storage. */
  markedIds: string[];
  notes: { date: string; time: string; course: string; change: string }[];
  generatedAt?: string;
}

export async function getAnnotations(): Promise<StoredAnnotations | null> {
  const stored = await api.storage.local.get(KEYS.annotations);
  return (stored[KEYS.annotations] as StoredAnnotations | undefined) ?? null;
}

export async function setAnnotations(annotations: StoredAnnotations): Promise<void> {
  await api.storage.local.set({ [KEYS.annotations]: annotations });
}

export async function getSettings(): Promise<Settings> {
  const stored = await api.storage.local.get(KEYS.settings);
  // Spreading over the defaults means a settings object written by an older
  // version gains new fields instead of leaving them undefined.
  return { ...DEFAULT_SETTINGS, ...(stored[KEYS.settings] as Partial<Settings> | undefined) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const merged = { ...(await getSettings()), ...patch };
  await api.storage.local.set({ [KEYS.settings]: merged });
  return merged;
}

export async function getSnapshot(): Promise<Snapshot | null> {
  const stored = await api.storage.local.get(KEYS.snapshot);
  return (stored[KEYS.snapshot] as Snapshot | undefined) ?? null;
}

export async function setSnapshot(snapshot: Snapshot): Promise<void> {
  await api.storage.local.set({ [KEYS.snapshot]: snapshot });
}

export async function getChanges(): Promise<Change[]> {
  const stored = await api.storage.local.get(KEYS.changes);
  return (stored[KEYS.changes] as Change[] | undefined) ?? [];
}

export async function setChanges(changes: Change[]): Promise<void> {
  await api.storage.local.set({ [KEYS.changes]: changes });
}

/** Mark every change as seen, clearing the toolbar badge. */
export async function acknowledgeAll(): Promise<Change[]> {
  const changes = (await getChanges()).map((c) => ({ ...c, acknowledged: true }));
  await setChanges(changes);
  return changes;
}

export async function acknowledge(ids: string[]): Promise<Change[]> {
  const wanted = new Set(ids);
  const changes = (await getChanges()).map((c) =>
    wanted.has(c.id) ? { ...c, acknowledged: true } : c,
  );
  await setChanges(changes);
  return changes;
}

export interface SyncStatus {
  lastSyncAt: number | null;
  lastError: string | null;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const stored = await api.storage.local.get([KEYS.lastSyncAt, KEYS.lastError]);
  return {
    lastSyncAt: (stored[KEYS.lastSyncAt] as number | undefined) ?? null,
    lastError: (stored[KEYS.lastError] as string | undefined) ?? null,
  };
}

export async function setSyncStatus(status: Partial<SyncStatus>): Promise<void> {
  const payload: Record<string, unknown> = {};
  if ('lastSyncAt' in status) payload[KEYS.lastSyncAt] = status.lastSyncAt;
  if ('lastError' in status) payload[KEYS.lastError] = status.lastError;
  await api.storage.local.set(payload);
}

/** Subscribe to changes in any of the stored keys. Returns an unsubscribe fn. */
export function onStorageChanged(listener: (keys: string[]) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return;
    listener(Object.keys(changes));
  };
  api.storage.onChanged.addListener(handler);
  return () => api.storage.onChanged.removeListener(handler);
}
