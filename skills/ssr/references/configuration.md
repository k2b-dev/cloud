# Configuration and Adapters

## `createConfig()` Options

```ts
createConfig({
  dev?: boolean;
  verbose?: boolean;
  rootDir?: string;
  componentRoots?: readonly string[];
  basePath?: string;
  external?: string[];
  devSourcemap?: "none" | "linked" | "inline";
  errorFallback?: string;
  template?: ({ body, scripts, ...custom }) => string | Promise<string>;
})
```

Notes:

- keep `rootDir` as the stable ID and asset base; use `componentRoots` to select app and shared framework source directories without scanning sibling apps
- explicit `componentRoots` replace the default scan; relative paths resolve against `rootDir`, absolute package paths are supported, `[]` selects nothing, and missing paths fail
- ordinary UI libraries with browser/SSR exports are bundled through imports and need no discovery root; explicitly select only packages that ship island/client source files
- `basePath` moves SSR asset URLs and dev endpoints under that public prefix
- `errorFallback` optionally points to a fallback module relative to `rootDir`; islands are protected without it
- development builds use linked source maps by default; use `devSourcemap: "inline"` only for tools that require embedded maps
- stable development entries and source maps revalidate; content-hashed chunks and all production assets use immutable caching
- production module URLs use a build timestamp directory under `config.ssrPath`; relative imports retain the same version, and adapters reject other versions
- `html()` accepts a synchronous render function: `html(() => <Page />)`
- `html()` always injects framework assets, including the SSR loader and wrapper styling

## Hono and `basePath`

For ordinary apps at the site root:

```ts
new Hono().route("/_ssr", routes(config));
```

For a feature app mounted under `/docs`:

```ts
const { config } = createConfig({ basePath: "/docs" });

const docsApp = new Hono()
  .route("/_ssr", routes(config))
  .get("/", ...Home);

export default new Hono().route("/docs", docsApp);
```

The important invariant is that `config.basePath` must match the host mount path of the feature app.

## Other Adapters

- Hono: `@k2b/ssr/hono`
- Bun: `@k2b/ssr/bun`
- Elysia: `@k2b/ssr/elysia`

For Bun and Elysia, the adapter uses `config.ssrPath` internally, so `basePath` does not require extra manual route wiring.

## Development Reload

With `dev: true`, the framework injects its development overlay and watches the
adapter's `_reload` endpoint for server restarts. No additional setup is needed
beyond mounting the adapter routes.

- hidden tabs and page-cached documents close their reload stream and retry work
- browsers with Web Locks keep one visible SSE owner per origin and SSR path
- leadership transfers when the owner becomes hidden or leaves the page
- `pageshow` restores participation after a back-forward cache restore
- browsers without Web Locks use visibility-scoped per-tab streams as a compatibility fallback
- disabling **Auto reload** in the overlay closes the stream for that tab
