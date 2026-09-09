/**
 * Preload script for dev mode.
 * Registers the SSR plugin (Solid.js JSX transform + island bundling)
 * and builds CSS before any app code is imported.
 *
 * Mirrors the two consumer shapes of scripts/build.ts:
 *
 *   Monorepo (this repo):
 *     APP_ID=<id> bun run --preload=packages/cloud/scripts/preload.ts ...
 *     # appDir defaults to packages/<APP_ID>, run from workspace root.
 *
 *   Standalone (npm consumer, see cloud-template):
 *     APP_ID=<id> APP_DIR=. bun run --preload=node_modules/@k2b/cloud/scripts/preload.ts ...
 *     # appDir = APP_DIR (resolved against cwd), i.e. the directory holding src/.
 *
 * Uses bun-plugin-tailwind with root=cwd for stable path resolution. Each app
 * stylesheet owns an explicit, app-local @source contract so the development
 * build cannot leak classes from sibling apps.
 */
import { existsSync, watch } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import { writeAppFavicon } from "./app-favicon";

const appId = process.env.APP_ID ?? "core";

// `root` = wherever the process was started. In the monorepo this is the
// workspace root, which is what the paths below used to be resolved against.
const root = process.cwd();

// Framework dir — works whether this script sits in packages/cloud/scripts/
// (monorepo) or node_modules/@k2b/cloud/scripts/ (npm install).
const frameworkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// App dir — APP_DIR override for standalone consumers, defaults to monorepo
// convention. Resolved against cwd if relative.
const appDir = process.env.APP_DIR ? resolve(root, process.env.APP_DIR) : resolve(root, "packages", appId);
if (!existsSync(appDir)) throw new Error(`Unknown app dir: ${appDir} (set APP_DIR or check APP_ID)`);

const { app, plugin } = await import(resolve(appDir, "src/config"));
Bun.plugin(plugin());

// ── Build CSS ───────────────────────────────────────────────────────────────
const publicDir = resolve(root, "public");
await mkdir(publicDir, { recursive: true });

const globalCssEntry = resolve(root, "styles.css");

const buildGlobalCss = async () => {
  // Use the same global entrypoint as the production extras build.
  await Bun.build({
    entrypoints: [globalCssEntry],
    outdir: publicDir,
    naming: "global.css",
    plugins: [tailwind],
  });
};

const appCssPath = resolve(appDir, "src/styles/app.css");

const buildAppCss = async () => {
  // `naming: "app.css"` is essential — without it, Bun.build with `root` set
  // preserves the directory structure (packages/<id>/src/styles/app.css) inside
  // outdir, so Layout's `<link href="/public/<id>/app.css">` 404s and only
  // global.css's classes reach the browser. That's why responsive grid
  // utilities went missing on dashboard.
  await Bun.build({
    entrypoints: [appCssPath],
    outdir: resolve(publicDir, appId),
    naming: "app.css",
    root,
    plugins: [tailwind],
  });
};

const watchDevCss = (label: string, paths: string[], build: () => Promise<void>) => {
  if (process.env.NODE_ENV !== "development") return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;

  const rebuild = () => {
    if (running) {
      queued = true;
      return;
    }

    running = true;
    void build()
      .then(() => console.log(`[preload] rebuilt ${label}`))
      .catch((error) => console.error(`[preload] failed to rebuild ${label}`, error))
      .finally(() => {
        running = false;
        if (queued) {
          queued = false;
          rebuild();
        }
      });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 75);
  };

  for (const path of paths) {
    if (!existsSync(path)) continue;
    watch(path, { persistent: true }, schedule);
  }
};

// global.css + branding are only served by core (Traefik routes them there).
// A standalone app consumes both from the prebuilt core container, so the
// workspace entrypoint is absent there and this block simply does not run.
if (appId === "core" && existsSync(globalCssEntry)) {
  await buildGlobalCss();

  // Default branding asset: copy the tracked logo.svg into the runtime
  // public dir so serveBranding can fall back to it when no admin-uploaded
  // logo (data URI) is configured. User uploads are stored as base64 data
  // URIs in settings — no image processing (sharp etc.) needed.
  await cp(resolve(frameworkDir, "public/logo.svg"), resolve(publicDir, "logo.svg"));
}

// katex.css is only needed by notebooks (served by core via Traefik /public/katex.css)
if (appId === "notebooks") {
  try {
    await cp(resolve(root, "node_modules/katex/dist/katex.min.css"), resolve(publicDir, "katex.css"));
  } catch {
    console.warn("[preload] katex.css not found, skipping");
  }
}

// Each app builds its own app.css
const appPublicDir = resolve(publicDir, appId);
await mkdir(appPublicDir, { recursive: true });

if (appId !== "core" && app) {
  await writeAppFavicon({
    publicDir,
    appId,
    icon: app.meta.icon,
  });
}

await buildAppCss();

watchDevCss("app.css", [resolve(appCssPath, "..")], buildAppCss);
if (appId === "core" && existsSync(globalCssEntry)) {
  watchDevCss("global.css", [globalCssEntry, resolve(frameworkDir, "src/styles")], buildGlobalCss);
}

// Optional app-owned dev assets. Production builds already have
// scripts/build-extras.ts; this mirrors that hook for watch mode without
// forcing app-specific asset logic into the framework preload.
const devExtras = resolve(appDir, "scripts/dev-extras.ts");
if (existsSync(devExtras)) {
  process.env.WORKSPACE_ROOT = root;
  process.env.PUBLIC_DIR = publicDir;
  await import(devExtras);
}
