# @k2b/ssr

`packages/ssr` is the standalone SolidJS islands SSR framework for Bun,
published to npm as `@k2b/ssr`. Every Cloud application, `@k2b/ui`, and the
documentation site build on it, and third-party applications install it from
npm. The root `AGENTS.md` still applies; this file adds what framework work
needs.

Usage guidance for application authors lives in the `ssr` skill
(`skills/ssr`). Keep it, the package `README.md`, and the code in agreement.
History up to v0.15.0 is in the former
[k2b-dev/ssr](https://github.com/k2b-dev/ssr) repository.

## Boundaries

- The package depends on no Cloud package, route, or domain state; Cloud
  adds its conventions in `@k2b/cloud/ssr`.
- Public exports are `.`, `./bun`, `./elysia`, `./hono`, and `./nav`. A
  change to their behavior is a `feat` or `fix` with the `ssr` scope and
  releases as the `npm-ssr` component; a breaking change needs maintainer
  approval.
- `@k2b/ui` declares `@k2b/ssr` as a peer range. When a release moves
  `@k2b/ssr` outside that range, the `dependencies` check fails; widen the
  range on `main` first. `@k2b/ui` also pins `@k2b/ssr` as a development
  dependency, so every `@k2b/ssr` release cuts a `@k2b/ui` patch release.

## Verify

```bash
bun run test --filter packages/ssr
bun run --cwd packages/ssr typecheck
```

`test/unit` runs on Bun; `test/browser` runs with browser conditions and the
Happy DOM globals from `test/browser/setup.ts`; `test/engine` runs real
browsers through `launchBrowser()` from `packages/ui/test/browser.ts`, so the
gate also runs it in WebKit. A change in the transform,
build, mount runtime, or adapters reaches every application: also run the
`@k2b/ui` tests and build the production bundle of at least one application
(`APP_ID=faq bun run packages/cloud/scripts/build.ts`).

## Key invariants

- `.island.tsx` and `.client.tsx` use default exports. Nested island/client
  imports fail the build: direct, transitive through plain modules, named,
  and literal dynamic `import()` imports all count, and so does a cycle back
  to the island itself. The check reads Bun's metafile, so a computed
  `import()` specifier is not detected. Type-only imports are fine.
- Every island and client instance mounts through `src/mount.ts` in its own
  error boundary; protection never depends on the optional `errorFallback`.
- Props must be `seroval`-serializable: broader than JSON, but no functions,
  callbacks, event handlers, Solid signals or stores, DOM nodes, or arbitrary
  class instances.
- Props are data and are never evaluated: no `eval`, `new Function`, or
  fallback to the old expression format.
- `html()` and `ssr()` keep JSX creation inside synchronous render functions
  so Solid SSR context exists for primitives like `createUniqueId()`.
- The production inline loader adds modulepreload links for rendered islands'
  shared static imports when it runs, after script-blocking stylesheets. Never
  emit modulepreload links in the HTML: the preload scanner then competes
  with first paint.
- `_ssr/` is the filesystem artifact boundary; the public HTTP path is
  derived separately through `config.ssrPath`.
- Island IDs stay stable for the same source path. Production assets share one
  version directory named by a content hash over emitted JavaScript from
  `_ssr/manifest.json`, never entry-only queries or per-file URL hashes:
  relative lazy imports must keep one URL per module. Read the version lazily,
  never at import time.
- The dev overlay depends on `data-file` in dev mode and on the wrapper tags
  staying in the SSR output.
- `@k2b/ssr/nav` stays opt-in. It swaps server-rendered pages into a declared
  content column, without route matching and without client loaders. Any
  failure of a swap ends in one document load, never in a half-swapped page.

## Build pipeline

`buildIslands()` in `src/build.ts`:

1. Scans `**/*.{island,client}.tsx` from explicit `componentRoots`, defaulting
   to `rootDir`; canonical paths deduplicate symlinks and overlapping roots.
   IDs stay relative to `rootDir`, with an absolute fallback for external
   files.
2. Generates stable IDs with `islandIdFromFile()` and fails fast on
   collisions.
3. Runs one `Bun.build()` with virtual island entrypoints and
   `splitting: true`. Each entry imports the component and the shared
   `src/mount.ts` runtime (plus the optional `errorFallback` module) and calls
   `mount(C, selector, Fallback?)`.
4. Checks the successful build's metafile for nested island/client imports
   and throws before any cleanup if it finds them.
5. Removes obsolete generated JavaScript and source maps after a successful
   build.
6. In production only, runs `dedupeSharedChunkExports()`, a workaround for
   duplicate exports in Bun shared chunks.
7. In production only, writes `_ssr/manifest.json` with the JavaScript content
   version and each entry's static import closure after the export dedupe.

Production builds emit no source maps. Development builds use linked maps by
default; `devSourcemap` opts into `"inline"` or `"none"`.

## Transform

`transform()` in `src/transform.ts` runs one Babel pass:

- the SSR-only wrapper plugin collects `.island` and `.client` default
  imports, wraps their JSX usages in `<solid-island>` or `<solid-client>`,
  injects `data-id`, `data-props`, and dev-only `data-file`, keeps SSR
  children for islands, emits empty wrappers for clients, and imports
  `toJSON` from `seroval` as `__seroval_toJSON` and writes
  `JSON.stringify(__seroval_toJSON(props))`;
- `@babel/preset-typescript` strips types and `babel-preset-solid` compiles
  with `generate: "ssr"` or `"dom"` and `hydratable: false`, so islands
  re-render in the browser instead of hydrating.

Test `transform()` directly in both modes when changing it, including the
`__seroval_toJSON` alias and the wrapper attributes.

## Mount runtime

`mount()` in `src/mount.ts` gives each wrapper element its own `render()` root
with a root `ErrorBoundary`; `JSON.parse` and Seroval `fromJSON` parse props
inside the boundary. Missing or malformed `data-props` throws there. One
failing element never stops the loop. The default fallback is plain DOM
(`role="alert"`, `data-ssr-error`, a **Try again** button calling `reset()`).
Each caught error dispatches a bubbling, cancelable `ssr:island-error` event
and calls `reportError()` unless cancelled. A configured `errorFallback`
renders inside a nested boundary whose fallback is the built-in one.

The registry lives on `globalThis[Symbol.for("@k2b/ssr/islands")]`, created on
first use. Components are keyed by their generated selector; each wrapper has
one disposer in a `WeakMap`. Registration overwrites the component without
remounting existing wrappers. Each registration retains its runtime's mount
callback so another runtime copy uses the same Solid instance for rendering
and cleanup ownership.

`mountIslands(root)` and `disposeIslands(root)` are internal named exports for
navigation, with no package export or re-export from `index.ts`. They include
root itself when it is a wrapper and visit wrappers in document order. Mounting
skips unregistered or already-mounted wrappers. Disposal dispatches a bubbling,
non-cancelable `ssr:island-dispose` event with `detail: { id }` on each wrapper
before running its Solid disposer and forgetting it. Call disposal while the
wrappers are still in the document so window listeners receive the event.
A disposer error goes to `reportError()`, still empties its wrapper, and does
not stop later wrappers.

Solid disposal runs component and fallback `onCleanup` and effect cleanups and
empties the wrapper, including while an error fallback is displayed. The outer
catch path stores a DOM-only disposer; a successful **Try again** replaces it
with the new Solid disposer. Disposed wrappers can mount again from `data-props`.

The loader's opening tag always exposes `data-ssr-assets`: the unversioned
`ssrPath` in development, the versioned asset path in production. A non-empty
shared module list also appears as space-separated file names in
`data-ssr-preload`, in loader order. Both attributes are HTML-escaped. The
loader body stays byte-identical for `scripts/perf-baseline/model.ts`; never
emit modulepreload links in HTML.

## Adapters

Shared helpers live in `src/adapter/utils.ts` (`normalizeBasePath`,
`toSsrPath`, `getSsrDir`, `getCacheHeaders`, `createAssetResponse`,
`safePath`, reload ID and SSE helpers). When adding or changing an adapter:

1. Serve files from `getSsrDir(config)` and always pass requested names
   through `safePath()`.
2. Bun and Elysia own absolute paths and must use `config.ssrPath`; Hono's
   `routes(config)` stays relative so the host app mounts it.
3. Dev mode exposes reload and ping endpoints on the same SSR public path.
4. Production serves only the current version from the manifest, resolved per
   request; `manifest.json` is never served. Production JavaScript and maps
   are immutable. Stable development entries use `no-cache`, `ETag`,
   and `Last-Modified`, and conditional requests return `304` without reading
   the file.
5. Keep dev reload SSE visibility-scoped and cross-tab coordinated: Web Locks
   elect one visible owner per origin and SSR path, hidden or page-cached tabs
   release streams and retries, `pageshow` restores participation, and
   reconnect polling stays single-flight with bounded backoff. Forward the
   request abort signal so server heartbeat timers stop.
6. Test both root and `basePath` routing.

## Navigation

`src/nav.ts` is the `./nav` export: `Link`, the history and scroll helpers in
`src/nav-history.ts`, and the page swap in `src/nav-swap.ts`. Keep top-level
code SSR-safe, keep `Link` rendering a real `<a href>`, preserve native
behavior for modifier keys, non-left clicks, downloads, and external targets,
and keep island state reconciliation explicit through `listenPopState()`.

The page swap is opt-in. Without `installPageSwap()` nothing changes. The host
declares the contract in server HTML, and nav knows nothing else about it:

- one `data-nav-shell` element whose value is an opaque signature that nav
  only compares;
- `data-nav-scope` on the shell, a path prefix for links that may swap;
- optional `data-nav-attributes` on the shell, the attributes copied from the
  fetched shell;
- one `data-nav-root` inside the shell, the column that is replaced;
- `data-nav-document` on a link to keep its document navigation. A rejected
  swap response (status, type, scope) has its body cancelled before the
  document load requests the URL again.

A swap is one transaction, and its order is the contract:

1. For eligible clicks and `swapPage()`, ask the column checks (below) before
   aborting the previous swap. A veto stops here. A popstate aborts pending
   work before asking its checks. Only the newest navigation may commit: a newer
   swap, `popstate`, a native same-tab link or form submission, and the
   history helpers (`navigate()`, `documentNavigate()`, `navigateTo()`,
   `refreshCurrentPath()`) abort a pending swap, and so does a `Link` when it
   takes an enhanced click. In turn, a swap that starts later makes the older
   history work do nothing: a `navigate()` commit that a view transition
   deferred, and a pending `Link` handler's `push`, `replaceWith`, and
   `fallback`.
2. Fetch the target as HTML with the abort signal. Check status 200, HTML,
   final URL in scope, shell signature and scope, the loader's
   `data-ssr-assets` prefix, the `<base>` element, and the head stylesheets
   in order with their `media`, because the current head stays.
3. Preload and import the island entries of the fetched column. The old
   column stays as it is until every module loaded. Evaluation cannot be
   cancelled: an entry also mounts wrappers already waiting for it in the
   document, as on the first load.
4. Commit without an `await`: dispose the old islands while they are still
   in the document, then re-check ownership, because their cleanups may
   uninstall the swap or replace the column. A navigation that a cleanup
   starts does not stop the commit; cleanups should not navigate. Push history with an absolute
   URL before inserting the root, so relative URLs in it resolve against the
   new page. Then replace the root, copy title and attributes, mount the new
   islands, restore keyed scroll regions, focus the first heading, and
   announce the title in the one live region.

After every committed swap, nav dispatches `ssr:nav-swapped` on `window` with
`detail: { root }` for the inserted column. It fires once after islands mount,
scroll restores, focus moves, and the title is announced, for pushes, replaces,
Back, and Forward. Failures and document loads emit nothing. Listener errors
do not trigger document navigation.

After every `await`, an aborted or replaced swap returns without a change.
Every other failure calls `documentNavigate()` for the requested URL once;
after a history commit it replaces the entry. The click listener sits on
`window` in the bubble phase, so island and delegated Solid handlers can
prevent a swap first.

History has one owner while the swap is installed. The reserved state key
`"@k2b/ssr/nav"` holds `{ page: string, position: number, scroll?: ScrollSnapshot }`.
Validate it on read; missing, malformed, and old string markers mean another
page. Reload and back_forward document loads keep a valid page id and restore
its saved window and region scroll, then restore it again once the initial
islands mounted (the mount runtime reports each mount, also one that renders
nothing), unless the person scrolled first or history moved on.

Install patches this History object's pushState and replaceState once, with a
Symbol.for flag. The wrappers remain after uninstall but call the originals
unchanged. While installed they preserve caller fields in a shallow copy of
plain-object state, mark null/undefined state, overwrite caller copies of nav's
key, and leave other state unchanged and unmarked so it fails safe on return.
Push saves the departing scroll and increments the position; replace retains
the current marker while a swap still loads (an unmarked entry stays
unmarked), so a pending traversal can commit; otherwise the shown page wrote
it and the entry takes the shown page's id, also over the marker of a
traversal that a newer navigation cancelled. A pending traversal yields to any
push through the wrapper, so it never commits over a newer entry. The history
helpers also cancel a pending reload scroll replay; a raw replace does not,
because islands use it to tidy their URL on mount. History treats an empty URL
argument as the current URL, and so does nav. Nav's own writes use the saved originals. Positions use
Navigation API indices when available, otherwise the tracked entry or the
initial history.length - 1.

One memoized decision per popstate runs before island handlers, through nav's
capture listener or listenPopState's wrapper. Same-page entries reach islands;
nav restores their window scroll first, leaving regions to islands; if the
departing content clamped it, nav retries once in the next frame unless an
island scrolled meanwhile. An island that renders the entry asynchronously can call
`deferScrollRestore()` during its `listenPopState` handler and invoke the returned
completion immediately after its guarded DOM commit. The shared owner keeps the
arriving snapshot while pending, including another traversal or pagehide before
commit, and restores it once. New navigation, user input, or uninstall invalidates
the completion; a same-URL raw replace keeps it. The application still owns data
cancellation. Without an installed swap the completion is inert. Existing handlers
remain unchanged; do not introduce an application history map for this case.
A push through `navigate()` records the departure scroll
the helper captured before the island changed the page. Allowed cross-page
and unmarked entries dispatch `ssr:nav-popstate` on window with the
PopStateEvent as `detail`, so history owners that must see every traversal
(`@k2b/ui` dialog-core, and shell listeners outside the column such as a
panel sheet that closes on Back) still do when nav registered first, then
stopImmediatePropagation and fetch the arriving URL in
the swap transaction without pushing history. Commit and reload recovery must
still own that entry (same URL, Navigation API key, and no newer push or
URL-changing replace), even after a replace that dropped its marker; a different final
URL reloads, and so does a cleanup that moves history after disposal. Restore window
and keyed regions from the entry's in-memory snapshot, then its stored scroll,
otherwise use top/hash scrolling. This runs once, right after the synchronous
mount: there is no signal for content an island loads later, and a retry loop
would fight the person's own scroll, so such an island restores its own
position after loading. Snapshots belong to the shown entry: when no
cross-page traversal is pending, derive it from the current entry if it belongs
to the shown page, even if nav never saw that entry's traversal. During a
pending traversal, keep attributing snapshots to the tracked shown entry.
Keyed regions with `data-scroll-page` restore on Back/Forward and reload recovery,
but push and replace swaps do not carry the departing page's position into them.
Keep scrollRestoration manual for the whole installation and restore the
previous value on uninstall. The setting belongs to each entry, and pushes copy
it, so entries created while installed stay manual after uninstall; uninstall
is a teardown path, not a way to hand a running page back to the browser.
Entries written before install keep the browser's own restoration: on a Back
onto one, Chromium may scroll the still-shown column before the swap commits,
so that page's last snapshot can be off. Install before islands write history.
In a swap host, the loader imports modules used only outside the column
first; a module with any instance in the column waits with the column, because
importing it mounts every instance. So an installer outside the column precedes
column islands that write history; column entry fetches start through
modulepreload while outside imports settle. The installer island must be
used only outside the column.

Install before islands add raw popstate listeners: Chromium uses registration
order even for capture. listenPopState is safe in any order through the shared
swap state. Navigation API navigate captures the departing marker and scroll
before traversal, also when dialog-core hides a dialog-only popstate from nav
and applications. If nav runs first, inherited page ids keep those traversals
with the page; nav must not stop them. Keep the fragment-click fallback for
browsers without the Navigation API. Without it, a popstate that dialog-core
stops (its own Back on close) leaves nav's tracked entry on the dialog entry
until the next push or popstate, so one snapshot can land on the dialog entry;
Chromium and WebKit ship the API. A fragment entry belongs to the page of
the entry it came from: during a pending traversal that is the arriving page,
so nav restarts the traversal for the fragment URL. Persisted pageshow aborts
pending work and swaps a foreign or unmarked arriving entry; for a same-page
return it keeps the tracked entry, so a following popstate departs from the
shown one.

`pagehide` first remembers the shown entry's current scroll and persists it in that entry
best effort. It also mirrors the in-memory snapshots to sessionStorage under
the reserved key `"@k2b/ssr/nav:scroll"`, so a reload keeps departure snapshots
for Back and Forward. Load only valid snapshots on install; the map takes
precedence over an entry's stored scroll. Keep the 50 most recently remembered
entries, refreshing a key's order on each write. Disabled or full storage must
never break navigation.

History tests cover state merging without mutation, non-plain state, marker
validation and replacement, push/replace positions, inert single-install
wrappers, listener ordering, unmarked entries, pageshow/pagehide, manual scroll
restoration, and traversal ownership and recovery. The real-engine history
suite covers Back/Forward across pages and island entries, reload equivalence,
sibling identity, actual dialog-core disposal, raw history writes, listener
suppression, and window/region scroll in both directions. The real-engine veto
suite covers clicks, programmatic swaps, Back/Forward rollback, listener suppression, owner
disposal, shell scoping, throwing checks, first-veto ordering, rapid Back-Back,
veto plus abort, and a veto after a dialog closed with its own Back. Happy DOM covers registration, cleanup, element-less
checks, rollback failure recovery, and veto without fetch; unit tests cover
the SSR-safe public export.

`onBeforeLeave()` in `src/nav-veto.ts` gates eligible clicks and `swapPage()`
before cancellation, fetch, or history writes. It also gates the cross-page or
unmarked branch of `decide`, before claiming the traversal. Same-page island
navigation, document loads, persisted `pageshow`, and fragment claims are not
asked. A second traversal during a pending cross-page traversal was already
allowed by the first checks and claims without asking again. A vetoed click or
`swapPage()` does not abort older work; a vetoed popstate still aborts the
pending swap.

Registration uses Solid's `getOwner()` and ends through `onCleanup` or the
returned disposer. Mount records each wrapper's Solid root owner in a WeakMap
on the shared `@k2b/ssr/islands` registry. Walking the owner chain identifies
the island across runtime copies. The ordered checks share the global
`Symbol.for("@k2b/ssr/nav-veto")` registry. Ask only connected elements within
the current column, plus element-less checks. Shell islands are not asked.
Without an owner or outside an island, a check is global; on the server it is
a no-op. Each check gets its own event with an absolute URL and an optional
signed traversal delta. First veto wins. Throw means allow plus
`globalThis.reportError(error)`, even after prevention; promises and return
values are ignored. Each `allowsLeave` call shares one deferred `restored`
promise across its events and returns its resolver on veto, otherwise
`undefined`. `event.restored` never rejects and stays pending if nobody
vetoes. A click or `swapPage()` veto resolves it immediately; Back/Forward
resolves only when rollback restores the entry. A failed rollback never
resolves it.
Async dialogs veto first, wait for `event.restored`, then open; after
confirmation they clear dirty state and retry a Back with
`history.go(event.delta)`, a Forward or click with `swapPage(event.url.href)`:
a history-backed dialog pushes onto the restored entry and so removes the
forward entries.

A check must not write history itself. During a vetoed Back/Forward, compare
`state.writes` before and after `allowsLeave`: every `pushState` and
`replaceState` through the wrapper counts, including same-URL replaces.
Absorb the popstate, clear rollback, log the error directing authors to
`event.restored`, and reload the document.

For a vetoable traversal, never mix marker positions with Navigation API
indices: Chromium evicts old entries at the 50-entry history cap, shifting
indices while marker positions keep growing. At navigate time, capture the
departing Navigation API key as `departure.from`, before history moves. For a
matched traverse departure, find that key in `navigation.entries()`; use its
current index and `navigation.currentEntry.index` for delta, and its key as
the absolute `traverseTo` target. Otherwise use only validated arriving and
shown marker positions for delta and `history.go(-delta)` for rollback. The
shown entry is departure-derived like the scroll snapshot, so a dialog-only
Back that dialog-core hid from nav does not skew the delta or target.
An unknown or zero delta is not vetoable.

Veto keeps the tracked entry and column, clears departure, stops immediate
propagation, memoizes `"nav"`, and never dispatches `ssr:nav-popstate`.
Popstate and Navigation API listeners registered before nav, such as
`@k2b/ui` dialog-core, still see the vetoed and rollback popstates; a
multi-step vetoed Back past an open history dialog therefore closes that
dialog.
Re-track the shown entry. If the absolute target key is already current,
clear pending rollback and resolve `restored` immediately without traversing:
`traverseTo` would emit no popstate. Otherwise store the key only when using
`traverseTo`. The absolute target survives Chromium running a second Back
that was queued before the rollback. While `state.rollback` is pending,
absorb every popstate before cancellation or restoration: no checks,
listeners, swaps, scroll changes, or abort of newer work. When the pending
record has a key, clear and resolve at the matching Navigation API key;
otherwise use the shown page and position markers, even when the API exists.
While rollback is pending for the shown page, a same-URL replace keeps the
foreign entry's marker (or leaves it unmarked) without changing
`state.currentEntry` or `state.shown`, which already track the shown entry.
A rollback record keeps the page shown at the veto. If a newer swap committed
meanwhile (a replace keeps the rollback target alive), its arrival is an
ordinary traversal away from the newer page: clear the record and decide it
as usual, so URL and column agree. For relative rollback, clear on the first popstate and reload a wrong
arrival; rapid traversals can therefore fall back to a reload. Swallow
`committed` rejection; on `finished` rejection clear rollback and reload,
unless a newer swap committed since the veto and history ended on its entry.
A matching page id alone is not enough: a push by the vetoed page during the
rollback carries that page's id but sits on the arriving entry's position, so
URL and column no longer match. Uninstall clears rollback.

Nav does not run or consult `beforeunload` handlers during a swap: there is
no API to ask them, and a synthetic event shows no dialog. `onBeforeLeave` is
the contract for swaps. Keep `beforeunload` for document loads, such as a
reload, a closed tab, a link outside the scope, or a swap that fails after the
checks allowed it and loads the document. Built-in applications move their
`beforeunload` users to `onBeforeLeave` app by app; until then a swap does not
protect their input.

Cover every change in the unit, Happy DOM, and `test/engine` suites: history
push and replace, Back and Forward, hash links, async fallbacks, reactive
props, scroll snapshots, and for the swap each failure class, rapid clicks,
and island disposal. A change to the swap contract updates this file,
`README.md`, the `ssr` skill, and the Fibel page
`frontend/url-state-and-navigation.md` in the same `feat(ssr)` pull request.

## Bun caveats

- `Bun.plugin()` provides no reliable `onStart`, so `ensureIslands()` keeps
  its `build.onLoad` fallback.
- `import(\`${path}?\`)` registers a file with Bun's watcher;
  `Bun.file().text()` does not.
- Set `NODE_ENV=production` before Bun starts a production build; setting it
  inside the build script is too late for build-time replacement.
