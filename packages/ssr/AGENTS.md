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
- `data-nav-document` on a link to keep its document navigation.

A swap is one transaction, and its order is the contract:

1. Abort the previous swap. Only the newest navigation may commit: a newer
   swap, `popstate`, a native same-tab link, and the history helpers
   (`navigate()`, `documentNavigate()`, `navigateTo()`,
   `refreshCurrentPath()`) abort a pending swap, and so does a `Link` when it
   takes an enhanced click.
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

After every `await`, an aborted or replaced swap returns without a change.
Every other failure calls `documentNavigate()` for the requested URL once;
after a history commit it replaces the entry. The click listener sits on
`window` in the bubble phase, so island and delegated Solid handlers can
prevent a swap first.

Back and Forward are not swapped yet. Install marks the current entry when
its state is null; non-null island state stays untouched. Swap entries carry
their page's marker, and a reload keeps it. A `popstate` onto an entry with
the shown page's marker, or onto a fresh hash-link entry, stays with islands.
An unmarked entry stays with islands only on a page loaded normally that has
not swapped yet; after a swap or a reload it loads the document. An island
that replaces an entry's state with its own drops the marker, so returning
to that entry later loads the document. The history slice gives every entry
its page ID.

A swap does not fire `beforeunload`; an island with unsaved input must prevent
in-scope link clicks itself (for example, a document capture listener calling
`preventDefault()`, which the swap honours) or mark the links with
`data-nav-document`.

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
