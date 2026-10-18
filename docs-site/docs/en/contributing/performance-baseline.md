---
title: Measure production page performance
navTitle: Performance baseline
section: Contributing
order: 1311
description: Record repeatable page weight and cold-load timings from isolated production bundles.
tags: [contributing, performance, testing, ssr]
updated: 2026-10-18
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
for this origin; browser contexts ignore certificate errors and use a secure
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
conversation, and two folders with three empty Markdown files. Files uses a
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
`--pages`, `--runs`, `--skip-build`, `--out`, `--compare`, and `--keep`.
Output directories must stay inside the checkout. Existing result files are
never overwritten.

## Read the measurements

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
response end of every script loaded during the observation, and, in
Chromium, the end of the last long task. WebKit has no long-task entries.
Every script request the harness sees must have a resource timing entry.

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

## Measure Mail at mailbox scale

`packages/mail/scripts/perf-baseline.ts` measures the Mail server and its APIs
at a realistic mailbox size. It reuses this page's isolated production stack.
With `--browser`, it also measures client cost and interaction times in
Chromium and WebKit on the same seeded mailbox:

```bash
bun --no-env-file packages/mail/scripts/perf-baseline.ts --runs 5
bun --no-env-file packages/mail/scripts/perf-baseline.ts --browser chromium,webkit
```

The script needs Docker and takes the machine-wide heavy lock. It creates and
removes only its own labelled containers, publishes them on free loopback
ports, and never uses port 3000 or the development database. Builds and
startup take 5–15 minutes, seeding 20,000 messages takes about 2 minutes, and
measuring takes 2–5 minutes; a busy host takes longer. The browser part adds
roughly 10–30 minutes. `--help` lists every flag without starting Docker.

### Fixture

`packages/mail/test/fixtures/large-mailbox.ts` builds the mailbox from a fixed
seed and a frozen anchor date (`2026-10-01T00:00:00Z`), so two runs with the
same flags seed the same rows. The defaults are 20,000 messages, 3,000
conversations, and 30 folders; `--messages` (up to 100,000),
`--conversations`, `--folders`, and `--seed` change them. Use
`--folders 350` for the folder scale reported in #1268.

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
and a reply.

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

Two pages are loaded: the mailbox and the compose page of a fresh draft. For
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

Six interactions share one definition for both engines and both profiles.
Each sample opens its start page in its own fresh page, waits for TTI, and
then times one action:

| Interaction | Action | Ends when |
| --- | --- | --- |
| `folder-switch` | Click the fixture's first custom folder in the navigation; on the phone, in the opened app menu | The heading names that folder and its first row is on screen |
| `conversation-open` | In the fixture's first custom folder, click the first conversation whose newest message has a body. Live arrivals land in the Inbox as envelopes without a body, so this folder keeps a body to render after any number of runs | The body of that newest message is on screen in the reader; an HTML body also needs its message frame to report its laid-out height |
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
Each interaction records the requests that started from the
action until its end state, with their encoded response bytes and content
encoding (`identity` when the header is absent); a request
that a navigation cancels counts with its error and no bytes. The summary
shows the API requests and bytes, and lists request encodings. Failed or
unsettled requests have `null` encoding.

Every sample uses a fresh browser context, so each start page loads cold.
The interaction then reuses what that load cached, as for a person who just
opened the page: Chromium turns its cache back on after the start page, and
WebKit keeps the context's cache. JavaScript and styles that only the next
page needs, such as compose, still load from the network. These are local
emulations in a container, not measurements on real phones.

### Rank bottlenecks

After a run, rank candidate bottlenecks against its result:

```bash
bun --no-env-file packages/mail/scripts/perf-baseline.ts \
  --rank .local/mail-perf/<run>/result.json --bottlenecks candidates.json
```

`candidates.json` is a list of entries with `title`, `location`
(`path:line` relative to the repository), `metric`, `evidence`, and `slice`.
The `metric` names a measured time in that result, for example
`interaction.folder-switch.chromium.phone.median`,
`load.mailbox.webkit.desktop.ttiMs`,
`trace.compose.chromium.phone.styleLayoutMs`, or
`server.search-common.totalMs.median`. The command prints the five entries
with the largest measured times as a Markdown table. It refuses an entry
whose location is not an existing file and line, or whose metric has no
number in the result, and it needs at least five entries. It also refuses
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
- The browser part opens a short conversation, not the 180-message thread,
  so the client cost of a large thread is not measured.
- The gateway compresses dynamic HTML and JSON according to `Accept-Encoding`.
  Document and API transfer times reflect Brotli when the browser accepts it.
  The run's Caddy does not compress responses.
