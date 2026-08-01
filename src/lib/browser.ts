/**
 * One extension API object that behaves the same in both browsers.
 *
 * Firefox exposes promise-based APIs on `browser` and callback-based ones on
 * `chrome`; Chrome exposes promise-based APIs on `chrome` and has no `browser`.
 * Preferring `browser` therefore yields promises everywhere, with no polyfill
 * dependency and no callback wrapping.
 */

type ExtensionApi = typeof chrome;

const globalScope = globalThis as unknown as {
  browser?: ExtensionApi;
  chrome?: ExtensionApi;
};

export const api: ExtensionApi = (globalScope.browser ?? globalScope.chrome)!;

/** True when running under Firefox, which differs on a few manifest details. */
export const isFirefox = typeof globalScope.browser !== 'undefined';

/**
 * `runtime.lastError` must be read after a callback-style failure or the
 * browser logs an unchecked-error warning. Promise-based calls reject instead,
 * so this exists only for the handful of APIs that still take callbacks.
 */
export function lastError(): string | undefined {
  return api.runtime.lastError?.message;
}
