/**
 * Core SSR module - exports createConfig() which provides:
 * - config: SSR configuration for adapters
 * - plugin: Bun plugin for build/dev that transforms islands
 * - html: Renders JSX to Response with the island loader script
 */

import type { BunPlugin } from "bun";
import { dirname, join, resolve } from "path";
import type { JSX } from "solid-js";
import { renderToString } from "solid-js/web";
// @ts-ignore - Bun text import
import devClientCode from "./adapter/client.js" with { type: "text" };
import { getReloadId, normalizeBasePath, readAssetManifest, toSsrPath } from "./adapter/utils";
import { buildIslands, type DevSourcemap } from "./build";
import { ISLAND_ID_LENGTH } from "./island-id";
import { resolveIslandImport } from "./island-resolve";
import { transform } from "./transform";

export type { IslandErrorProps } from "./mount";

// ============================================================================
// Constants
// ============================================================================

/** Glob pattern for island/client component files */
const COMPONENT_PATTERN = "**/*.{island,client}.tsx";

/** Wrapper tags as the SSR transform emits them; data-id is their first attribute. */
const RENDERED_COMPONENT = new RegExp(`<solid-(?:island|client) data-id="([a-f0-9]{${ISLAND_ID_LENGTH}})"`, "g");

// ============================================================================
// Types
// ============================================================================

export type SsrOptions<T extends object = object> = {
  /** Enable dev mode (default: false) */
  dev?: boolean;
  /** Enable verbose logging (default: true in prod, false in dev) */
  verbose?: boolean;
  /** Project root for island discovery and dev _ssr assets (default: process.cwd()) */
  rootDir?: string;
  /** Discovery roots relative to rootDir (absolute paths allowed). Replaces the default rootDir scan. */
  componentRoots?: readonly string[];
  /** Public app mount path for SSR assets and dev endpoints (default: "") */
  basePath?: string;
  /** Modules to exclude from the island bundle (passed to Bun.build) */
  external?: string[];
  /** Development island sourcemaps (default: "linked") */
  devSourcemap?: DevSourcemap;
  /** Path relative to rootDir (or absolute) to a default-exported Solid component receiving IslandErrorProps. */
  errorFallback?: string;
  /** HTML template function (optional, has default) */
  template?: (
    ctx: {
      body: string;
      scripts: string;
    } & T,
  ) => string | Promise<string>;
};

export type SsrConfig = {
  dev: boolean;
  verbose?: boolean;
  rootDir?: string;
  basePath: string;
  ssrPath: string;
};

export type RenderFn = () => JSX.Element;

export type HtmlFn<T extends object> = (render: RenderFn, options?: T) => Promise<Response>;

type PluginFn = () => BunPlugin;

export type SsrResult<T extends object> = {
  config: SsrConfig;
  plugin: PluginFn;
  html: HtmlFn<T>;
};

// ============================================================================
// createConfig() - Create SSR configuration
// ============================================================================

/**
 * Creates SSR configuration, html renderer, and build plugin.
 *
 * Components follow naming conventions:
 * - `*.island.tsx` - SSR rendered, then client re-rendered (interactive)
 * - `*.client.tsx` - Client-only rendered (not SSR)
 *
 * @example
 * ```ts
 * // config.ts
 * import { createConfig } from "@k2b/ssr";
 *
 * type PageOptions = { title?: string };
 *
 * export const { config, plugin, html } = createConfig<PageOptions>({
 *   dev: process.env.NODE_ENV === "development",
 *   template: ({ body, scripts, title }) => `
 *     <!DOCTYPE html>
 *     <html>
 *       <head><title>${title ?? "App"}</title></head>
 *       <body>${body}</body>
 *       ${scripts}
 *     </html>
 *   `,
 * });
 * ```
 */
export const createConfig = <T extends object = object>(options: SsrOptions<T> = {}): SsrResult<T> => {
  const {
    dev = false,
    verbose,
    external,
    devSourcemap = "linked",
    errorFallback,
    template,
    rootDir: rootDirOption,
    componentRoots,
    basePath: basePathOption,
  } = options;
  const rootDir = resolve(rootDirOption ?? process.cwd());
  const basePath = normalizeBasePath(basePathOption);
  const ssrPath = toSsrPath(basePath);

  // Default template if none provided
  const htmlTemplate =
    template ??
    (({ body, scripts }) => `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body>
        ${body}
        ${scripts}
      </body>
    </html>
  `);

  // Config object for routes adapters
  const config: SsrConfig = {
    dev,
    verbose,
    rootDir,
    basePath,
    ssrPath,
  };

  const islandDisplayStyle = "<style>solid-client,solid-island{display:contents}</style>";

  const devConfigScript = `<script>globalThis.__SSR_CONFIG=${JSON.stringify({ ssrPath, reloadId: getReloadId() })}</script>`;

  // HTML renderer
  const html: HtmlFn<T> = async (render, opts = {} as T) => {
    if (render.constructor.name === "AsyncFunction") {
      throw new Error("[ssr] html() expects a synchronous render function: html(() => <Page />)");
    }

    const body = renderToString(render);

    // Production reads the manifest on first render; build scripts create configs before islands exist.
    const manifest = dev ? undefined : readAssetManifest(config);
    const assetPath = manifest ? `${ssrPath}/${manifest.version}` : ssrPath;
    // The loader preloads the rendered entries' shared static imports next to the entry imports, so the chain is one
    // level deep. It runs after script-blocking stylesheets, keeping the preload scanner from competing with first paint.
    const entries = new Set<string>();
    const preloads = new Set<string>();
    if (manifest) {
      for (const [, id = ""] of body.matchAll(RENDERED_COMPONENT)) {
        entries.add(`${id}.js`);
        for (const file of manifest.entries[id] ?? []) preloads.add(file);
      }
    }
    const shared = [...preloads].filter((file) => !entries.has(file));
    const preload = shared.length
      ? `${JSON.stringify(shared)}.forEach(f=>{const l=document.createElement('link');l.rel='modulepreload';l.href=p+'/'+f;document.head.append(l)});`
      : "";
    // Hydration script - dynamically loads island/client bundles based on DOM
    const loaderData = ` data-ssr-assets="${Bun.escapeHTML(assetPath)}"${shared.length ? ` data-ssr-preload="${Bun.escapeHTML(shared.join(" "))}"` : ""}`;
    const hydrationScript = `<script type="module"${loaderData}>const p=${JSON.stringify(assetPath)};${preload}document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script>`;

    // Framework-injected assets
    let scripts = `${islandDisplayStyle}\n${hydrationScript}`;

    // Add dev tools script in dev mode (inlined)
    if (dev) {
      scripts += `\n${devConfigScript}\n<script type="module">${devClientCode}</script>`;
    }

    const content = await htmlTemplate({
      body,
      scripts,
      ...opts,
    });

    return new Response(content, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };

  // Build islands once per run
  let islandsBuild: Promise<void> | undefined;

  // Bun plugin for build/dev
  const plugin: PluginFn = () => {
    return {
      name: "solid-ssr",
      setup(build) {
        // Determine output directory
        const prodOutdir = build.config?.outdir;
        const islandsOutdir = prodOutdir ? join(prodOutdir, "_ssr") : join(rootDir, "_ssr");

        const ensureIslands = async () => {
          islandsBuild ??= buildIslands({
            pattern: COMPONENT_PATTERN,
            outdir: islandsOutdir,
            cwd: rootDir,
            componentRoots,
            verbose: verbose ?? !dev,
            dev,
            devSourcemap,
            external,
            errorFallback: errorFallback ? resolve(rootDir, errorFallback) : undefined,
          }).catch((error) => {
            islandsBuild = undefined;
            throw error;
          });
          await islandsBuild;
        };

        // Build islands on start (works for Bun.build)
        build.onStart?.(ensureIslands);

        // Handle .island and .client imports (without .tsx extension)
        build.onResolve({ filter: /\.(island|client)$/ }, (args) => {
          const resolveDir = args.resolveDir || (args.importer ? dirname(args.importer) : rootDir);
          return {
            path: resolveIslandImport(args.path, resolveDir, args.importer || undefined),
          };
        });

        // Transform TSX/JSX files with Solid SSR
        build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => {
          // Fallback for Bun.plugin (has no onStart)
          await ensureIslands();
          // Import with ? suffix to register file with bun --watch
          // Issue: https://github.com/oven-sh/bun/issues/4689
          const contents = await import(`${path}?`, { with: { type: "text" } });
          return {
            contents: await transform(contents.default, path, "ssr", dev, rootDir),
            loader: "js",
          };
        });
      },
    };
  };

  return { config, plugin, html };
};
