/**
 * The subscription link: how a course selection travels from the extension to
 * the Worker that serves the filtered calendar.
 *
 * The selection is carried *in the URL* rather than stored server-side. That
 * choice is what keeps the extension from ever having to call the Worker — it
 * builds a string, the student's calendar app does the fetching — so no host
 * permission is needed and nothing leaves the device that the student did not
 * paste somewhere themselves.
 *
 * The cost is that the link changes when the selection does, and an old link
 * keeps serving the old courses. The UI says so; see `icalLastCopied`.
 *
 * Shared by both sides: the extension encodes, the Worker decodes.
 */

import type { PlanRef } from './sked.js';

/**
 * Version marker, first character of the `c` parameter.
 *
 * Deflate is skipped when it does not actually help — a two-course selection
 * compresses to more bytes than it started with.
 */
const ENCODING_PLAIN = '0';
const ENCODING_DEFLATE = '1';

/** Refuse absurd input rather than decompressing it: this runs on a public endpoint. */
const MAX_PARAM_LENGTH = 8 * 1024;
const MAX_DECODED_BYTES = 64 * 1024;
const MAX_KEYS = 500;

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

/** Encode selected course keys into the `c` query parameter. */
export async function encodeSelection(keys: string[]): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(keys));
  const deflated = await deflate(raw);
  return deflated && deflated.length < raw.length
    ? ENCODING_DEFLATE + toBase64Url(deflated)
    : ENCODING_PLAIN + toBase64Url(raw);
}

/**
 * Decode the `c` query parameter. Returns null for anything malformed — a bad
 * link is a 400, never a partially understood selection.
 */
export async function decodeSelection(param: string): Promise<string[] | null> {
  if (!param || param.length > MAX_PARAM_LENGTH) return null;

  const version = param[0]!;
  const bytes = fromBase64Url(param.slice(1));
  if (!bytes) return null;

  let payload: Uint8Array | null;
  if (version === ENCODING_PLAIN) {
    payload = bytes.byteLength <= MAX_DECODED_BYTES ? bytes : null;
  } else if (version === ENCODING_DEFLATE) {
    payload = await inflate(bytes, MAX_DECODED_BYTES);
  } else {
    return null;
  }
  if (!payload) return null;

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (!Array.isArray(parsed) || parsed.length > MAX_KEYS) return null;
    if (!parsed.every((key): key is string => typeof key === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read a selection out of a request URL.
 *
 * Two accepted forms: the compact `?c=` the extension emits, and repeated
 * `?course=` parameters, which are readable and hand-editable when someone is
 * debugging their own feed. Null means "no selection given" — the whole plan.
 */
export async function selectionFromUrl(url: URL): Promise<string[] | null | 'invalid'> {
  const compact = url.searchParams.get('c');
  if (compact !== null) {
    const decoded = await decodeSelection(compact);
    return decoded ?? 'invalid';
  }

  const plain = url.searchParams.getAll('course').filter((value) => value !== '');
  if (plain.length > MAX_KEYS) return 'invalid';
  return plain.length > 0 ? plain : null;
}

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

/**
 * Normalise a user-typed endpoint into a base URL.
 *
 * Accepts "example.workers.dev" as readily as a full URL, since that is what
 * people paste. Returns null if it cannot be made into an https origin.
 */
export function normaliseEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;

  // A bare host gets https, except on loopback: `wrangler dev` serves plain
  // http, and silently upgrading it points the link at a port that will never
  // answer — with the failure only showing up later, inside a calendar app.
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed);
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${isLoopback ? 'http' : 'https'}://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;

  // A trailing slash is load-bearing: `new URL('x.ics', 'https://h/sub')`
  // resolves to `https://h/x.ics`, silently dropping the path segment.
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export interface SubscribeUrlOptions {
  endpoint: string;
  ref: PlanRef;
  /** Null subscribes to the whole plan, matching `filterSelected`. */
  selection: string[] | null;
}

/** Build the link a student pastes into their calendar app. */
export async function buildSubscribeUrl(options: SubscribeUrlOptions): Promise<string | null> {
  const base = normaliseEndpoint(options.endpoint);
  if (!base) return null;

  const { zenturie, semester } = options.ref;
  if (!isPlanToken(zenturie) || !isSemesterToken(semester)) return null;

  const url = new URL(`${zenturie}_${semester}.ics`, base);
  if (options.selection) url.searchParams.set('c', await encodeSelection(options.selection));
  return url.toString();
}

/**
 * The same link as a `webcal:` URL, which is what makes Apple Calendar and
 * Outlook offer to subscribe instead of downloading a one-off copy.
 */
export function webcalUrl(subscribeUrl: string): string {
  return subscribeUrl.replace(/^https?:/, 'webcal:');
}

/** Google Calendar's "add by URL" entry point. */
export function googleCalendarUrl(subscribeUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(subscribeUrl))}`;
}

/* ------------------------------------------------------------------ *
 * Plan reference validation
 * ------------------------------------------------------------------ */

/**
 * Guards for the two values that get interpolated into an upstream URL by
 * `planUrls()`. An allowlist rather than a blocklist, because this is the only
 * thing standing between a public endpoint and a request forgery.
 */
export function isPlanToken(value: string): boolean {
  return /^[A-Za-z0-9]{1,12}$/.test(value);
}

export function isSemesterToken(value: string): boolean {
  return /^[0-9]{1,2}$/.test(value);
}

/* ------------------------------------------------------------------ *
 * Bytes
 * ------------------------------------------------------------------ */

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = readableFrom(bytes).pipeThrough(new CompressionStream('deflate-raw'));
    return await collect(stream, MAX_DECODED_BYTES);
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = readableFrom(bytes).pipeThrough(new DecompressionStream('deflate-raw'));
    return await collect(stream, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Wrap bytes as a stream for the compression transforms.
 *
 * Typed as `BufferSource` because that is the input type of both transforms'
 * writable side, and TypeScript treats the pair handed to `pipeThrough` as
 * invariant. The cast bridges the two type environments this file is compiled
 * in — lib.dom and @cloudflare/workers-types disagree over whether a
 * Uint8Array's buffer is an `ArrayBuffer` or an `ArrayBufferLike`. Nothing here
 * can produce a SharedArrayBuffer: the bytes come from `TextEncoder` or a fresh
 * allocation.
 */
function readableFrom(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as BufferSource);
      controller.close();
    },
  });
}

/**
 * Drain a stream, giving up past `maxBytes`.
 *
 * The cap is checked while reading rather than after: a few hundred bytes of
 * crafted deflate can expand to megabytes, and this decodes untrusted input.
 */
async function collect(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value === '') return null;

  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;

  try {
    const binary = atob(base64 + '='.repeat(padding));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
