---
title: Measure production page performance
navTitle: Performance baseline
section: Contributing
order: 1311
description: Record repeatable page weight and cold-load timings from isolated production bundles.
tags: [contributing, performance, testing, ssr]
updated: 2026-10-10
---

# Measure production page performance

Use `scripts/perf-baseline.ts` to compare rendering changes against minified
production bundles served through the gateway behind a Caddy TLS terminator.
It writes static page sizes and
cold browser timings to JSON, with median values in a Markdown report.

## Prepare the checkout

Run from the repository root with workspace dependencies installed. You need
Docker access and local Chromium with its system libraries for the workspace's
Playwright version (currently 1.63). WebKit runs in a separate, run-owned
Playwright noble container matching the root catalog version, following
[Run WebKit locally](/en/docs/contributing/testing#run-webkit-locally).
Image pull, startup, or connection failures record WebKit as skipped.

Build the shared UI output first:

```bash
bun run --cwd packages/ui build
```

If Chromium is missing, install it separately:

```bash
./packages/ui/node_modules/.bin/playwright install chromium
```

The harness reads the existing Playwright dependency from `packages/ui`; it
does not install local dependencies or browsers. Docker may pull missing
images, and the WebKit container may download its matching Playwright package.

## Run a baseline

```bash
bun --no-env-file scripts/perf-baseline.ts --runs 3
```

Allow approximately 5–15 minutes for builds and startup, plus the browser
loads. Downloads and slower hosts can take longer. Builds are sequential;
each app's build is capped at ten minutes, application readiness at three
minutes, and each browser load at 45 seconds. This is a planning estimate,
not a measured runtime guarantee.

The production command is the Dockerfile's build command with
`NODE_ENV=production`, the selected `APP_ID`, `CLOUD_VERSION=0.0.0-perf`, and
`CLOUD_RELEASE=perf`. Each bundle moves from root `dist/` into
`.local/perf-baseline/build/<app>/dist`. An existing root `dist/` blocks the
build so the harness cannot replace an unrelated artifact. Move it aside
within the checkout first. `--skip-build` reuses stored bundles; use it only
when they match the source you want to measure. Its recorded Git commit does
not establish the provenance of reused bundles.

The harness starts fresh PostgreSQL, NATS, Valkey, and application containers
on its own network. It reads the pinned Bun runtime image from `Dockerfile`,
mounts the bundles read-only, and runs `bun server.js` as `bun`. Caddy uses
the pinned `caddy:2.10.2-alpine` image with an internal certificate and
`reverse_proxy gateway:3000`. HTTP/2 uses Caddy's default configuration;
Caddy passes through the gateway's Brotli/gzip without re-encoding.
Only Caddy is published, on a free `127.0.0.1` port other than 3000. Every
application's `APP_URL` and the measured origin are `https://localhost:<port>`.
The harness trusts the private certificate only for that origin in Bun fetches;
browser contexts ignore certificate errors and use a secure session cookie.
The development stack is separate.

WebKit's container uses host networking so it can reach that loopback origin.
Its browser server binds to a separate free `127.0.0.1` port, and the harness
connects over WebSocket. Chromium runs locally. Both browser engines use
fresh contexts for each load.

Core's administrator-token login supplies an isolated session. The harness
accepts the fresh installation's legal terms for the throwaway administrator
through Core's public consent flow. It requires an authenticated `/api/me`
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

Each load uses a fresh browser context, the isolated session, English locale,
light theme, blocked service workers, and the `Europe/Berlin` time zone with
Cloud's time zone cookie already set, like a returning user. Without that
cookie, the first visit reloads once to render times in the browser's zone,
and the harness fails any load that navigates again:

| Profile | Viewport | Chromium | WebKit |
| --- | --- | --- | --- |
| Desktop | 1440 × 900, scale 1 | CPU rate 1, unthrottled network | No throttle |
| Phone | 390 × 844, scale 3, touch/mobile | CPU rate 4; 150 ms latency, 200,000 B/s download, 93,750 B/s upload | No CPU or network throttle |

Chromium transfers use CDP `Network.loadingFinished.encodedDataLength`;
WebKit uses `request.sizes()` response body plus header sizes. Requests and
bytes split into document, JavaScript, CSS, and other resources. Transfers
count completed requests up to TTI; open streams may have no completed byte
count. JavaScript and CSS content encodings are recorded. Uncompressed
Chromium JavaScript/CSS responses fail the profile. Build Brotli sizes and
actual transferred bytes are separate measurements, since a browser can
negotiate gzip and transfer headers add overhead.

**TTI** is navigation-relative time when every initial island/client wrapper
has mounted and script requests have been quiet for at least 500 ms, with no
script still pending. The probe observes the existing synchronous
`innerHTML = ""` followed by `render()` in the SSR mount runtime and marks
completion after that stack. An island-error event fails the load. The
45-second deadline fails the profile; it never becomes a numeric TTI result.
This definition must be reviewed if the mount runtime changes.

FCP, LCP, and CLS come from performance entries up to that observation point.
CLS sums layout shifts without recent input over the run. Unsupported entries
are `null`. Chromium also reports the last long-task end (0 when no long task
occurred) and total blocking
time: for each long task overlapping FCP through TTI, subtract 50 ms from its
overlap and sum positive remainders. WebKit long-task metrics are `null`.
These are bounded load observations, not final LCP/CLS over a user's visit.

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
presented as a complete median. WebKit setup/connect skips do not fail the run.
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
caches. TTI measures initial mounting and script quietness, not every later
interaction or data request. Treat small differences within the reported
range as inconclusive.
