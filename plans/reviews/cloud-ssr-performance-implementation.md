# Cloud SSR performance implementation

Status: 14 September 2026. The local implementation is committed. The maintainer
explicitly excluded release and deployment from this epic. Representative
production browser measurements have not been performed. Grids was excluded
from changes.

## Implemented behavior

- `054b141e1`: Plex WOFF2 files are separate, content-addressed assets. Core
  copies the referenced assets; obsolete WOFF fallbacks are removed. Common
  font CSS decreased from approximately 1.64 MB to 21,750 bytes. This describes
  CSS bytes, not a measured LCP improvement.
- `3c648cef9`: Notebooks serves versioned KaTeX CSS and external WOFF2 files
  on book/note reading and editor surfaces. Keeping CSS on the book surface
  preserves enhanced navigation from a book to a mathematical note.
- `e2898c760`: Mail starts independent overview reads concurrently, preserves
  the recent-mailbox redirect's short path, and fetches deleted mailboxes only
  when their disclosure opens. Loading, retry, pagination, and restore remain.
- `2a7c6d2e0`: Spaces seeds the selected work view and counters through SSR.
  Switching views uses an authenticated endpoint backed by the same service.
  Superseded requests are aborted; stale results cannot replace the active view.
  Private-space access and permission revocation remain enforced.
- `876bb789d`: SSR records request-local auth, settings, runtime, data,
  finalization, and render phases in Server-Timing. Authenticated documents
  report LCP, INP, and CLS through a small self-hosted bundle to the existing
  logs. The endpoint accepts bounded diagnostic fields, not concrete URLs,
  DOM entries, page text, or user IDs.
- SSR repository `6955d3a`: the production adapter negotiates Brotli, gzip,
  and identity representations, including quality values, HEAD, Vary, lengths,
  and unacceptable representations. Development behavior remains unchanged.
  **Cloud still uses published SSR 0.13.1, so this fix is not integrated yet.**

Notebooks and Spaces activity stays server-rendered: desktop layouts expose it
permanently even though mobile uses a dialog. Removing that snapshot would
change initial visible behavior. No global Context, search, profile, or dialog
lifecycle redesign was introduced.

## Verification

Focused verification covered font references and packed UI consumption;
Notebooks stylesheet placement and navigation; Mail disclosure failure, retry,
and pagination; Spaces initial data, cancellation, history navigation, errors,
and database-backed permission parity. The Spaces integration fixture was
removed after testing. Direct Notebooks, Mail, Spaces, and final Cloud
TypeScript checks passed. The UI build, frozen dependency installation, and
workspace dependency check passed.

The SSR repository passed 111 unit tests, 11 browser tests, and its typecheck.
Cloud timing/auth/API checks passed 9 tests; locale/route-template checks passed
12 tests. These test counts describe separate focused runs, not a full Cloud
monorepo test run. Foreign concurrent changes were preserved.

Production builds completed for Notebooks, Mail, Spaces, and Contacts in
isolated temporary output directories, without starting application services.
Mail emitted an existing nested-island import warning for MailComposerPage;
this pass does not claim to resolve that composition. All 534 generated CSS/JS
files checked had gzip and Brotli representations that decompressed byte for
byte to their source.

| App | App CSS bytes | Brotli CSS bytes | Gzip CSS bytes |
| --- | ---: | ---: | ---: |
| Notebooks | 76,253 | 10,055 | 11,769 |
| Mail | 42,081 | 5,928 | 6,843 |
| Spaces | 32,630 | 4,916 | 5,614 |
| Contacts | 18,760 | 3,138 | 3,640 |

These are current build artifacts, not total page transfer sizes. Shared CSS,
fonts, route-specific scripts, and caching also affect page transfer. The
worktree contains concurrent development, so these numbers identify this
verification snapshot rather than a reproducible clean release benchmark.

The metrics bundle is 8,689 bytes raw, 3,089 bytes Brotli, and 3,439 bytes gzip.
An isolated Chromium fixture using this exact bundle emitted LCP, INP, and CLS
through sendBeacon with the expected route template and server phases. All
three reports passed the production API schema. A second load transferred
zero network bytes for the cached script. Fixture timings are intentionally
not presented as Cloud page-speed measurements.

## Scope and remaining measurement

The maintainer requested local commits only. Publication, tags, pushes,
deployment, and a release-dependent Cloud dependency update are outside this
epic. The SSR compression fix is committed in its owning repository; Cloud
continues to consume SSR 0.13.1. No local dependency patch, symlink, or
compatibility layer was introduced to bypass normal dependency delivery.

The local code changes and their focused verification are complete. Dashboard
widget deferral, Contacts permission batching, and Help-body lazy loading stay
measurement-gated. Global search retains immediate keyboard input and no
cross-island Solid Context bridge was introduced.

A representative production cold/warm comparison remains unperformed. The
four production builds and the isolated browser fixture do not quantify Cloud
LCP improvement or separate laptop load from server latency. That measurement
requires an appropriate running build and comparable client conditions; it
does not authorize releasing or deploying anything as part of this epic.

## Peer-review follow-up

The accepted corrections make browser metrics an explicit operator choice.
`observability.web_vitals.enabled` defaults to false. SSR uses its existing
settings snapshot to decide whether to emit the collector; the endpoint also
checks the setting and discards reports while disabled, including reports from
already-open pages. Server-Timing stays available without browser collection.

Core now builds one shared collector. Its asset name derives from the collector
source and the exact web-vitals dependency version, so applications with the
same collector share a cache key without stale immutable URLs. The server
bundle embeds both version inputs and needs no source files at runtime.

The other review suggestions were not applied: a font preload remains subject
to measured cold-visit CLS and font usage rather than adding speculative asset
metadata; the SSR adapter retains 406 when the client excludes every available
representation; Mail retains the disclosure needed for on-demand deleted
mailbox loading. No release, dependency publication, or deployment is included.

Verification of the follow-up: 11 focused tests passed (50 assertions), covering
collection disable/re-enable, payload/auth boundaries, the Core-only asset,
compiled asset URL parity, SSR status handling, and request locale isolation.
The direct Cloud TypeScript check passed. A production Contacts build passed;
the shared Core collector build was verified independently. No live application
restart or release was performed.
