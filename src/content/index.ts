/**
 * Finds the CIS timetable widget and hands it over to the calendar view.
 *
 * The original table is hidden, never removed, and a toggle brings it back.
 * This extension re-interprets a feed a third party controls; if it ever
 * misreads something, the authoritative view has to stay one click away.
 */

import { api } from '../lib/browser.js';
import { parsePlanRef } from '../lib/sked.js';
import { createCalendar, type CalendarState } from './calendar.js';

const HOST_ID = 'better-cis-root';

/** Tell the background which plan this page points at, so it needs no setup. */
function reportPlanRef(): void {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const ref = parsePlanRef(anchor.href);
    if (!ref) continue;
    void api.runtime.sendMessage({ type: 'discoveredPlan', ...ref });
    return;
  }
}

async function main(): Promise<void> {
  const container = document.querySelector<HTMLElement>('div.stupla');
  if (!container) return;

  const table = container.querySelector<HTMLElement>('table.contenttable');
  // Without the table this is not the widget we think it is; leave the page be.
  if (!table) return;

  // Guard against a double injection if the script is ever re-run on one page.
  if (document.getElementById(HOST_ID)) return;

  reportPlanRef();
  table.style.display = 'none';

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  table.parentElement?.insertBefore(host, table);

  const calendar = createCalendar(shadow, {
    setSelection: (keys) =>
      api.runtime.sendMessage({ type: 'setSettings', patch: { selectedCourses: keys } }),
    acknowledgeAll: () => api.runtime.sendMessage({ type: 'acknowledgeAll' }),
    setOriginalVisible: (visible) => {
      table.style.display = visible ? '' : 'none';
    },
  });

  const pull = async () => {
    const state = (await api.runtime.sendMessage({ type: 'getState' })) as CalendarState;
    calendar.update(state);
  };

  await pull();

  // Re-render when the background writes new data.
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') void pull();
  });

  // A stale "vor 3 Min aktualisiert" is worse than none.
  setInterval(() => calendar.refresh(), 60_000);

  void api.runtime.sendMessage({ type: 'sync' });
}

void main();
