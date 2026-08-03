/**
 * Cloudflare entry point. Everything here is the platform shell; the request
 * logic lives in `handler.ts` so it can be tested without wrangler.
 */

import { handle } from './handler.js';

/**
 * How long the edge holds an upstream plan file.
 *
 * CIS answers with `Cache-Control: max-age=0,must-revalidate`, so without an
 * override every subscriber's calendar app would become a request to the
 * university. Fifteen minutes is well inside the feed's own advertised PT10M
 * refresh and turns any number of subscribers into four requests an hour.
 */
const UPSTREAM_CACHE_TTL_SECONDS = 900;

export default {
  async fetch(request: Request): Promise<Response> {
    return handle(request, {
      fetchUpstream: (url) =>
        fetch(url, {
          cf: { cacheTtl: UPSTREAM_CACHE_TTL_SECONDS, cacheEverything: true },
          headers: {
            // Identify the caller: an origin admin seeing this traffic should be
            // able to tell what it is without having to guess.
            'User-Agent': 'better-cis-ical (+https://github.com/StaticFX/better-cis)',
          },
        } as RequestInit),
    });
  },
} satisfies ExportedHandler;
