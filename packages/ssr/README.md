# @k2b/ssr

Minimal SSR + islands framework for SolidJS on Bun.

## Overview

This library renders Solid components on the server and renders only interactive islands again on the client.

It uses file conventions:

- `*.island.tsx`: SSR, then client re-rendered
- `*.client.tsx`: client-only (no SSR HTML content)
- `*.tsx`: server-only output

Islands are not hydrated. When an island's code loads, the client clears the
island's server HTML and renders the component again from its props, which the
server writes as Seroval JSON data. Props are never evaluated, so pages work
under a Content Security Policy without `'unsafe-eval'`. Two consequences of
re-rendering follow:

- state that exists only in the server HTML inside an island, such as a typed
  input value, focus, or a scroll position, is replaced on mount;
- server and client must render the same markup from the same props, or the
  page shifts when the island mounts.

## Island lifetime

An island lives until the document unloads or the framework disposes the content
around it. Disposal runs every Solid `onCleanup` and effect cleanup, including
those of an error fallback. Use `onCleanup` to remove global listeners, clear
timers, and release subscriptions.

Just before cleanup, the wrapper dispatches a bubbling `ssr:island-dispose`
event. Code that renders outside the wrapper, such as a portal, can close what
the island opened. Disposal closes every open `@k2b/ui` dialog.

## Size & Philosophy

This framework is intentionally minimal and focused on SSR + islands only.

Current source size (`packages/ssr/src`):

| Component | Lines | Raw | Gzipped |
| --- | ---: | ---: | ---: |
| Core (`index`, `transform`, `build`, island ID + resolver) | ~750 | 26.2 KB | 8.3 KB |
| Dev client (overlay + reload, dev only) | ~421 | 11.9 KB | 3.5 KB |
| Adapters (`bun`, `hono`, `elysia`, shared utils) | ~465 | 14.4 KB | 4.8 KB |

Important: these sizes describe framework source code that runs at build time and on the server.
The browser receives only:

- your island bundles
- Solid runtime from your app dependencies
- Seroval `fromJSON` runtime (props are JSON data)
- a tiny island loader snippet

Framework overhead in the browser is intentionally small.

What is intentionally not included:

- no client-side router
- no state management layer
- no CSS-in-JS abstraction
- no build tool wrapper around Bun

Use the libraries you already prefer. This package only handles SSR and islands.
The optional `@k2b/ssr/nav` subpath provides progressive anchor
enhancement for islands, but it still does not add route matching, loaders, or
SPA routing.

## Features

- Small SSR core with Bun-native build/plugin flow
- Adapters for Bun, Hono, and Elysia
- Type-safe Hono page helper via `createSSRHandler`
- Optional progressive navigation helpers via `@k2b/ssr/nav`
- Monorepo support via `rootDir`
- Public path mounting via `basePath` for microfrontends
- Stable file-path-based island IDs (collision-safe across workspace packages)
- Production content-hashed module directories (`/_ssr/<contentHash>/<id>.js`)
- Linked development source maps and validator-aware asset delivery
- Stale generated island assets removed after successful builds
- Visibility-aware development reload with cross-tab SSE coordination
- Default error boundary per island/client instance with a retry fallback

## Install

```bash
bun add @k2b/ssr solid-js

# choose adapter deps you need
bun add hono
# or
bun add elysia
```

### Package scope migration

`@k2b/ssr` is the maintained successor to `@valentinkolb/ssr`. There are no
framework API changes in the scope migration. Replace the dependency and all
root or subpath imports:

```ts
// Before
import { createConfig } from "@valentinkolb/ssr";
import { routes } from "@valentinkolb/ssr/hono";

// After
import { createConfig } from "@k2b/ssr";
import { routes } from "@k2b/ssr/hono";
```

## Required TypeScript settings

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "moduleResolution": "bundler"
  }
}
```

## Quick Start (Hono)

### 1) Create config

```ts
// config.ts
import { createConfig } from "@k2b/ssr";
import { createSSRHandler, routes } from "@k2b/ssr/hono";

type PageOptions = {
  title?: string;
  description?: string;
};

export const { config, plugin, html } = createConfig<PageOptions>({
  dev: process.env.NODE_ENV === "development",
  // For monorepos with separated packages:
  // rootDir: "/path/to/workspace-root",
  // For microfrontends mounted under /docs:
  // basePath: "/docs",
  template: ({ body, scripts, title, description }) => `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title ?? "App"}</title>
        ${description ? `<meta name="description" content="${description}">` : ""}
      </head>
      <body>${body}${scripts}</body>
    </html>
  `,
});

export const ssr = createSSRHandler(html);
export { routes };
```

### 2) Register plugin in dev

```ts
// scripts/preload.ts
import { plugin } from "../config";

Bun.plugin(plugin());
```

### 3) Create an island

```tsx
// components/Counter.island.tsx
import { createSignal } from "solid-js";

export default function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = createSignal(initial);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count()}</button>;
}
```

### 4) Create a page

```tsx
// pages/Home.tsx
import { ssr } from "../config";
import Counter from "../components/Counter.island";

export default ssr(async (c) => {
  c.get("page").title = "Home";
  return () => <Counter initial={5} />;
});
```

### 5) Wire server

```ts
// server.ts
import { Hono } from "hono";
import { config, routes } from "./config";
import Home from "./pages/Home";

export default new Hono()
  .route("/_ssr", routes(config))
  .get("/", ...Home);
```

### 6) Run

```bash
NODE_ENV=development bun --watch --preload=./scripts/preload.ts src/server.ts
```

## Adapter imports

- Bun: `@k2b/ssr/bun`
- Hono: `@k2b/ssr/hono`
- Elysia: `@k2b/ssr/elysia`

## Optional Navigation Helpers

`@k2b/ssr/nav` provides opt-in history helpers and server-rendered page swaps.
It has no route matching or client loaders.

```tsx
import { createSignal, onCleanup, onMount } from "solid-js";
import { Link, listenPopState, type LinkNavigateEvent } from "@k2b/ssr/nav";

export default function Tabs() {
  const [tab, setTab] = createSignal("alpha");

  onMount(() => {
    onCleanup(
      listenPopState(({ url }) => {
        setTab(url.searchParams.get("tab") ?? "alpha");
      }),
    );
  });

  const openTab = (nav: LinkNavigateEvent) => {
    const next = nav.url.searchParams.get("tab") ?? "alpha";
    setTab(next);
    nav.push(`/demo?tab=${next}`, { scroll: "preserve", state: { tab: next } });
  };

  return (
    <Link href="/demo?tab=beta" scroll="preserve" onNavigate={openTab}>
      Open beta
    </Link>
  );
}
```

`Link` renders a real `<a href>` during SSR. Enhanced clicks only run in the
browser for same-origin, left-click navigation without modifier keys. Without
`onNavigate`, the anchor keeps native document navigation, or a page swap
when the host installed one, and ignores `replace` and `scroll`. With
`onNavigate`, the island owns data loading and state updates, then calls `nav.push()`, `nav.replaceWith()`, or `nav.fallback()`.

Use `listenPopState()` whenever `nav.push()` represents client state. Browser
Back/Forward changes history but cannot infer how an island maps the URL back to
signals or stores. The helper reports the current `URL`, native `PopStateEvent`,
and history state without adding route matching or data loading.

Navigation behavior:

- reactive anchor props remain reactive after `Link` renders
- same-document hash links retain native target scrolling unless `onNavigate`
  explicitly takes ownership
- relative URLs follow `document.baseURI`
- cross-origin `navigate()` calls use full document navigation
- replace navigation preserves existing `history.state` unless `state` is set
- rejected async `onNavigate` callbacks log the error and fall back to a full
  document navigation

Available exports:

- `Link`, `installPageSwap()`, `swapPage()`
- `navigate()`, `navigateTo()`, `documentNavigate()`, `currentPathWithQuery()`, `refreshCurrentPath()`
- `captureScroll()`, `restoreScroll()`, `listenPopState()`, `startViewTransition()`
- `LinkNavigateEvent`, `LinkProps`, `EnhancedNavigateOptions`, `NavigationScrollMode`, `PopStateNavigationEvent`, `ScrollSnapshot`

Use `data-scroll-preserve="stable-key"` on scroll containers that should keep
their scroll position across enhanced navigation.

### Swap server-rendered pages

A host can let links swap only the content column: nav fetches the next page
as server HTML and replaces the column, while the rest of the document (a
navigation rail, an open side panel) stays. Declare the parts in server HTML:

```html
<div data-nav-shell="mail:user-42:en:standard:3f9a" data-nav-scope="/mail" data-nav-attributes="data-mode">
  <nav><a href="/mail/inbox">Inbox</a> <a href="/mail/export.zip" data-nav-document>Export</a></nav>
  <main data-nav-root><h1>Inbox</h1><!-- server HTML and islands --></main>
</div>
```

- `data-nav-shell`: one element, its value an opaque signature. Put
  everything into it that must match for a swap, such as application, user,
  locale, layout kind, and build. Nav only compares it.
- `data-nav-scope`: a path prefix. `/mail` takes `/mail`, `/mail/x`, and
  `/mail?x`, not `/mailbox`.
- `data-nav-attributes`: optional names of shell attributes that the fetched
  page sets or removes.
- `data-nav-root`: one element inside the shell, replaced as a whole.
- `data-nav-document`: keeps document navigation for one link.

Install it once, from an island outside the root:

```tsx
import { onCleanup, onMount } from "solid-js";
import { installPageSwap } from "@k2b/ssr/nav";

onMount(() => onCleanup(installPageSwap()));
```

`installPageSwap()` is idempotent per document and returns its uninstall
function; on the server it does nothing. It listens for clicks on `window`, so
island handlers run first and a prevented click is never swapped. Modifier
keys, other buttons, `target`, `download`, `rel="external"`, other origins,
links outside the scope, and hash links on the same page stay native.
`swapPage(href, { replace })` starts the same swap from code.

A swap fetches the page, then loads its island modules, and only then disposes
the old islands. It pushes history, replaces the column, sets the title and
the declared attributes, mounts the new islands, scrolls to the top or to
the hash, focuses the first heading of the column, and announces the title in
a polite live region. A newer navigation aborts a pending swap: another swap,
Back or Forward, a native link or form submission, an enhanced `Link` click,
or a call to `navigate()` or `documentNavigate()`. A swap that starts while
a `Link` handler still loads wins as well: that handler's `push`,
`replaceWith`, and `fallback` then do nothing.

Any failure loads the requested URL as a normal document: a status other than
200, a response that is not HTML, a redirect out of the scope, a missing shell
or root, a different signature, a different module prefix, `<base>`, or stylesheet set,
and a module that fails to load or to evaluate. The old column stays until
then. Inline scripts in the fetched page do not run, and only the title of
its head is used.

Back and Forward fetch another server page's column without a document load.
Within the shown page, `listenPopState()` lets islands restore state from the
URL without fetching. It never reports a traversal to another server page.
Nav restores window scroll and keyed `data-scroll-preserve` regions from the
arriving entry; within a page, islands still own region scroll. A traversal
that cannot swap reloads the arriving URL.

Install before islands register raw `popstate` listeners. Prefer
`listenPopState()`, which is safe in either order. Keep history state a plain
object or `null`: nav preserves its fields and reserves `"@k2b/ssr/nav"` for
`{ page, position, scroll? }`. Other state values stay unchanged and unmarked;
returning to them fetches the server page or reloads the document.

While installed, nav sets `history.scrollRestoration` to `"manual"` and restores
its previous value on uninstall. The history wrappers stay installed but become
inert. Reloads retain page identity; bfcache returns check the arriving entry.
Dialog-only traversals remain with the dialog history owner.

A swap does not fire `beforeunload`; an island with unsaved input must prevent
in-scope link clicks itself (for example, a document capture listener calling
`preventDefault()`, which the swap honours) or mark the links with
`data-nav-document`.

## Error handling in islands

Every island and client component instance is mounted inside its own error
boundary. No setup is needed. If a component throws while it mounts, while its
props are parsed, or later in a reactive update, only that instance is
replaced with a fallback. Other instances and other islands keep working, also
when they are updated by the same signal write. Malformed `data-props` also
ends in the fallback.

The default fallback is plain, unstyled markup:

```html
<div role="alert" data-ssr-error>
  This part of the page could not be displayed. <button type="button">Try again</button>
</div>
```

**Try again** remounts the component with fresh state from the same
`data-props`. Style the fallback through `[data-ssr-error]`.

Each caught error dispatches a bubbling, cancelable `ssr:island-error` event on
the `<solid-island>` or `<solid-client>` element. Its `detail` contains
`error`, the component `id`, and `reset()`. Unless a listener calls
`preventDefault()`, the error is then passed to `reportError()`, so it appears in
the console and in the window `error` event like an uncaught error. Call
`preventDefault()` only when you report the error yourself; the fallback is
still shown.

```ts
addEventListener("ssr:island-error", (event) => {
  if (!(event instanceof CustomEvent)) return;
  const { error, id } = event.detail;
  myReporter.capture(error, { island: id });
  event.preventDefault();
});
```

To replace the default fallback, for example to localize it, set
`errorFallback` to a module whose default export receives `{ error, reset }`:

```tsx
// src/IslandError.tsx
import type { IslandErrorProps } from "@k2b/ssr";

export default function IslandError(props: IslandErrorProps) {
  return (
    <p role="alert" class="island-error">
      Dieser Bereich konnte nicht angezeigt werden.
      <button type="button" onClick={props.reset}>Erneut versuchen</button>
    </p>
  );
}
```

```ts
createConfig({ errorFallback: "./src/IslandError.tsx" });
```

The option is optional and only changes presentation. If the custom fallback
throws, the default fallback is shown and its error is reported too.

Error boundaries inside your components are closer to the error and still take
precedence. Errors thrown directly in event handlers or in async code outside a
Solid computation stay ordinary uncaught browser errors. Errors in reactive
updates no longer propagate to the code that wrote the signal; that code now
sees the island fallback instead.

## Rendering API

`html()` and Hono `ssr()` handlers expect a synchronous render function:

```tsx
export default ssr(async (c) => {
  const data = await loadData();
  c.get("page").title = data.title;

  return () => <Page data={data} />;
});

app.get("/", () => html(() => <Page />));
```

Do async work in the handler before returning the render function. Do not make the render function itself `async`; Solid SSR expects synchronous JSX evaluation.

### v0.9.0 migration

This is a breaking change in v0.9.0. In v0.8.x and earlier, examples often returned already-created JSX:

```tsx
// v0.8.x and earlier
export default ssr(async () => <Page />);

app.get("/", () => html(<Page />));
```

In v0.9.0, wrap JSX creation in a render function:

```tsx
// v0.9.0+
export default ssr(async () => () => <Page />);

app.get("/", () => html(() => <Page />));
```

This ensures Solid primitives such as `createUniqueId()` run inside `renderToString()`, where the SSR context exists.

## `createConfig` options

```ts
createConfig({
  dev?: boolean;         // default: false
  verbose?: boolean;     // default: !dev
  rootDir?: string;      // default: process.cwd()
  componentRoots?: readonly string[]; // explicit island/client discovery directories
  basePath?: string;     // default: "", example: "/docs"
  external?: string[];   // passed to Bun.build for island bundle
  devSourcemap?: "none" | "linked" | "inline"; // default: "linked"
  errorFallback?: string; // optional island error fallback module, relative to rootDir
  template?: ({ body, scripts, ...custom }) => string | Promise<string>;
})
```

### Notes

- `rootDir` is important in monorepos where server entrypoint and island files live in different packages.
- `componentRoots` replaces the discovery scan with explicit directories. Relative paths resolve against `rootDir`; absolute paths support installed framework packages. Omit it to scan `rootDir`, or pass `[]` to scan nothing. Missing directories fail the build. Symlinks and overlapping roots are deduplicated by canonical path; nested `node_modules` and `.git` directories are skipped. Select an installed package directory explicitly to scan its components.
- Solid core, web, and store imports use the app's dependency and the selected build mode consistently, including components imported from installed packages.
- `rootDir` still controls component IDs and the development asset directory. All selected components share one browser build. Ordinary component libraries with browser/SSR exports (such as `@k2b/ui`) are resolved through imports and do not need discovery roots. Do not scan their examples or test fixtures.

```ts
createConfig({
  rootDir: workspaceRoot,
  componentRoots: ["packages/my-app/src", frameworkSourceDir],
});
```

Use the same configuration in development and production. Files outside `rootDir` retain the existing canonical absolute-path ID fallback; moving an external package can change its IDs. SSR wrappers and browser assets must come from the same build.
- `errorFallback` replaces the presentation of the default island error boundary. Islands are protected without it; see [Error handling in islands](#error-handling-in-islands).
- `basePath` moves SSR assets and dev endpoints under that prefix, e.g. `/docs/_ssr`.
- Development builds emit linked source maps by default. Use `"inline"` only when a tool requires embedded maps, or `"none"` to disable them.
- In production, all modules share a content-hashed directory (`/_ssr/<contentHash>/<id>.js`), stable across restarts and identical builds from the same build path (lazy chunk names depend on it). Relative lazy imports inherit that directory, so each module has one URL. Files stay flat on disk; adapters serve only the current version. Deploy the whole `_ssr` directory, including `_ssr/manifest.json`, next to the server bundle.
- The production inline loader preloads rendered islands' shared static imports after the page's stylesheets; dynamic imports stay lazy. It creates modulepreload links at runtime so the HTML preload scanner does not compete with first paint.
- All adapters stream island assets from `Bun.file`. Production assets under the versioned path and content-hashed development chunks are immutable; stable development entries and source maps use validators for inexpensive freshness checks.
- Production adapters serve adjacent `.br` or `.gz` files when accepted by the request, preserving the original MIME type and varying caches by `Accept-Encoding`. Generate these siblings in the application build; the adapter does not compress responses at runtime. Development always serves the original file to avoid stale compressed copies.

## Microfrontend mount example

Use `basePath` when the SSR app is mounted under a sub-path:

```ts
// config.ts
export const { config, html } = createConfig({
  basePath: "/docs",
});

// docs-app.ts
const docsApp = new Hono()
  .route("/_ssr", routes(config))
  .get("/", () => html(() => <DocsHome />));

// host-app.ts
export default new Hono().route("/docs", docsApp);
```

With this setup, island chunks and dev endpoints are served from `/docs/_ssr/...`.

## Build for production

Set the environment before starting Bun so both the build configuration and bundled code use production mode:

```bash
NODE_ENV=production bun scripts/build.ts
```

```ts
// scripts/build.ts
import { plugin } from "./config";

await Bun.build({
  entrypoints: ["src/server.tsx"],
  outdir: "dist",
  target: "bun",
  plugins: [plugin()],
});
```

## Hono `createSSRHandler` behavior

`createSSRHandler(html)` returns an `ssr()` helper that:

- initializes `c.get("page")` as typed page options
- accepts middlewares/validators before final handler
- lets handlers return either a synchronous render function or `Response`

## Dev mode tools

With `dev: true`, a small `[ssr]` overlay is injected.

It can:

- auto-reload on server restart
- highlight island/client boundaries
- show source filenames for wrapped components

In browsers with Web Locks support, auto-reload elects one visible tab per
origin and SSR path to hold the SSE connection. Hidden tabs suspend reload work,
leadership transfers automatically, and cached pages resume safely after a
back-forward cache restore. Browsers without Web Locks retain visibility-scoped
per-tab connections as a compatibility fallback.

## Limitations

- islands must use default export
- props must be serializable via `seroval`; do not pass functions, callbacks, event handlers, Solid signals/stores, DOM nodes, or class instances as island/client props
- island/client modules must not import other island/client modules, directly, through plain modules, as named imports, or with a literal dynamic `import()`; an island must also not import itself back through plain modules. The build fails in dev and production. A computed `import()` path is not detected. Type-only imports are fine.
- move shared components into plain `.tsx` modules and import them from both files; keep each island/client entry as a thin re-export, such as `export { default } from "./Inner";`

## Development

`@k2b/ssr` is developed in [`packages/ssr`](https://github.com/k2b-dev/cloud/tree/main/packages/ssr)
of the Cloud repository, which also releases it to npm. Report issues there.
Releases up to v0.15.0, their history, and the example app live in the
former [k2b-dev/ssr](https://github.com/k2b-dev/ssr) repository.

From the Cloud repository root:

```bash
bun install --frozen-lockfile
bun run test --filter packages/ssr
bun run --cwd packages/ssr typecheck
```

An agent skill for building with `@k2b/ssr` lives in `skills/ssr`:

```bash
bunx skills add k2b-dev/cloud --skill ssr
```
