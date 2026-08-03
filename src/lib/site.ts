/**
 * Typed access to `src/site.config.json`, which the build inlines as
 * `__SITE_CONFIG__`.
 *
 * The `typeof` guard is not defensive style — it is required. Two of the ways
 * this code runs have no such define: `buildPreview()` builds the preview
 * harness without one until it is added there too, and `npm test` runs the
 * sources through Node's type stripping with no bundler at all. An unguarded
 * reference to an undeclared identifier is a ReferenceError, so the fallback is
 * what keeps the library importable outside the extension bundle.
 */

export interface SiteConfig {
  displayName: string;
  firefoxAddonId?: string;
  origins: string[];
  contentScriptMatches: string[];
  defaultTimeZone: string;
  /**
   * Base URL of a deployed `worker/` instance. Empty is a valid state: the
   * subscription dialog then asks the student for an endpoint instead of
   * pretending one exists.
   */
  icalEndpoint?: string;
}

declare const __SITE_CONFIG__: SiteConfig;

const FALLBACK: SiteConfig = {
  displayName: 'CIS',
  origins: [],
  contentScriptMatches: [],
  defaultTimeZone: 'Europe/Berlin',
  icalEndpoint: '',
};

export const siteConfig: SiteConfig =
  typeof __SITE_CONFIG__ === 'undefined' ? FALLBACK : __SITE_CONFIG__;

/** The configured endpoint, or null when nobody has deployed one. */
export function defaultIcalEndpoint(): string | null {
  const endpoint = siteConfig.icalEndpoint?.trim();
  return endpoint ? endpoint : null;
}
