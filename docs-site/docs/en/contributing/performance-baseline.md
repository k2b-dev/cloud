---
title: Measure production page performance
navTitle: Performance baseline
section: Contributing
order: 1311
description: Record repeatable page weight and cold-load timings from isolated production bundles.
tags: [contributing, performance, testing, ssr]
updated: 2026-10-20
---

# Measure production page performance

Use `scripts/perf-baseline.ts` to compare rendering changes against minified
production bundles served through the gateway behind a Caddy TLS terminator.
It writes static page sizes and
cold browser timings to JSON, with median values in a Markdown report.

## Prepare the checkout

Run from the repository root with workspace dependencies installed and Docker
access. Both Chromium and WebKit run in one run-owned Playwright noble
container matching the root catalog version. The harness connects to both
engines over WebSocket; local browsers and their system libraries are not
required. Browser server startup or Chromium connection failures fail the run;
a WebKit connection failure records WebKit as skipped.

The harness reads the existing Playwright dependency from `packages/ui`; it
does not install local dependencies or browsers. Docker may pull missing
images, including the Playwright image (about 3.5 GB), and the container may
download its matching Playwright package.

## Run a baseline

```bash
bun --no-env-file scripts/perf-baseline.ts --runs 3
```

The harness takes the machine-wide heavy lock used by check/test runs. It
waits for those runs to finish and blocks them while it builds and measures,
including runs in other worktrees.

Allow approximately 5–15 minutes for builds and startup, plus the browser
loads. Downloads and slower hosts can take longer. Builds are sequential;
each app's build is capped at ten minutes, application readiness at three
minutes, and each browser load at 45 seconds. This is a planning estimate,
not a measured runtime guarantee.

Like the Dockerfile, the harness first rebuilds `@k2b/ui` and then runs the
application build command, both with `NODE_ENV=production`, plus the
selected `APP_ID`, `CLOUD_VERSION=0.0.0-perf`, and `CLOUD_RELEASE=perf` for
the application. The builds run in this checkout, not in the Docker build
context, so Tailwind's scan for `global.css` also sees `docs-site`, PWAs,
fixtures, and scripts. That adds a few hundred bytes of CSS compared with an
image build. Each bundle moves from root `dist/` into
`.local/perf-baseline/build/<app>/dist`. An existing root `dist/` blocks the
build so the harness cannot replace an unrelated artifact. Move it aside
within the checkout first. `--skip-build` rebuilds nothing and reuses stored
bundles; use it only when they match the source you want to measure. Its
recorded Git commit does not establish the provenance of reused bundles.

The harness starts fresh PostgreSQL, NATS, Valkey, and application containers
on its own network. It reads the pinned Bun runtime image from `Dockerfile`,
mounts the bundles read-only, and runs `bun server.js` as `bun`. Caddy uses
the pinned `caddy:2.10.2-alpine` image with an internal certificate and
`reverse_proxy gateway:3000`. HTTP/2 uses Caddy's default configuration;
Caddy passes through the gateway's Brotli/gzip without re-encoding.
Caddy publishes HTTPS and the browser server on two free `127.0.0.1` ports
other than 3000. Every application's `APP_URL` and the measured origin are
`https://localhost:<port>`. Bun fetches skip certificate verification only
for this origin; Chromium pins the run’s certificate public key, WebKit ignores
certificate errors, and both use a secure
session cookie. The development stack is separate.

The Playwright container shares Caddy's network namespace, isolating both
browser engines from host network interface churn. Caddy listens on the same
HTTPS port inside its namespace as on the host, so the browsers and host use
the same `https://localhost:<port>` origin. Both engines use fresh contexts
for each load.

Every page is measured with the throwaway administrator's session, supplied
by Core's administrator-token login, so the shell includes administrator
navigation. The harness accepts the fresh installation's legal terms for that
administrator through Core's public consent flow. It requires an authenticated `/api/me`
response before checking routes or seeding; redirects to sign-in or consent
do not count as route readiness. Public HTTP APIs seed three FAQ entries,
a structured notebook note, an empty Assistant
conversation, one Space with the tasks starter, and two folders with three
empty Markdown files. Files uses a
throwaway Filegate volume and a fixture-only local Linux identity range.
Accounts measures the user list containing the administrator. The document
page is Core's privacy document. IDs and timestamps come from the fresh
installation; content, item counts, locale, theme, and seed version are fixed.

**Mail measures the mailbox view without a provider connection:** an empty
list, smaller props, and the same eager JS. The public API seeds a real
mailbox, and its resolved view is measured with this limitation in page notes.
Mail's connector accepts only public hosts with verified TLS; the harness
uses no mail server, real mailbox credentials, or messages.

All resources carry a unique `cloud-perf-…` name and ownership label. Normal
exit, errors, SIGINT, and SIGTERM remove this run's resources and private
fixture files. SIGKILL cannot run cleanup. To inspect a stack, use `--keep`;
the harness prints its exact removal commands. Keep its fixture directory
private because it contains temporary credentials.

Run `bun --no-env-file scripts/perf-baseline.ts --help` for every flag:
`--pages`, `--panel`, `--runs`, `--skip-build`, `--out`, `--compare`, and `--keep`.
The default page list has eight entries: `document`, `faq`, `mail-mailbox`,
`assistant-chat`, `notebooks-editor`, `files`, `accounts`, and `spaces`.
`spaces` resolves to the Space created through `POST /api/spaces`.
Output directories must stay inside the checkout. Existing result files are
never overwritten.

## Read the measurements

Mail, Chat, and Assistant responses stay uncompressed by design. They mix
repeatedly writable outside text with private message content; see [Response compression](/en/docs/build/routing#response-compression).

Static metrics use the served HTML and the production build files:

- HTML sizes are raw UTF-8 bytes, gzip at level 9, and Brotli at maximum quality.
- Islands count both `solid-island` and `solid-client` elements. Entry modules
  are distinct IDs resolved through the actual SSR loader URL.
- Props count decoded UTF-8 attribute bytes, without evaluating seroval.
  `propsShare` is decoded props bytes divided by raw HTML bytes; HTML entity
  escaping can make the encoded attributes larger.
- Eager JavaScript includes initial island entries, other module scripts, and
  their static imports. Lazy JavaScript is the additional dynamic-import
  closure, with shared files counted once. Inline module code is already part
  of HTML; its referenced modules enter the closure.
- CSS includes linked stylesheets and their imports. Asset sizes use built
  `.gz` and `.br` siblings when present, otherwise matching compression settings.

Each load uses a fresh browser context, the administrator session, the
`en-US` locale, light theme, blocked service workers, and the `Europe/Berlin` time zone with
Cloud's time zone cookie already set, like a returning user. Without that
cookie, the first visit reloads once to render times in the browser's zone,
and the harness fails any load that navigates again. The static HTML fetch
sends the same `Accept-Language` and time zone cookie as the browsers:

| Profile | Viewport | Chromium | WebKit |
| --- | --- | --- | --- |
| Desktop | 1440 × 900, scale 1 | CPU rate 1, unthrottled network | No throttle |
| Phone | 390 × 844, scale 3, touch/mobile | CPU rate 4; 150 ms request latency, 200,000 B/s download, 93,750 B/s upload | No CPU or network throttle |

Chromium transfers use CDP `Network.loadingFinished.encodedDataLength`;
WebKit uses `request.sizes()` response body plus header sizes. Requests and
bytes split into document, JavaScript, CSS, and other resources. Transfers
count completed requests until the observation stops, including the quiet
window described below; open streams may have no completed byte count. JavaScript and CSS content encodings are recorded. Uncompressed
Chromium JavaScript/CSS responses fail the profile. Build Brotli sizes and
actual transferred bytes are separate measurements, since a browser can
negotiate gzip and transfer headers add overhead.

**TTI** is the latest navigation-relative time among FCP (when supported),
the end of each initial island/client wrapper's synchronous mount, the
response end of every main-frame script loaded during the observation, and, in
Chromium, the end of the last long task. WebKit has no long-task entries.
Every main-frame script request must have a host resource timing entry.
Child-frame scripts are excluded from host TTI because their entries belong
to the frame timeline; their requests and bytes still count in page transfers.

The observation stops when every initial wrapper has mounted, no script is
pending, every script request has its resource timing entry, and script
requests have been quiet for at least 500 ms. WebKit can add the entry of a
`modulepreload` link that the page inserts at runtime well after the request
finished, so the observation waits for it; an entry that never arrives runs
into the deadline below. This quiet
window only ends the observation; it and the harness polling delay are not
part of TTI. The probe observes the existing synchronous `innerHTML = ""`
followed by `render()` in the SSR mount runtime and records the time in a
microtask after that stack. An island-error event fails the load. The
45-second deadline fails the profile; it never becomes a numeric TTI result.
Its error names the time to `DOMContentLoaded` and the last observed state:
mounted islands, pending scripts, scripts without timing, and the quiet time.

The probe and static inspector depend on today's SSR internals:
clear-and-render mounting, the inline `const p=` loader, and
`_ssr/<content-hash>/<file>` asset paths. Content hashing needs no harness
change: the loader keeps its `const p=` shape and exactly one segment sits
between `_ssr/` and the file. The loader's preload list contains no import
expressions, so the static inspector's module set stays unchanged; the harness
needed no change. Hydration without
clear-and-render or a different loader/path shape needs a harness update in
the same change; until then, mounting or asset resolution fails loudly. A
replacement probe must observe the same point, the end of each initial
island's synchronous mount, so before/after comparisons keep TTI's meaning.

FCP, LCP, CLS, resource timings, and long tasks come from performance entries
collected until the observation stops, in the same step that ends it. CLS is
the largest sum of layout shifts without recent input in one session window:
a gap of more than one second, or a window that would exceed five seconds,
starts a new window. Unsupported entries
are `null`. Chromium also reports the last long-task end (0 when no long task
occurred) and total blocking time: for each long task overlapping FCP through
TTI, subtract 50 ms from its overlap and sum positive remainders. WebKit
long-task metrics are `null`. These are bounded load observations, not final
LCP/CLS over a user's visit.

## Use the result files

The default output is `.local/perf-baseline/<UTC timestamp>/result.json` and
`summary.md`; both paths are printed. The Markdown tables show medians. JSON
retains individual samples and median/min/max ranges. Bytes and milliseconds
are integers, and CLS is rounded to four decimal places. Object keys are
sorted; page and profile arrays retain their documented order.

Schema version 1 has these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`; incompatible comparisons are rejected |
| `metadata` | `commit`, `dirty`, `timestamp`, `bunVersion`, `playwrightVersion`, `browserVersions`, `cpuCount`, `loadAverage` (one-minute load at start and end), `runs`, `origin`, `transport`, `runtimeImage`, `seedVersion`; new runs record `transport: "https-h2-caddy"` |
| `pages[]` | `id`, resolved `path`, `status`, `errors`, `notes`, `static`, `browsers` |
| `pages[].static` | `html`, `islands`, `islandEntries`, `propsBytes`, `propsShare`, `js.eager`, `js.lazy`, `css`; size objects contain `raw`, `gzip`, `brotli`, with `modules` for JS/CSS |
| `pages[].browsers[]` | `browser`, `profile`, `status`, `reason`, `cpuThrottle`, `network`, `transferSource`, `contentEncoding`, `samples`, `metrics` |
| `samples[]` and `metrics` keys | `documentBytes`, `jsBytes`, `cssBytes`, `otherBytes`, `documentRequests`, `jsRequests`, `cssRequests`, `otherRequests`, `requests`, `fcpMs`, `lcpMs`, `cls`, `ttiMs`, `lastLongTaskEndMs`, `totalBlockingTimeMs` |
| `metrics.<key>` | `{ median, min, max }`, or `null` for an unsupported metric |
| `errors` | Run-level setup, interruption, or cleanup failures |

Browser status is `ok`, `failed`, or `skipped`. An incomplete profile retains
successful raw samples but has `metrics: null`; its successful subset is never
presented as a complete median. WebKit connection skips do not fail the run.
Setup failures and page/profile failures exit non-zero and still produce a
report. Non-200 pages, redirects, gateway errors, and sign-in pages fail
explicit validation.

## Compare two runs

Use the same host, page selection, run count, and browser versions. Keep the
old result inside the worktree, build the changed source, and run:

```bash
bun --no-env-file scripts/perf-baseline.ts --runs 3 \
  --compare .local/perf-baseline/<previous timestamp>/result.json \
  --out .local/perf-baseline/after
```

The added column is the median TTI difference in milliseconds, matched by
page ID, browser, and profile. Positive values are slower. Missing or failed
profiles show a dash. Inspect JSON for size deltas and the min/max ranges.
Rebuild after source changes; `--skip-build` can otherwise compare stale code.

These numbers describe the local machine. Run on a quiet host: other heavy
work (tests, builds, browsers) skews timings, and the summary shows the host
load average at the start and end of the run for that reason. CPU and network throttling are
emulation, not a real phone; WebKit is unthrottled. Background work, thermal
limits, operating-system caches, and run order cause variance. A fresh
browser context makes each navigation cold, but does not flush server or OS
caches. TTI covers initial mounting, script loading, and Chromium long tasks,
not every later interaction or data request. Treat small differences within
the reported range as inconclusive.

## Measure the panel after a navigation

Use `--panel` to decide whether panel delay warrants prioritizing F10 (page
changes without a new document) ahead of Assistant and Chat. First measure
how long the panel needs to show content after a navigation, then assess the
medians and their ranges:

```bash
bun --no-env-file scripts/perf-baseline.ts --panel --runs 5
```

This runs only the panel scenario: `pages` stays empty in `result.json`.
`--runs` defaults to 3. `--panel` cannot be combined with `--pages` or
`--compare`; the CLI rejects either combination before setup. The same
production build, isolated stack, heavy lock, output files, and cleanup rules
apply. Only Core, Spaces, Mail, Notebooks, and the gateway are started.
The bundles must include the Help panel provider from #1582.

### Navigations and profiles

Each navigation uses the public-API fixtures described above, in this order:

| Navigation | From → to | Expected Help heading |
| --- | --- | --- |
| `spaces` | Spaces overview → seeded Space | For this view |
| `mail` | Mail overview → seeded mailbox | For this view |
| `notebooks` | Notebooks overview → seeded note, `?mode=write` | First start heading: What do you want to do? or the first group |
| `spaces-to-mail` | Seeded Space → seeded mailbox | For this view |

The last navigation crosses application boundaries. The Notebooks editor
currently declares no view Help IDs, so its expected heading is the first
start heading. A page expected to show **For this view** fails if only a start heading
appears. Selectors and nonempty visible text identify these headings; timing
does not depend on English wording.

For each navigation the harness runs Chromium column, drawer, and sheet,
then WebKit column, drawer, and sheet:

| Layout | Viewport / scale | Device | Chromium | WebKit |
| --- | --- | --- | --- | --- |
| Column | 1440 × 900 / 1 | Desktop | CPU 1, unthrottled network | Unthrottled |
| Drawer | 834 × 1194 / 1 | Desktop, no touch | CPU 1, unthrottled network | Unthrottled |
| Sheet | 390 × 844 / 3 | Mobile and touch | CPU 4; 150 ms latency, 200,000 B/s download, 93,750 B/s upload throughout the sample | Unthrottled |

Every sample has a fresh context, administrator session, `en-US` locale,
`Europe/Berlin` time zone and cookie, light theme, blocked service workers,
and the run’s local certificate (Chromium SPKI pin; WebKit certificate-error
override). **HTTP cache stays enabled** in both
engines. The from page warms the session cache before the measured navigation;
desktop also waits for its Help content, warming provider assets. Phone waits
for host TTI without opening Help. Server and OS caches are not flushed.

Column and drawer use `cloud_panel=1:core:`. Sheet uses no panel cookie.
After each new document the phone sheet must be closed, with no provider
document request before tapping Help. A violation fails the sample. This
measures opening after navigation, rather than a panel opening automatically
on a phone.

### Anchors and visible content

The harness navigates using `location.assign`, as a full-document link would.
For desktop, the anchor is the new host document's `performance.timeOrigin`
(navigation start). Before assign, the old page saves its epoch time in
session storage. `navigationGapMs` is the new `timeOrigin` minus that assign
epoch: inspect it to check the anchor, especially in WebKit.
`assignToContentMs` adds the gap to `panelContentMs` and shows the delay from
assign to visible panel content.

For sheet, the new host first reaches TTI. The harness arms the probe and
taps the visible header Help button. Only a trusted `pointerdown`, captured
before the handler, supplies the opening anchor. Synthetic events cannot
start it. `openToContentMs` runs from that event's timestamp to the first
animation-frame callback where the end state holds.

One end-state check serves both modes. It requires:

- The host slot is ready for provider `core`, and the canvas has its desktop
  panel or phone sheet open attribute.
- The connected provider iframe is displayed, visible, has positive opacity
  and size, and intersects the host viewport.
- Its accessible same-origin document has `data-cloud-panel-ready="core"`.
- The expected heading in the Help results has nonempty text, visible styles,
  nonzero size, and intersects the frame viewport.

A loaded document or ready message alone never counts. The first animation
frame in which all conditions hold records the content timestamp. There are
no sleeps or network-idle waits. A 45-second probe deadline stops its loop
and reports the last failing condition, slot state, iframe URL, readiness,
and elapsed time; Playwright has a separate timeout backstop. Uncaught
errors, unhandled rejections, and island errors in the host or Help provider
fail the sample, including errors before the document hop.

### Read panel timings

| Number | Meaning |
| --- | --- |
| `panelContentMs` | Desktop navigation start → first frame with visible Help content |
| `hostTtiMs`, `hostLcpMs` | New host document's TTI using the existing definition, and LCP when supported |
| `panelLagMs` | `panelContentMs − hostTtiMs`; a negative value means Help appeared before host TTI |
| `navigationGapMs` | New host navigation start minus the saved assign epoch; an anchor diagnostic |
| `assignToContentMs` | Assign epoch → visible Help content, including the navigation gap |
| `openToContentMs` | Phone trusted Help press → first frame with visible Help content |
| `providerReadyMs` | First observed provider ready mark, converted to the host timeline; readiness alone is insufficient |
| `providerTtfbMs` | Provider document `responseStart − requestStart`, including gateway and link |
| `providerDocumentBytes` | Provider document response body plus headers from Playwright `request.sizes()` in either engine |
| `providerIslandRenderMs` | Sum of the provider's initial island clear-and-render windows; read only after all initial islands mounted |
| `providerStatic` | Provider eager/lazy build weight and island count, fetched once per navigation from the actual SSR iframe URL with the session and panel cookie |

The time split has four consecutive segments in host-timeline milliseconds:

| Segment | Boundaries | Interpretation |
| --- | --- | --- |
| `hostWaitMs` | Anchor → first iframe element with a source in the host DOM | Waiting behind the host document; for sheet, waiting after the tap |
| `frameStartMs` | Iframe element → iframe document's navigation start | Iframe start, including lazy-iframe deferral |
| `providerSsrMs` | Iframe navigation start → provider `responseStart` | Provider SSR / TTFB including gateway and link |
| `providerClientMs` | Provider `responseStart` → visible Help content | HTML transfer, provider JS and islands, ready mark and slot reveal |

Iframe navigation and response timestamps are converted using the difference
between iframe and host `timeOrigin`. The probe watches DOM insertion and
checks parser-inserted frames at `DOMContentLoaded`. A MutationObserver
reports an insertion only after the inserting task, so when the frame's
navigation already started (a script-inserted frame on the phone), that start
ends `hostWaitMs` and `frameStartMs` is 0. It observes the ready mark each
animation frame. Boundaries are rounded before subtraction, so
the four segments sum exactly to the rounded main duration.

Each table shows per-metric median (min–max). The printed split and its
percentages come from one **median sample**, selected by sorting samples on
`panelContentMs` or `openToContentMs` and taking index `floor((n − 1) / 2)`.
For an even run count this is the lower middle sample; individual metric
medians still use the existing average-of-middle-values rule.
`dominantSegment` names that sample's largest segment for each profile. The
overall dominant segment sums those median-sample segments across all
verdict-relevant rows: desktop column/drawer in both engines and WebKit sheet.

### Verdict and the F10 decision

A complete run is **not slow** when every navigation meets both rules:

- Both engines, column and drawer: median `panelLagMs` ≤ **400 ms**, the
  Doherty threshold.
- WebKit sheet: median `openToContentMs` ≤ **1,000 ms**, the RAIL flow limit.

Any required median above its limit makes the verdict **slow**. Chromium
sheet is information only and never changes the verdict. A missing, skipped,
or failed required profile makes it **incomplete**, with the affected rows
named. WebKit retains the existing connection-skip behavior, so an unavailable
WebKit yields an incomplete verdict. Any failed panel profile still exits 1,
including an informational Chromium sheet failure. Partial profiles retain
raw samples but publish no aggregates.

The report names the worst desktop and phone medians and sets `borderline`
when either worst median is within 10% of its limit: **360–440 ms** or
**900–1,100 ms**, inclusive. Equality at 400 / 1,000 passes and is borderline.
Inspect ranges and repeat noisy or borderline results on a quieter host.

Read `dominantSegment` before attributing a slow result to document
navigation. F10, a client router, removes only in-app document loads. It does
not remove cross-app document loads or the provider's own SSR, JavaScript,
and island cost. Compare `spaces-to-mail` with the in-app rows to distinguish
those costs when deciding whether F10 should precede Assistant and Chat.

### Recorded panel results

On 20 October 2026, `--panel --runs 5` measured Help before and after it moved
from one reader island to server HTML with small islands (#1624). Before ran on
`7fa53cd5b` with load average 18.3 → 32.5; after ran on `b16c8e403` with load
average 14.6 → 23.3. The after run had less load, so small gains are within
noise. Each cell gives the median before → after. Lag is `panelLagMs` for column
and drawer and `openToContentMs` for the sheet.

Chromium:

| Navigation | Layout | Lag or opening ms | Frame start ms | Provider client ms |
| --- | --- | ---: | ---: | ---: |
| spaces | column | -40 → failed | 0 → failed | 419 → failed |
| spaces | drawer | -69 → -34 | 0 → 0 | 449 → 415 |
| spaces | sheet | 2,227 → 2,174 | 0 → 0 | 1,925 → 1,794 |
| mail | column | -10 → -16 | 0 → 0 | 379 → 365 |
| mail | drawer | -10 → -16 | 0 → 0 | 503 → 352 |
| mail | sheet | 2,270 → 2,106 | 0 → 0 | 1,934 → 1,690 |
| notebooks | column | -591 → -90 | 0 → 0 | 435 → 832 |
| notebooks | drawer | -523 → -96 | 0 → 0 | 634 → 979 |
| notebooks | sheet | 1,966 → 1,615 | 0 → 0 | 1,629 → 1,307 |
| spaces-to-mail | column | -37 → -29 | 0 → 0 | 564 → 398 |
| spaces-to-mail | drawer | -63 → -93 | 0 → 0 | 540 → 418 |
| spaces-to-mail | sheet | 2,334 → 2,029 | 0 → 0 | 1,934 → 1,729 |

WebKit:

| Navigation | Layout | Lag or opening ms | Frame start ms | Provider client ms |
| --- | --- | ---: | ---: | ---: |
| spaces | column | 314 → 298 | 715 → 669 | 1,228 → 1,140 |
| spaces | drawer | 397 → 325 | 563 → 465 | 646 → 677 |
| spaces | sheet | 785 → 686 | 13 → 15 | 706 → 611 |
| mail | column | 329 → 578 | 934 → 992 | 1,297 → 1,290 |
| mail | drawer | 307 → 384 | 803 → 714 | 937 → 933 |
| mail | sheet | 803 → 733 | 14 → 12 | 692 → 621 |
| notebooks | column | 464 → 656 | 1,362 → 1,084 | 2,222 → 1,902 |
| notebooks | drawer | 631 → 671 | 785 → 910 | 2,146 → 1,970 |
| notebooks | sheet | 609 → 467 | 13 → 13 | 479 → 348 |
| spaces-to-mail | column | 756 → 326 | 2,000 → 781 | 1,491 → 751 |
| spaces-to-mail | drawer | 449 → 177 | 1,122 → 748 | 1,498 → 807 |
| spaces-to-mail | sheet | 1,248 → 606 | 13 → 12 | 1,136 → 500 |

The provider's eager JavaScript went from 152,235 B Brotli in 2 islands to
70,007 B in 7 islands; on-demand JavaScript went to 84,970 B. WebKit sheet
openings now meet the 1,000 ms limit in every row. WebKit desktop lag still
misses 400 ms for Notebooks and once for Mail. Those medians are dominated by
provider client time and frame start (#1601), and provider client time barely
moved in WebKit: the provider document still parses about 150 KB Brotli of CSS.
That cost and frame start remain for F10. One Chromium column run failed on a
host-side read of the provider document (#1633).

`packages/core/src/pages/help/panel.bundle.test.ts` keeps a budget of 49 KiB
eager Brotli for the panel's islands: their own split production closure
measured 46,859 B, plus 5 %, rounded up to the next KiB. Core's real build
serves more, because its shared chunks also carry code of other Core islands,
such as the Markdown editor. `PanelRuntime`'s workspace controller is about
11 KB of the served figure. A quarter of the WebKit sheet limit at the documented phone
rate of 200,000 B/s is 50,000 B.

### Mail observations and limits

Once per engine, after the Mail navigation profiles, a column observation
opens the Mail overview with Help visible and changes its real segmented
view control. It waits for both the URL's `?view=` and the selected view to
change. Host and provider window tokens, provider `timeOrigin`, and provider
document requests detect a host or panel reload. If the seeded mailbox has
a selectable folder link, the harness observes a folder switch the same way.
An unconnected mailbox usually exposes no such link; that limitation is
recorded explicitly. Observation failures are recorded without failing the
run. JSON stores the engine, switch, reload result (or `null` when unknown),
and note; the summary includes a human-readable sentence.

These measurements emulate devices locally on a shared VM; they are not real
phone measurements. Chromium's phone profile is throttled, WebKit is not.
The header's start/end load averages help identify contention. Help is the
only measured provider. The mailbox is unconnected and empty; no IMAP,
message hydration, or populated folder behavior is measured. Unit tests
verify the probe and verdict contracts, not production performance.

## Measure Mail at mailbox scale

`packages/mail/scripts/perf-baseline.ts` measures the Mail server and its APIs
at a realistic mailbox size. It reuses this page's isolated production stack.
With `--browser`, it also measures client cost and interaction times in
Chromium and WebKit on the same two seeded mailboxes:

```bash
bun --no-env-file packages/mail/scripts/perf-baseline.ts --runs 5
bun --no-env-file packages/mail/scripts/perf-baseline.ts --browser chromium,webkit
```

The script needs Docker and takes the machine-wide heavy lock. It creates and
removes only its own labelled containers, publishes them on free loopback
ports, and never uses port 3000 or the development database. Builds and
startup take 5–15 minutes. Seeding 20,000 messages takes about 2 minutes per
mailbox, and measuring takes 2–5 minutes; a busy host takes longer. The browser part adds
roughly 10–30 minutes. `--help` lists every flag without starting Docker.

### Measure actual page changes

Add `--page-changes` to a browser run to measure overview → mailbox,
mailbox → automations, and automations → mailbox through their rendered
links and menu controls. Mail need not opt into page swapping: before the
pilot, these rows record full document loads as the current baseline.
For a focused run with the same seeded fixture:

```bash
bun --no-env-file packages/mail/scripts/perf-baseline.ts \
  --browser chromium,webkit --browser-runs 3 --browser-only \
  --page-changes --loads none --interactions none \
  --compare <earlier-mail-result.json>
```

The result uses Mail schema version 2. `--compare` and `--rank` also accept
validated schema 1 results. Migration preserves existing samples and leaves
new page-change measurements absent; an older result provides no evidence
for these gates. Page baseline results remain incompatible.

Each browser/profile has separate cold and warm rows. Cold starts from a
fresh context; Chromium keeps its HTTP cache disabled through the change.
WebKit has no equivalent cache-disable command, so its start document may
already have cached shared assets. Warm visits each destination first with
caching enabled. Chromium trusts only the run's local certificate public
key through an SPKI pin, allowing its HTTP cache to work. The harness reads
only the public localhost leaf certificate from the tracked Caddy container,
checks its run label and image, then addresses that container by its immutable
ID. A CA certificate, wrong hostname, or expired leaf fails the run; the pin
is never learned from an unverified network connection. The run-owned Playwright
server permits launch arguments (`run-server --unsafe`) so Chromium receives
the pin; Playwright otherwise filters it out. This disposable server shares
Caddy’s network namespace and is published only on loopback. Its clients must
be trusted, because this mode also accepts other launch options. WebKit uses its
existing certificate-error override. A warm sample fails if eager JavaScript
before destination readiness transfers any bytes; a document load also fails
if its eager script entries are missing. A swap can reuse evaluated modules
without another resource entry. This guard covers eager JavaScript, not lazy
code requested by the first action, API responses, or database caches.

| Field | Observation |
| --- | --- |
| `clickToMainMs` | Trusted pointerdown until a frame finds destination content in the viewport: a mailbox row or the Automations heading. |
| `clickToFirstActionMs` | Until a trusted input has a visible response: the mailbox selection toolbar or the app menu on Automations. The open Help column can hide the sidebar settings button even at desktop width, so both profiles use the visible app menu. Both the destination-content island and the action's island must be mounted, and the action must be enabled. Includes the driver's dispatch delay; this is an upper bound. |
| `documentLoad` | Host `performance.timeOrigin` changed. |
| `panelReloaded` | The Help iframe was replaced/disconnected, its document time origin changed, or another provider document request occurred. |
| `panelContextMs` | First frame with the ready, visible Help heading and expected topic: `mail-work` for the mailbox; the start heading without a stale view section for Automations. |
| `htmlBytes`, `jsBytes`, `cssBytes` | Encoded transfer bytes for requests begun during the change through the first action and panel result. Chromium uses CDP `encodedDataLength`; WebKit uses the combined response body/header estimate. The request set is frozen and given 10 seconds to settle; missing, failed, or unsuccessful required responses fail the sample. Cached Chromium responses contribute zero. The destination must return the expected HTML page; the warm guard separately checks Resource Timing. |
| `eagerJsTransferBytes` | Resource Timing transfer bytes for JavaScript requested before destination readiness. Must be zero in a warm row. |

Desktop uses the real open Help column. Phone times use the existing
390×844 profile and Chromium CPU/network throttling; its panel is unavailable
in this test and has null panel metrics. WebKit remains unthrottled.
Failures and unavailable engines remain visible in the result and summary;
a failed measured profile makes the command fail.

Native uncaught exceptions, unhandled rejections, and island failures are
recorded across the host and same-origin provider documents through the tab's
shared session storage. Playwright's WebKit `pageerror` also includes handled
fetch denials, so it does not define this error
boundary. Required document, script, and stylesheet responses retain their
separate strict network checks.

Request starts use the same browser-time window in Playwright and Chromium's
CDP evidence. Both window boundaries retain fractional epoch milliseconds,
matching browser request timestamps. Rounding the end down to a whole
millisecond can discard a request that started before the observed end.
Playwright exposes start timing with the response; a delayed event for a request begun before the measurement is excluded after that
timing becomes available. Required requests inside the window still need
their own successful response and transfer evidence.

The Chromium desktop sequence records a GC snapshot at the start and after
50, 100, and 150 alternating mailbox/automations changes. It reports heap,
DOM nodes, all DOM listener counts, registered window/document listeners,
pending timers, and live EventSource/WebSocket objects. Listener counts honor
capture, `once`, removal, and aborted signals. Instrumentation runs only in
this sequence; it removes its own references to detached islands before GC.
The first 20 changes also count document and panel reloads. Full document
loads reset the heap, so this baseline cannot establish cleanup across swaps.

The fixed pilot limits remain **203 ms desktop / 821 ms phone** for both
main content and first action, half the historical 406 / 1,642 ms document
references. Current document-load rows are additional evidence and never
move those limits. Zero panel reloads across 20 changes and the 3×50 cleanup
observations still need the later Mail opt-in. This harness alone makes no
pilot or hydration go decision.

### Fixture

The runner creates two readable mailboxes, A and B, for the same user through
`POST /api/mail/mailboxes`; B appears in A's sidebar. Both are always seeded,
even when browser measurements are filtered.
`packages/mail/test/fixtures/large-mailbox.ts` builds each mailbox from a fixed
seed and a frozen anchor date (`2026-10-01T00:00:00Z`), so two runs with the
same flags seed the same rows. The defaults per mailbox are 20,000 messages, 3,000
conversations, and 30 folders; `--messages` (up to 100,000),
`--conversations`, `--folders`, and `--seed` change them. Use
`--folders 350` for the folder scale reported in #1268. B has the same requested
shape with seed + 1 (wrapping to 0 after 4294967295), different content, and
short IDs reserved against A to prevent global unique-key collisions.
Metadata records B's fixture parameters, digest, and seed duration separately;
`seedDurationMs` continues to describe A.

The shape follows a real shared mailbox: large Inbox and Archive, many small
folders in a tree, 70% of threads with 1–3 messages, a tail up to 99, and one
180-message thread that exceeds the detail limit of 100. About 5% of messages
are unread, 10% have an attachment, and 30% are HTML-only with 2–50 KB bodies.
Every date lies before the anchor, and snoozes lie in 2099, so results do not
depend on the day of the run.

The fixture writes the same tables as real ingest and hydration through the
persistence boundary. An integration test ingests one message through
`ingestEnvelope` and fails if the fixture leaves a table or column empty that
real ingest fills.

### Scenarios and results

Each scenario runs once cold and then `--runs` times warm: SSR of the mailbox
and of the large thread, list pages 2–5 through `workspace-route` and the
public conversation list, conversation detail for a small, the large, and an
HTML-heavy thread, rare, common, and structured search, three folder switches,
view counts, a message arriving live, and opening compose for a new message
and a reply. `list-paging-workspace` loads page 1 through `workspace-route`
as an untimed cursor prerequisite, then measures list pages 2–5 through
`workspace-list`. `folder-medium-list` measures page 1 of the medium folder
through `workspace-list`. The Mailbox switch group adds
`mailbox-switch-route`, a GET of B's `workspace-route?href=/app/mail/<B>`,
and `ssr-mailbox-b`, a document GET of `/app/mail/<B>`. The other scenarios
continue to target A.

For each scenario the run records cold, median, and p95 times, response and
island props bytes, Server-Timing phases, and the statement count and
database time from `pg_stat_statements`. It also keeps the `auto_explain`
plan of the slowest statement, from one extra pass that is not timed.

The result is `.local/mail-perf/<UTC timestamp>/result.json` and
`summary.md`; existing files are never overwritten. Pass
`--compare <earlier result.json>` to add median deltas to the summary.

### Browser part

`--browser chromium,webkit` runs after the server scenarios, on the same
installation, once SQL plan logging (`auto_explain`) is off again; if it
cannot be turned off, the browser part fails instead of measuring. It starts the run-owned Playwright container from this page
and uses the same desktop and phone profiles, throttling, TTI definition, and
transfer sizes. `--browser chromium` or `--browser webkit` measures one
engine. `--browser-runs N` (1–20, default 3) sets the cold loads per page,
interaction, engine, and profile. WebKit may skip with a recorded connection
error, as on the page baseline.

`--interactions <ids>` selects a comma-separated list from the interaction
table below (default: all eight). `--loads mailbox,compose` selects standalone
page-load measurements (default: both); `--loads none` skips them. Unknown or
duplicate IDs fail before startup; `none` cannot be combined with page IDs.
These flags leave server scenarios and seeding unchanged. For a focused
before/after run:

```bash
bun --no-env-file packages/mail/scripts/perf-baseline.ts --runs 3 \
  --browser chromium,webkit --browser-runs 5 \
  --interactions mailbox-switch,folder-switch --loads none
```

For a browser-only remeasurement, add `--browser-only` with `--browser`.
Both mailboxes are still seeded, but `scenarios` stays empty and no server
scenario adds messages or draft seeds or warms the server caches. Matching
fixture digests alone do not establish equivalent cache conditions. Each browser sample logs its UTC
start and end, including start-page loading, so an external load disturbance
can be matched to individual samples. Preserve disturbed results and rerun
only affected measurements; do not silently combine incomplete profiles.

By default, two pages are loaded: the mailbox and the compose page of a fresh draft. For
each page the result has the eager and lazy JavaScript (Brotli bytes and
module count) and, per engine and profile, FCP, LCP, TTI, the end of the
last initial island mount, the island render time (the union of the initial
islands' clear-and-render windows), long tasks (count and total, Chromium
only), and total blocking time. One extra Chromium load per page and profile
records a trace, which is not part of the timings because tracing slows the
page. Its main-thread task time from navigation to TTI is split into the
shares of island rendering, style and layout, and JavaScript parse and
compile. The shares can overlap; for example, an island render can force a
layout.

The Document transfer column shows the HTML body download time
(`responseEnd - responseStart`), its transferred bytes, and its content
encoding. An absent `content-encoding` header is recorded as `identity`.

Eight interactions share one definition for both engines and both profiles.
Each sample opens its start page in its own fresh page, waits for TTI, and
then times one action:

| Interaction | Action | Ends when |
| --- | --- | --- |
| `mailbox-switch` | From A's Inbox, click B in the sidebar; on the phone, open the app navigation sheet first | B's first Inbox row from workspace-route page 1 is on screen, the pathname is `/app/mail/<B>`, the workspace island containing the row has mounted, and the list/main pane is not busy |
| `folder-switch` | Click the fixture's first custom folder in the navigation; on the phone, in the opened app menu | The heading names that folder and its first row is on screen |
| `conversation-open` | In the fixture's first custom folder, click the first conversation whose newest message has a body. Live arrivals land in the Inbox as envelopes without a body, so this folder keeps a body to render after any number of runs | The body of that newest message is on screen in the reader; an HTML body also needs its message frame to report its laid-out height |
| `conversation-open-large` | Start with a mailbox-wide exact subject search for conversation 0 (`Project correspondence 0`, newest first), then click its conversation row. This isolates `plan.shape.largestThreadId` on page 1 without scrolling; live arrivals have different subjects. Before each sample, the workspace API must return that row on page 1 or the sample fails with the start href | The reader loads the newest 100 messages of the thread (180 messages by default). The newest message's body is on screen, with a body-format marker; an HTML body also needs its frame to report its laid-out height. A missing newest body fails the sample |
| `list-scroll` | Scroll the list to its end | The first row of page 2 is in the list |
| `search-submit` | Type the fixture's rare word into the search field and press Enter in one driver call; the timer starts at the Enter keydown | The heading names the search and its first result is on screen |
| `live-arrival` | A message is ingested through `ingestEnvelope` against the run's database | The new row is on screen |
| `compose-open` | Click Compose; on the phone, in the opened app menu | The body editor is mounted, on screen, and writable |

The expected rows and messages come from the same workspace API the client
calls, read just before each sample. The timer starts at the trusted input
event in the page: the pointer press, or for `search-submit` the Enter
keydown. A search sample fails if Enter comes 300 ms or more after the typed
input, because the debounced search may have started first. For `list-scroll` it
starts when the page sets the list's scroll position. For `live-arrival` it
starts at the ingest commit, and the page waits for its live subscription
before the message arrives. The
timer stops in the first animation frame in which the end state holds, so
the result is the time until that frame paints, not network idle. Times are
wall-clock milliseconds; the browser container shares the host clock. An end
state that already holds before the action fails the sample. After `compose-open`,
the harness types one character and fails the sample if the editor does not
take it. An interaction sample also fails on an uncaught error or rejection
or on an island error in any of the app's documents during the sample, so an
error in the start page still counts after compose navigated away. Errors
inside the sandboxed message frame do not count.

`mailbox-switch` uses the same end state for a full document load and an
in-place workspace fetch. It uses the load probe's existing runtime mount
signal, so SSR rows cannot finish the timer before MailWorkspace mounts;
an already mounted workspace also works when switching in place. The watch
persists in sessionStorage and the probe runs in the destination document.

Each interaction records the requests that started from the
action until its end state, with their encoded response bytes and content
encoding (`identity` when the header is absent); a request
that a navigation cancels counts with its error and no bytes. The summary
shows the API requests and bytes, and lists request encodings. Failed or
unsettled requests have `null` encoding. For mailbox and folder switches,
`mainRequest` identifies the destination document or workspace-route/workspace-list
fetch. Samples and the summary include its server time (`responseStart -
requestStart` from Playwright request timing), transfer time (`responseEnd -
responseStart`), encoded body bytes, and encoding. These times exclude
connection setup; bytes for the other request totals still include headers.
A browser can report an unavailable body size as a negative value for a cached
response. That sample still counts: `encodedBytes` is omitted, and request
totals include only the known nonnegative body and header sizes. They are a
lower bound when a size is unavailable.

Definitions with `trace: true` (`mailbox-switch` and `folder-switch`) add one
extra traced Chromium sample per profile, excluded from timing samples.
The **Interaction breakdown** table shows elapsed total, main-request server
and transfer time, and main-thread task time split into JavaScript execution,
parse/compile, island render, style/layout, and other, with shares of busy
time. Busy time is the union of those main-thread task windows. The task window runs from the action to the end state. Renderer main
threads are selected from the page's frame metadata, including a replacement
renderer after navigation. Island render is the union of mount windows in
that interval (zero when no island mounts); it owns nested JS, compile, and
layout work. Remaining compile and layout work take precedence over JS, so
these interaction shares do not overlap.

Every sample uses a fresh browser context, so each start page loads cold.
The interaction then reuses what that load cached, as for a person who just
opened the page: Chromium turns its cache back on after the start page, and
WebKit keeps the context's cache. JavaScript and styles that only the next
page needs, such as compose, still load from the network. These are local
emulations in a container, not measurements on real phones.

### Recorded mailbox-switch results

On 20 October 2026, five samples per engine and profile compared document
navigation on `c4b305b9d` with the in-place mailbox-switch checkpoint
`d9137b4bd`. Both mailboxes used the default fixture above, with seeds
20261001 and 20261002 and matching fixture digests between runs.
Playwright was 1.64.1, Chromium 156.0.8078.4, and WebKit 27.2.

These are observations from a busy shared host with 24 logical CPUs, **not
isolated performance results**. The one-minute load average was 29.9 → 32.7
for the Chromium before run, 16.4 → 25.7 for the earlier WebKit before run,
and 32.2 → 24.1 after. Another lane's tests, browser fixtures, and typecheck
overlapped the after run from 18:03:38 to 18:12:02 UTC. This affects both
Chromium profiles, WebKit desktop, and the beginning of WebKit phone
(18:11:55–18:12:40). The original output has no per-sample UTC bounds, so no
individual WebKit phone sample can be certified as undisturbed. All before
samples are retained; the first after values below are disturbed observations.
The later browser-only remeasurement follows them separately.

Each cell is median (min–max), in milliseconds:

| Engine | Profile | Before | First after, disturbed |
| --- | --- | ---: | ---: |
| Chromium | Desktop | 1,436.9 (1,240–1,949.9) | 639.5 (605.9–675.7) |
| Chromium | Phone, CPU/network throttled | 6,127.8 (5,878.6–6,500.2) | 2,539.3 (2,227.4–2,590.2) |
| WebKit | Desktop | 4,755 (3,874–6,565) | 1,874 (1,682–4,409) |
| WebKit | Phone viewport, unthrottled | 4,142 (3,906–4,707) | 1,394 (1,115–2,282) |

The Chromium phone median fell by about 59%. The desktop target of less
than 300 ms was **not met** in either engine. WebKit's phone row changes the
viewport and input mode only; it is not comparable to Chromium's throttled
phone profile.

The main request changed from an uncompressed document of about 470 KB to
one uncompressed `workspace-route` response of about 57 KB. Chromium's
median server/transfer times changed from 333.5/5.2 to 168.7/1.1 ms on
desktop and from 278.3/2,348.8 to 179.5/278.7 ms on the phone. Independent
warm server scenarios measured B's workspace route at 209.3 → 189.0 ms and
B's SSR document at 306.3 → 290.0 ms. The interaction improvement therefore
also removes document transfer and client work; it does not establish a
large server-side speedup.

The extra Chromium traces, excluded from the five timing samples, give this
disjoint main-thread breakdown. All values are milliseconds:

| Profile / version | Elapsed | Busy | Island mount | Style/layout | JS execution | Parse/compile | Other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop before | 1,354.6 | 1,095.8 | 565.2 | 317.8 | 33.0 | 13.3 | 166.4 |
| Desktop after | 699.7 | 583.9 | 0 | 236.7 | 26.1 | 0 | 321.1 |
| Phone before | 6,916.8 | 6,575.0 | 2,201.4 | 2,896.8 | 286.8 | 81.2 | 1,108.8 |
| Phone after | 2,308.6 | 2,020.3 | 0 | 597.0 | 123.9 | 0 | 1,299.4 |

The after trace has no new SSR island mount: the outer island stays mounted
and recreates its mailbox content inside Solid. Zero in that column does
not mean rendering is free; its work remains in the other categories.
The list already fetches 50 rows and uses `content-visibility: auto` for
offscreen rows. These traces do not isolate a further row-window change as
the next fix.

The before WebKit samples come from
`.local/mail-perf/2026-10-20T16-49-52.806Z/result.json`. That run's Chromium
profiles failed because cached responses reported negative body sizes;
their results are excluded. Only Chromium was repeated in
`.local/mail-perf/sol-before-20261020/result.json`, reusing the same before
application bundles with the measurement-size correction. The after run is
`.local/mail-perf/sol-after-20261020/result.json`, built from its recorded
clean checkpoint. All four after profiles completed five samples, with no
server, browser, or cleanup errors.

#### Browser-only remeasurement

The single follow-up run used the same application bundles built from
`d9137b4bd`, without rebuilding or repeating server scenarios or before
measurements. Before/after aggregate hashes of the core, Mail, and gateway
bundle files matched. Its recorded source is `5f7b80d28` with the new scroll
regression test uncommitted; that source marker identifies the measurement
harness, rather than a new application build. Both fixture digests match the
earlier runs.

The run held the default machine heavy slot from 18:55:08 to 19:02:42 UTC.
Lock snapshots at its start and 18:59:41 showed only that holder, after the
other lane's extra-slot work ended. This establishes the checked scheduling
boundaries, not an idle host: the one-minute load average was 23.86 → 18.47
on the same 24 logical CPUs, with background services and unrelated work.
The retained log records UTC bounds around every sample; the JSON timing
samples themselves have no epoch fields.

| Engine | Profile | Sample window, UTC | Median (min–max), ms |
| --- | --- | --- | ---: |
| Chromium | Desktop | 18:59:13–18:59:29 | 766.0 (619.7–830.7) |
| Chromium | Phone, CPU/network throttled | 18:59:33–19:01:03 | 2,448.1 (2,151.7–2,960.6) |
| WebKit | Desktop | 19:01:21–19:02:00 | 1,866 (1,721–4,426) |
| WebKit | Phone viewport, unthrottled | 19:02:00–19:02:37 | 1,051 (996–1,348) |

All four profiles completed five samples, with one workspace request per
switch and no runner, browser, or cleanup errors. Chromium's main response
was about 57 KB; median server/transfer time was 201.5/1.0 ms on desktop and
209.5/279.1 ms on the throttled phone. Its phone median was about 60% below
the retained before measurement. The desktop target below 300 ms remains
unmet in both engines.

The two separate Chromium trace samples, excluded from those medians, were:

| Profile | Elapsed | Busy | Island mount | Style/layout | JS execution | Parse/compile | Other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop | 1,010.6 | 818.0 | 0 | 261.2 | 32.0 | 0 | 524.8 |
| Phone | 2,710.9 | 2,364.9 | 0 | 599.3 | 118.0 | 0 | 1,647.6 |

The result is
`.local/mail-perf/sol-after-browser-only-20261020/result.json`. Browser-only
mode omits the earlier server scenarios' cache warming and fixture mutations;
matching fixture digests do not establish equivalent cache conditions. Keep
that limitation and the shared-host load alongside the observed reduction.

Mailbox history now uses the shared SSR scroll-restoration completion
contract: the destination restores after its asynchronous list content
commits. Chromium and WebKit each pass the nonzero A/B scroll guard, including
a delayed response followed by rapid Back/Forward reversal and Reload.
Server, hydrated, and settled geometry agree. The existing guards also cover
retained document/sidebar identity and mailbox URL parity. These correctness
checks do not change the measured checkpoint or remove its timing limitations.

### Rank bottlenecks

After a run, rank candidate bottlenecks against its result:

```bash
bun --no-env-file packages/mail/scripts/perf-baseline.ts \
  --rank .local/mail-perf/<run>/result.json --bottlenecks candidates.json
```

`candidates.json` is a list of entries with `title`, `location`
(`path:line` relative to the repository), `anchor`, `metric`, `evidence`, and
`slice`. Copy the complete source line at `location` into `anchor`, without
leading or trailing whitespace. The line must be non-empty and match the
anchor exactly. If code moves or changes, review the location and anchor
before ranking again; a stale reference fails instead of ranking silently.
The `metric` names a measured time in that result, for example
`interaction.folder-switch.chromium.phone.median`,
`load.mailbox.webkit.desktop.ttiMs`,
`trace.compose.chromium.phone.styleLayoutMs`,
`interactionTrace.mailbox-switch.chromium.phone.styleLayoutMs` (also
`scriptMs`, `parseCompileMs`, `islandRenderMs`, `otherMs`, `busyMs`, and
`totalMs`), or
`server.search-common.totalMs.median`. The command prints the five entries
with the largest measured times as a Markdown table. It refuses an entry
whose location is not an existing non-empty line matching its anchor, or whose
metric has no number in the result, and it needs at least five entries. It also refuses
a list that mixes `server.` metrics with browser metrics: a server request
time and a throttled browser time do not measure the same thing. Pick the
metric that isolates the named cost, for example the island render time
rather than the whole TTI for a render cost. It starts no Docker and takes
no lock.

### Limits

- No provider connection: IMAP fetch and hydration time are not measured.
  The Mail connector accepts only public hosts with verified TLS.
- HTML-only bodies are seeded words in one paragraph. They reproduce the
  byte volume of HTML mail, not the tables, inline styles, and nesting of
  real newsletters, so render cost for complex HTML can be higher.
- Plain PostgreSQL has no BM25 index, so search uses the fallback path. The
  summary records whether the index exists.
- Core and Mail background work keeps running. The summary shows its
  statement rate from an idle window; scenario counts include it.
- Live arrival is ingested from the harness process, which cannot wake the
  Mail dispatcher, so the socket event waits for the 1-second reconcile.
  Real sync wakes the dispatcher right after commit.
- Cold means the first request of a scenario; caches are not flushed. Compare
  runs on the same quiet host rather than reading absolute numbers.
- The gateway compresses dynamic HTML and JSON according to `Accept-Encoding`.
  Eligible document and API transfer times reflect Brotli when the browser accepts it;
  the opt-outs above remain uncompressed.
  The run's Caddy does not compress responses.

## Measure Mail memory under hydration load

Use `packages/mail/scripts/memory-load.ts` to measure overlapping hydration,
attachment extraction, API reads and folder sync. Export the integration-test
targets `CLOUD_TEST_DATABASE_URL` (database name ending in `_test`),
`CLOUD_TEST_NATS_SERVERS`, and `CLOUD_TEST_VALKEY_URL`; include
`CLOUD_TEST_NATS_CREDS_FILE` when the test broker requires it.

```bash
bun --no-env-file packages/mail/scripts/memory-load.ts --profile guard --json
bun --no-env-file packages/mail/scripts/memory-load.ts --profile incident --seed 1549
```

The script takes the machine-wide heavy lock and creates a disposable
`mail_*_test` database and private Sync namespace. It drains runtimes and
removes both on success, failure, SIGINT or SIGTERM. A hard OOM or SIGKILL
cannot run cleanup.

`incident` (default) uses four mailboxes, each with 40 small folders and an
INBOX containing three 10–40 MiB messages (including one near 34 MiB) and
20 small messages. `guard` uses four mailboxes, two small folders each, and
one 10–24 MiB message plus two small INBOX messages each. Its target is under
90 seconds; this is not a timing guarantee. MIME sources stream lazily in
64 KiB chunks from a fixed seed and date, including newsletter HTML, inline
images, CSV and binary attachments. Message sizes include base64 overhead.

Use `--only hydration,extraction,api,folders` to select concurrent work;
omitted hydration finishes before the baseline. `--html-mib`, `--csv-mib`,
`--large-per-mailbox`, `--mailboxes` and the other `--help` flags vary the
fixture. Incompatible component and source sizes fail before bootstrap.
`--timeout-s` defaults to 900 seconds, separately bounding preparation and
measurement. Timeout, incomplete or missing messages, and missing generated
attachments produce a nonzero exit.

Each run writes a fresh `.local/mail-memory/<UTC timestamp>/` directory
(`--out` overrides it): `samples.ndjson`, `summary.json`, and `summary.md`.
The summary includes the manifest, baseline and peak RSS, nearest in-flight
state, heap peaks, main-thread tick gap, and correctness counts. `--json`
prints compact JSON as the last stdout line, omitting the manifest and
per-message correctness lists (both remain in `summary.json`). The summary
also records the processing budget high-water and largest item run alone;
the budget counters reset after warm-up and preparation.
`--heap-snapshot-mib N` writes one heap snapshot and object-type counts when RSS first exceeds the baseline by
N MiB; snapshot work perturbs the measurement.

RSS is sampled in a worker every 20 ms so synchronous work cannot hide peaks.
Main-thread heap samples (100 ms) and database samples (250 ms) pause during
stalls; database counts are approximate sequential reads. Extraction has no
separate running status, so running means pending with an attempt recorded.
State counts include the warm-up mailbox; correctness counts cover measured
fixtures. API traffic uses the real Hono app in process. IMAP is simulated:
these results include neither browser cost nor HTTP socket or provider latency.

`packages/mail/src/service/processing-memory.integration.test.ts` runs the
`guard` profile with hydration and API traffic in a child process, with a
300-second test timeout. It requires database, NATS and Valkey test targets
and uses its own disposable database. It checks that every generated message
completes and no attachment is missing, and that peak RSS above baseline stays
within `GUARD_PEAK_ABOVE_BASELINE_MIB` (600 MiB). On Linux x64 with glibc
and four CPUs, as on the CI runner, that run peaked at 650–669 MiB in three
runs before the processing memory budget and at 345–510 MiB in six runs with
it, so the limit fails every such run without the budget. On the full host,
it peaked at 482–633 MiB before and 391–491 MiB with it. Hydration must
reserve through the budget, and the estimated processing high-water must stay
within 256 MiB, except for an item above the budget that runs alone.
Attachment extraction stays out of this run: its memory is native and glibc keeps those
pages, so its peak varies more than the budget changes it. The `incident`
profile measures it. Failures report the summary path and key numbers. The
unit tests in `processing-memory-budget.test.ts` check FIFO admission, byte
limits, oversized items, cancellation and release after failure.
