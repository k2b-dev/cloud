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
  range on `main` first.

## Verify

```bash
bun run test --filter packages/ssr
bun run --cwd packages/ssr typecheck
```

`test/unit` runs on Bun; `test/browser` runs with browser conditions and the
Happy DOM globals from `test/browser/setup.ts`. A change in the transform,
build, mount runtime, or adapters reaches every application: also run the
`@k2b/ui` tests and build the production bundle of at least one application
(`APP_ID=faq bun run packages/cloud/scripts/build.ts`).

## Key invariants

- `.island.tsx` and `.client.tsx` use default exports; nested island or
  client imports are invalid usage.
- Every island and client instance mounts through `src/mount.ts` in its own
  error boundary; protection never depends on the optional `errorFallback`.
- Props must be `seroval`-serializable: broader than JSON, but no functions,
  callbacks, event handlers, Solid signals or stores, DOM nodes, or arbitrary
  class instances.
- `html()` and `ssr()` keep JSX creation inside synchronous render functions
  so Solid SSR context exists for primitives like `createUniqueId()`.
- `_ssr/` is the filesystem artifact boundary; the public HTTP path is
  derived separately through `config.ssrPath`.
- Island IDs stay stable for the same source path. Production cache busting
  uses one build timestamp directory shared by all modules, never entry-only
  queries or content hashes.
- The dev overlay depends on `data-file` in dev mode and on the wrapper tags
  staying in the SSR output.
- `@k2b/ssr/nav` stays an opt-in progressive navigation helper, not a router
  with route matching, loaders, or server re-rendering.

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
4. Removes obsolete generated JavaScript and source maps after a successful
   build.
5. In production only, runs `dedupeSharedChunkExports()`, a workaround for
   duplicate exports in Bun shared chunks.

Production builds emit no source maps. Development builds use linked maps by
default; `devSourcemap` opts into `"inline"` or `"none"`.

## Transform

`transform()` in `src/transform.ts` runs one Babel pass:

- the SSR-only wrapper plugin collects `.island` and `.client` default
  imports, wraps their JSX usages in `<solid-island>` or `<solid-client>`,
  injects `data-id`, `data-props`, and dev-only `data-file`, keeps SSR
  children for islands, emits empty wrappers for clients, and imports
  `serialize` from `seroval`;
- `@babel/preset-typescript` strips types and `babel-preset-solid` compiles
  with `generate: "ssr"` or `"dom"` and `hydratable: false`, so islands
  re-render in the browser instead of hydrating.

Test `transform()` directly in both modes when changing it, including the
`__seroval_serialize` alias and the wrapper attributes.

## Mount runtime

`mount()` in `src/mount.ts` gives each wrapper element its own `render()` root
with a root `ErrorBoundary`; props are deserialized inside the boundary. One
failing element never stops the loop. The default fallback is plain DOM
(`role="alert"`, `data-ssr-error`, a **Try again** button calling `reset()`).
Each caught error dispatches a bubbling, cancelable `ssr:island-error` event
and calls `reportError()` unless cancelled. A configured `errorFallback`
renders inside a nested boundary whose fallback is the built-in one.

## Adapters

Shared helpers live in `src/adapter/utils.ts` (`normalizeBasePath`,
`toSsrPath`, `getSsrDir`, `getCacheHeaders`, `createAssetResponse`,
`safePath`, reload ID and SSE helpers). When adding or changing an adapter:

1. Serve files from `getSsrDir(config)` and always pass requested names
   through `safePath()`.
2. Bun and Elysia own absolute paths and must use `config.ssrPath`; Hono's
   `routes(config)` stays relative so the host app mounts it.
3. Dev mode exposes reload and ping endpoints on the same SSR public path.
4. Production serves only the current build version; production JavaScript
   and maps are immutable. Stable development entries use `no-cache`, `ETag`,
   and `Last-Modified`, and conditional requests return `304` without reading
   the file.
5. Keep dev reload SSE visibility-scoped and cross-tab coordinated: Web Locks
   elect one visible owner per origin and SSR path, hidden or page-cached tabs
   release streams and retries, `pageshow` restores participation, and
   reconnect polling stays single-flight with bounded backoff. Forward the
   request abort signal so server heartbeat timers stop.
6. Test both root and `basePath` routing.

## Navigation

When changing `src/nav.ts`, keep top-level code SSR-safe, keep `Link`
rendering a real `<a href>`, preserve native behavior for modifier keys,
non-left clicks, downloads, and external targets, and keep state
reconciliation explicit through `listenPopState()`. Cover history push and
replace, Back and Forward, hash links, async fallbacks, reactive props, and
scroll snapshots in both test suites.

## Bun caveats

- `Bun.plugin()` provides no reliable `onStart`, so `ensureIslands()` keeps
  its `build.onLoad` fallback.
- `import(\`${path}?\`)` registers a file with Bun's watcher;
  `Bun.file().text()` does not.
- Set `NODE_ENV=production` before Bun starts a production build; setting it
  inside the build script is too late for build-time replacement.
