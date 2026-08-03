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
  /**
   * Release API to check for updates. Empty disables the check outright — no
   * request, no host permission, no banner.
   */
  releaseFeed?: string;
  /**
   * Guide for running your own endpoint. Only ever opened by the student, so
   * unlike `releaseFeed` it costs no host permission.
   */
  selfHostGuide?: string;
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

/** The configured release feed, or null when update checking is switched off. */
export function releaseFeed(): string | null {
  const feed = siteConfig.releaseFeed?.trim();
  return feed ? feed : null;
}

/**
 * Where to send someone who would rather host the endpoint themselves.
 *
 * Checked for https even though it comes from build-time config: it ends up as
 * an href, and a link in a privacy notice is a poor place to make exceptions.
 */
export function selfHostGuide(): string | null {
  const guide = siteConfig.selfHostGuide?.trim();
  return guide && /^https:\/\//i.test(guide) ? guide : null;
}
