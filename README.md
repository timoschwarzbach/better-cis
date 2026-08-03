# better-cis

Makes the NORDAKADEMIE CIS timetable usable. Firefox and Chrome.

> An unofficial, independent project by a student. Not affiliated with,
> endorsed by, or supported by NORDAKADEMIE or sked software GmbH. It reads
> only timetable files the university already publishes without authentication,
> and it circumvents no access control: on pages that do require a login, it
> only re-renders what the signed-in user is already looking at.

The CIS homepage renders your Zenturie's *entire* plan — all sixteen
Wahlpflicht electives that run in the same Monday slot, and all three Englisch
groups that run in the same hour. For a typical student that is **233 events,
of which about 81 are theirs.** Two thirds of the calendar is other people's
classes, laid out across 170 table rows at five-minute resolution.

This extension replaces that widget in place with one that shows your courses,
navigates by week, and tells you what changed.

## What it does

- **Picks up your plan automatically.** The CIS pages already link to your
  Zenturie's plan file; the extension reads the link, so there is nothing to
  configure.
- **Lets you choose your courses**, and remembers them. Where a course runs as
  parallel groups you can only attend one of, ticking one unticks the others.
- **Shows changes.** Room swaps, reschedules, cancellations and additions, with
  the registrar's own wording where it exists — including changes made before
  you installed the extension.
- **Keeps the original.** The CIS table is hidden, not removed. The *Original*
  button brings it back.
- **Exports the result.** *Abonnieren* produces a calendar link carrying only
  your courses, with titles a phone can actually display. See
  [Subscribing from a calendar app](#subscribing-from-a-calendar-app).

## Where the data comes from

Both files are public — no login, no token, no credentials for the extension to
handle:

```
https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene/<Zenturie>_<Semester>.ics
https://cis.nordakademie.de/fileadmin/Infos/Stundenplaene/<Zenturie>_<Semester>.html
```

The `.ics` is the data. The `.html` is the annotation: sked marks events it has
changed with `#zf<id> { border: 2px solid red }` and lists them in a per-week
table. **The CIS homepage strips both**, so this is information the site
already has and simply does not show you.

The two share an identity space — `.ics` UID `sked.de227350` is HTML cell
`zf227350` — which is what lets the annotations be matched to events reliably
rather than by fuzzy text matching.

### Things worth knowing about the feed

These are the details that break naive implementations, all covered by tests:

| | |
|---|---|
| `SUMMARY` is unusable | It jams four values into one string: `"WP WP Strat. Marketing-Projekt,Prof. Dr. rer. pol. Kortmann,inkl. 30 min Pause,H008"`. The structured data is in `DESCRIPTION` as `Key: value` lines, with `-` meaning "not set". |
| The charset header is wrong | The server declares `ISO-8859-15` while serving UTF-8, which is why the plan renders `VeranstaltungsplanÂ` in a browser. `Response.text()` always decodes UTF-8 and ignores the header, so fetching it fixes the mojibake for free. |
| Parallel groups are found by time, not lecturer | `V I177 Englisch` runs three groups at the same hour → three selectable sections. `WP Internationale Beziehungen` has three lecturers across three *different* weeks → one course. Splitting on lecturer would invent groups that do not exist. |

## Install

Build first:

```sh
npm install
npm run build
```

**Chrome** — `chrome://extensions` → enable *Developer mode* → *Load unpacked*
→ select `dist/chrome`.

**Firefox / Zen / LibreWolf** — `about:debugging#/runtime/this-firefox` →
*Load Temporary Add-on* → select `dist/firefox/manifest.json`. Temporary
add-ons are removed when the browser restarts; `npm run run:firefox` launches a
dedicated profile with it already loaded.

For an installable package, use `npm run package`, which writes
`dist/better-cis-firefox.xpi`.

> **Do not zip the folder from Finder.** Firefox reads `manifest.json` from the
> *root* of the archive. Finder's "Compress" nests everything under a
> `firefox/` directory and adds `__MACOSX/` entries, and the resulting file
> fails to install with **"This add-on could not be installed because it
> appears to be corrupt"** — which sounds like a damaged download but really
> means "no manifest at the top level". `npm run package` zips the *contents*,
> which is what the format requires.

Installing an `.xpi` permanently also requires it to be signed. Either set
`xpinstall.signatures.required` to `false` in `about:config` — this works in
Firefox forks, Developer Edition, Nightly and ESR, but is ignored by release
Firefox — or sign it against your own AMO account:

```sh
export WEB_EXT_API_KEY=user:...        # addons.mozilla.org/developers/addon/api/key/
export WEB_EXT_API_SECRET=...
npm run sign                            # unlisted channel: signed, not publicly listed
```

Then open <https://cis.nordakademie.de/> and pick your courses.

## Subscribing from a calendar app

The plan file is already a valid `.ics`, so any calendar app can subscribe to it
today. The result is unusable: all 233 events of the Zenturie, every elective
and every English group, each one titled
`WP WP Strat. Marketing-Projekt,Prof. Dr. rer. pol. Kortmann,inkl. 30 min Pause,H008`.

*Abonnieren* in the toolbar offers **two links, and says plainly what each one
costs**:

| | |
|---|---|
| **Nur meine Kurse** | Routed through a small Cloudflare Worker, which fetches the same public plan, filters it to the courses you ticked, and rewrites the events so a phone shows `Usability Engineering (Vorlesung)` with the room as the location. |
| **Original von CIS** | `https://cis.nordakademie.de/…/A23a_6.ics` — straight from the university, nothing in between. All 233 events of the Zenturie, with the feed's own unusable titles. |

The filtered link looks like this, with the selection encoded into it:

```
https://<endpoint>/A23a_6.ics?c=<your selection, deflated and base64url'd>
```

The dialog carries a warning naming the actual host whenever that option is
selected, because the trade is real and belongs to the student:

> Dieser Link läuft nicht direkt über CIS, sondern über `<host>`. […] Deine
> Kursauswahl steht im Link — der Dienst sieht also bei jedem Abruf deines
> Kalenders, welche Kurse du belegst, und wer den Link hat, sieht deinen
> Stundenplan.

Concretely: a calendar app polls roughly hourly, so choosing the filtered feed
hands whoever runs that endpoint a standing record of which courses someone
takes. The plan itself is public; *which electives you picked* is not. Anyone
who would rather not make that trade can take the original and lose only the
filtering. The original needs no endpoint at all, so it works even where nobody
has deployed a Worker.

**The extension itself never calls the endpoint.** It builds the link; your
calendar app is what fetches it. That is why this needs no new permission and
why Firefox's `data_collection_permissions` is still honestly `none`.

One more consequence of putting the selection in the URL: **the link is the
selection.** Change your courses and the old link keeps serving the old ones
until you replace it in your calendar app — the dialog says so when it happens.

### DSGVO / GDPR

Not legal advice — but the architecture was chosen to keep this simple, so it is
worth writing down what it does and does not do.

**No consent banner.** A cookie banner exists because of §25 TDDDG (ex-TTDSG,
ePrivacy Art. 5(3)), which covers storing or reading information on the user's
device beyond what the requested service strictly needs. Neither half does that:

- The extension stores settings and the plan snapshot in `chrome.storage.local`,
  which is strictly necessary for the thing the user installed it to do, and
  which never leaves the device.
- The Worker sets **no cookies**, no `localStorage`, no identifiers of any kind.
  It reads the URL, fetches a public file, and answers. It is stateless: no KV,
  no database, no bindings.

**Consent for the routed feed is collected where it happens.** Picking *Nur
meine Kurse* is an informed, specific, unambiguous act, and the dialog names the
host and states what it will see before the choice is made. Two properties keep
that honest, and both are load-bearing rather than cosmetic:

- **Nothing is preselected.** Pre-ticked consent is not consent (CJEU
  *Planet49*, C-673/17). The dialog opens with neither option chosen.
- **Declining costs the student nothing but the filtering.** *Original von CIS*
  is always available, needs no endpoint, and involves no third party — so the
  choice is a real one.

Note that no request is made when the dialog is opened, or even when the link is
copied. Processing begins only once the student pastes the link into a calendar
app, which is about as unambiguous an affirmative action as it gets.

**What a deployment processes.** Each poll from a subscriber's calendar app
gives the Worker that client's IP address (personal data per CJEU *Breyer*,
C-582/14) and a URL containing the course selection. `[observability]` is
therefore **off** in `wrangler.toml`: with it on, Cloudflare would retain exactly
that pairing. Nothing is written anywhere with it off.

**If you deploy a public instance**, the remaining obligations are yours and are
not things this repository can satisfy for you:

- A privacy notice under Art. 13 (who the controller is, what is processed, on
  what basis, for how long, and the data subject's rights), and in Germany an
  Impressum under §5 DDG.
- A processor agreement with Cloudflare (Art. 28) — their standard DPA covers
  this — plus the transfer basis for non-EU processing. `[placement] mode` is
  set to `smart`, which is about latency, not jurisdiction; restrict the
  deployment if you need processing to stay in the EU.
- Turning observability back on for a debugging session is a change to what you
  process. Say so in the notice, or turn it off again afterwards.

A deployment that only ever serves the person who runs it is a much smaller
question than one advertised to a whole Zenturie.

### Running your own endpoint

`worker/` is the whole thing: no database, no KV, no bindings, no secrets.

```sh
npm run dev:worker         # http://localhost:8787 — local, nothing deployed
npm run deploy:worker:dev  # better-cis-ical-dev.<subdomain>.workers.dev
npm run deploy:worker      # better-cis-ical.<subdomain>.workers.dev
```

**Three URLs, on purpose.** A subscription link is long-lived by nature: it is
pasted into a calendar app once and polled for the rest of the term. That makes
the production hostname effectively permanent, and trying a change out on it
something that cannot be taken back. `[env.dev]` in `wrangler.toml` is a second
deployment with its own name, inheriting everything else.

`deploy:worker` passes `--env=""` explicitly, because once any environment
exists wrangler treats a bare `deploy` as ambiguous — and the ambiguous case is
the one that overwrites production.

To point a development build of the extension at a local worker, paste
`localhost:8787` into *Erweitert: eigener Endpunkt*. Loopback hosts keep `http`
rather than being upgraded to `https`, which the dev server does not speak.

Then put the deployed URL in `icalEndpoint` in `src/site.config.json` to make it
the default for everyone using your build. Students can override it per install
under *Erweitert* in the dialog. With the field left empty the dialog simply
asks for an endpoint instead of pretending one exists.

The endpoint accepts a hand-editable form too, which is the quickest way to
check what a course key actually matches:

```sh
curl 'http://localhost:8787/A23a_6.ics?course=V%20A113%20Usability%20Engineering'
curl 'http://localhost:8787/A23a_6.ics?notes=0'   # skip the HTML change notes
```

It caches the upstream plan for 15 minutes, so any number of subscribers is four
requests an hour to CIS rather than one per poll.

## Development

```sh
npm test        # 60 tests, including fixtures cut from the real published plan
npm run watch   # rebuild on change
npm run build   # dist/chrome and dist/firefox
npm run package # zips for both
npm run dev:worker  # the iCal endpoint, locally
```

`npm run typecheck` covers two programs. The extension and the worker cannot
share one: `@types/chrome` and `@cloudflare/workers-types` both declare the
global scope. `worker/src/handler.ts` is checked by both — the worker's config,
and the root config via the test that imports it — which is what keeps it to
standard web APIs and out of Cloudflare-specific ones.

### Looking at the UI without installing anything

```sh
node scripts/preview-page.mjs [Zenturie] [Semester]   # default A23a 6
open dist/preview.html
```

Fetches a real published plan, embeds it, and renders the calendar in a page
you can open from disk. Three buttons cover first run, a selected timetable,
and a week containing changes. Faster than the unpacked-extension reload cycle.

## Releases

`.github/workflows/ci.yml` does two things.

**On every push and pull request** it typechecks, runs the tests, builds, and
runs Mozilla's validator over the Firefox output. Pull requests also get the
built archives attached as artifacts, so a change can be loaded in a browser
before it is merged.

**On every push to `master`** it additionally bumps the patch version, commits
that, tags it, and publishes a GitHub Release with all three archives and a
`SHA256SUMS.txt`.

A few things about it that are deliberate:

- **The version is bumped before the build**, because the manifests read their
  version from `package.json` at build time. A step afterwards asserts that
  both built manifests actually carry the new version — otherwise a release
  could ship contents that disagree with its own tag.
- **It cannot loop.** Pushes authenticated with the built-in `GITHUB_TOKEN` do
  not trigger workflows. The commit message also carries `[skip ci]`, which
  would stop it independently.
- **Releases are serialised** (`concurrency: release`, no cancellation). Two
  pushes in quick succession queue rather than race, so the second bumps from
  the version the first pushed instead of colliding on a tag.
- **Only the release job can write.** The workflow's default permission is
  `contents: read`.
- **Worker-only changes do not release.** `worker/**` is in `paths-ignore`,
  because the endpoint versions independently of the extension. Changes under
  `src/lib/**` are shared and deliberately still trigger both workflows.

`.github/workflows/worker.yml` deploys the endpoint separately — typecheck,
test, a `--dry-run` bundle to catch a broken cross-package import, then
`wrangler deploy` on every push to `master` that actually changes it. It is kept
out of `ci.yml` so a Cloudflare outage can never block an extension release.

**It needs credentials before it can do anything.** One-time setup:

```sh
# Cloudflare dashboard → My Profile → API Tokens → Create Token
#   → template "Edit Cloudflare Workers"
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID   # dashboard → Workers & Pages → Account ID
```

Until those exist the workflow verifies and then **fails** at the deploy step,
with the setup instructions in the run summary. It failing is the point: the
first version of this skipped quietly with a green tick, which meant a push
could report success while the worker was never updated. On a fork it still
skips quietly and stays green — nobody expects someone else's clone to hold
deploy credentials.

**Change detection is on the artifact, not the paths that produced it.** The
path filter is only a cheap first gate: it matches all of `src/lib/`, but the
worker imports about half of that. So the workflow hashes the built bundle and
keeps the hash as a cache key — a hit means this exact bundle is already live,
and the deploy is skipped. Editing `storage.ts` or `diff.ts` therefore produces
no deploy at all, because the bundle comes out byte-identical:

```
              baseline   c76066c679355625
  edit storage.ts (unused)   c76066c679355625   → skipped
  edit ics-write.ts (used)   3c9c068180d7ad8d   → deployed
```

Two details this rests on. Only `index.js` is hashed — the sourcemap and the
generated README embed the output path and differ between runs even when
nothing changed. And if a cache entry is evicted, the result is a redundant
deploy of identical code, never a skipped real change; that is the direction to
fail in. `workflow_dispatch` takes a `force` input for the case where the
deployed state has drifted from what the cache believes.

`package.json` and `package-lock.json` are in the path filter too, since a
wrangler or esbuild bump changes the emitted bundle. The hash check discards the
runs where it turns out not to have.

Every push to `master` produces a release, including documentation-only commits.
To skip those, add to the `push` trigger:

```yaml
    paths-ignore: ['**.md', 'docs/**']
```

## Layout

```
src/lib/ics.ts        RFC 5545 reader — folding, escapes, TZID→UTC, RRULE, overrides
src/lib/ics-write.ts  RFC 5545 writer — the readable calendar the worker serves
src/lib/sked.ts       Everything specific to sked campus: DESCRIPTION fields,
                      section detection, HTML change annotations
src/lib/courses.ts    Grouping events into the list you tick
src/lib/ical-link.ts  Subscription links: selection encoding, endpoint validation
src/lib/diff.ts       Snapshot comparison → added/removed/cancelled/moved/…
src/lib/storage.ts    Settings, snapshots, change history
src/lib/site.ts       Typed access to site.config.json, inlined at build time
src/background/       Scheduled sync, badge, messaging
src/content/          Widget takeover; calendar.ts is the view
src/preview/          Dev-only harness (never shipped in either manifest)
src/site.config.json  The only file holding campus-specific values
worker/               Cloudflare Worker serving the filtered .ics feeds
```

The worker runs the *same* pipeline as the extension —
`parseIcs → enrichEvents → filterSelected → writeIcs`. That is not reuse for its
own sake: `courseKey` is derived rather than read from the feed, since a course
splits into sections based on which of its own occurrences overlap. Running any
other derivation would make the keys in a link mean something different at the
two ends.

### Two behaviours that look like bugs but are not

**A truncated download is not a cancelled term.** If a refresh returns far
fewer upcoming events than the last one, the diff reports nothing and says so,
and the old snapshot is deliberately *kept* — overwriting it would make the bad
download the new baseline, and the real changes would never surface.

**A first sync reports no changes.** There is nothing to compare against, and a
calendar full of "new!" on day one is noise. sked's own annotations cover that
gap.

## Porting to another campus system

`src/site.config.json` holds the origins and match patterns; `src/lib/sked.ts`
holds every assumption about the timetable product. `ics.ts`, `diff.ts` and
`storage.ts` are generic. If your university also runs sked campus, the URL
shape in `planUrls()` is likely the only thing that needs changing.
