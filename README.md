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

## Development

```sh
npm test        # 28 tests, including fixtures cut from the real published plan
npm run watch   # rebuild on change
npm run build   # dist/chrome and dist/firefox
npm run package # zips for both
```

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

Every push to `master` produces a release, including documentation-only commits.
To skip those, add to the `push` trigger:

```yaml
    paths-ignore: ['**.md', 'docs/**']
```

## Layout

```
src/lib/ics.ts       RFC 5545 reader — folding, escapes, TZID→UTC, RRULE, overrides
src/lib/sked.ts      Everything specific to sked campus: DESCRIPTION fields,
                     section detection, HTML change annotations
src/lib/courses.ts   Grouping events into the list you tick
src/lib/diff.ts      Snapshot comparison → added/removed/cancelled/moved/…
src/lib/storage.ts   Settings, snapshots, change history
src/background/      Scheduled sync, badge, messaging
src/content/         Widget takeover; calendar.ts is the view
src/preview/         Dev-only harness (never shipped in either manifest)
src/site.config.json The only file holding campus-specific values
```

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
