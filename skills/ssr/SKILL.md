---
name: ssr
description: Build apps with @k2b/ssr, the minimal SolidJS islands SSR framework for Bun. Use when creating pages, islands, client components, templates, opt-in @k2b/ssr/nav progressive navigation, or adapter setup with Hono, Bun, or Elysia, and when troubleshooting SSR asset loading, source maps, caching, dev reload connections, serialization, client re-render behavior, island error fallbacks, or enhanced same-origin links.
---

# @k2b/ssr User Guide

Use this skill when building with `@k2b/ssr`.

`@k2b/ssr` replaces the deprecated `@valentinkolb/ssr` package. The API and
subpaths are unchanged; migrate dependencies and imports by replacing the
scope.

The source lives in `packages/ssr` of the
[Cloud repository](https://github.com/k2b-dev/cloud); report issues there.
Cloud applications combine it with `@k2b/cloud/ssr`; follow the `cloud-dev`
skill for them.

## Read These When Needed

- `createConfig()` options, Hono `basePath`, the Bun and Elysia adapters, and development reload: [Configuration and adapters](references/configuration.md)
- Island error boundaries, `errorFallback`, and the `ssr:island-error` event: [Island errors](references/island-errors.md)
- Progressive same-origin links with `@k2b/ssr/nav`: [Navigation](references/navigation.md)

## Quick Start

### Config

```ts
import { createConfig } from "@k2b/ssr";
import { createSSRHandler, routes } from "@k2b/ssr/hono";

type PageOptions = {
  title?: string;
  description?: string;
};

export const { config, plugin, html } = createConfig<PageOptions>({
  dev: process.env.NODE_ENV === "development",
  rootDir: import.meta.dir,
  template: ({ body, scripts, title, description }) => `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title ?? "App"}</title>
      ${description ? `<meta name="description" content="${description}">` : ""}
    </head>
    <body>${body}${scripts}</body>
  </html>`,
});

export const ssr = createSSRHandler(html);
export { routes };
```

### Hono server

```ts
import { Hono } from "hono";
import { config, routes } from "../config";
import Home from "./components/Home";

export default new Hono()
  .route("/_ssr", routes(config))
  .get("/", ...Home);
```

### Dev preload

```ts
import { plugin } from "../config";

Bun.plugin(plugin());
```

### Production build

```ts
import { plugin } from "../config";

await Bun.build({
  entrypoints: ["src/server.tsx"],
  outdir: "dist",
  target: "bun",
  plugins: [plugin()],
});
```

## Component Conventions

| Extension | Behavior |
|---|---|
| `*.island.tsx` | server-rendered, then client re-rendered |
| `*.client.tsx` | client-only wrapper, no SSR HTML body |
| `*.tsx` | server-only |

Rules:

- use `export default` for islands and client components
- props must be `seroval`-serializable
- do not nest island/client imports inside other island/client components

`seroval` supports more than JSON, including values like `Date`, `RegExp`, `Map`, and `Set`, but still excludes functions, DOM nodes, and arbitrary class instances.

## Island Prop Boundary

Island and client component props cross a server-to-browser serialization boundary.

Do not pass functions, callbacks, event handlers, Solid signals/stores, DOM nodes, or class instances as props to `*.island.tsx` or `*.client.tsx` components. Props are serialized with `seroval`, so these values will fail at render time.

Bad:

```tsx
<Counter onChange={(value) => save(value)} />
```

Good:

```tsx
<Counter initial={count} />
```

Put interactive behavior inside the island/client component. For server effects, pass serializable data such as IDs, URLs, action names, or initial state, then call an API route, submit a form, or update client state from inside the island.

## Island Error Boundaries

Every island and client component instance is mounted in its own error
boundary by default. Do not add a root `ErrorBoundary` to each island just for
protection. Read [Island errors](references/island-errors.md) before changing
fallbacks or error reporting.

## Pages

`ssr()` page handlers return a synchronous render function, not already-created JSX:

```tsx
export default ssr(async (c) => {
  c.get("page").title = "Home";
  const data = await loadData();

  return () => <Home data={data} />;
});
```

Use the handler body for async work, redirects, and page metadata. Keep JSX creation inside the returned render function so Solid SSR primitives such as `createUniqueId()` run inside `renderToString()`.

### v0.9.0 Breaking Change

For migrations, check for the old direct-JSX style from v0.8.x and earlier:

```tsx
// before v0.9.0
export default ssr(async () => <Page />);
app.get("/", () => html(<Page />));
```

Convert it to render functions:

```tsx
// v0.9.0+
export default ssr(async () => () => <Page />);
app.get("/", () => html(() => <Page />));
```

Do async data loading before the returned render function:

```tsx
export default ssr(async (c) => {
  const data = await loadData();
  return () => <Page data={data} />;
});
```

Do not return an async render function. The render function is called by `renderToString()` and must synchronously create JSX.

## TypeScript Settings

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

## Common Pitfalls

- missing `rootDir` in a monorepo leads to missing island discovery
- missing SSR route mounting leads to 404s for island chunks
- placing `${scripts}` outside the rendered HTML body can break client loading
- returning direct JSX from `ssr()` is invalid; return `() => <Page />`
- passing callbacks or event handlers as island/client props fails because props must be serialized
- treating `@k2b/ssr/nav` as a full router leads to stale server data; it only enhances anchors after client state is handled
- using `nav.push()` without reconciling `popstate` leaves island state stale after Back/Forward; use `listenPopState()`
- importing server-only modules into islands or client components can break browser bundling
- named exports for islands/clients are not supported
- calling `reset()` inside an `ssr:island-error` listener retries immediately, so a component that keeps failing loops; keep `reset` for a user action or a bounded, delayed retry
