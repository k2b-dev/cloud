/**
 * Production build for a single cloud app.
 *
 * Two consumer shapes:
 *
 *   Monorepo (this repo):
 *     NODE_ENV=production APP_ID=<id> bun run packages/cloud/scripts/build.ts
 *     # appDir defaults to packages/<APP_ID>, run from workspace root.
 *
 *   Standalone (npm consumer, see cloud-template):
 *     NODE_ENV=production APP_ID=<id> APP_DIR=. bun run node_modules/@k2b/cloud/scripts/build.ts
 *     # appDir = APP_DIR (resolved against cwd) and must be the directory
 *     # that CONTAINS src/, since entrypoints resolve to <appDir>/src/*.
 *
 * Output goes to <cwd>/dist:
 *   server.js            bundled Bun entry
 *   _ssr/<island>.js     hydration bundles (auto-emitted by the SSR plugin)
 *   public/<id>/app.css  Tailwind, if the app has src/styles/app.css
 *   public/<id>/...      anything from <appDir>/public/
 *
 * If the app needs additional artefacts (core's global.css, logo, katex),
 * it ships a `scripts/build-extras.ts` that this script runs at the end.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { Glob } from "bun";
import tailwind from "bun-plugin-tailwind";
import { writeAppFavicon } from "./app-favicon";
import { buildBrowserPerformance } from "./browser-performance";

const appId = process.env.APP_ID;
if (!appId) throw new Error("APP_ID env var required");

// Build output is relative to the consuming project, including npm consumers.
const root = process.cwd();

// Framework dir — works whether this script is in packages/cloud/scripts/
// (monorepo) or node_modules/@k2b/cloud/scripts/ (npm install).
const frameworkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const release = process.env.CLOUD_RELEASE?.trim() || "local";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release)) {
  throw new Error(`Invalid CLOUD_RELEASE: ${JSON.stringify(release)}`);
}
const syncPackagePath = Bun.resolveSync("@k2b/sync/package.json", frameworkDir);
const syncPackage = JSON.parse(await readFile(syncPackagePath, "utf8")) as {
  version?: unknown;
};
if (typeof syncPackage.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(syncPackage.version)) {
  throw new Error("Could not resolve the installed @k2b/sync version");
}
const syncVersion = syncPackage.version;

// App dir — APP_DIR override for standalone consumers, defaults to monorepo
// convention. Resolved against cwd if relative.
const appDir = process.env.APP_DIR ? resolve(root, process.env.APP_DIR) : resolve(root, "packages", appId);
if (!existsSync(appDir)) throw new Error(`Unknown app dir: ${appDir} (set APP_DIR or check APP_ID)`);
// Share the resolved source directory with defineApp before importing config.
process.env.APP_DIR = appDir;

const dist = resolve(root, "dist");
const distPublic = resolve(dist, "public");
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

await rm(dist, { recursive: true, force: true });
await mkdir(distPublic, { recursive: true });

const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".xml"]);

async function precompressDistAssets(dir: string): Promise<void> {
  if (!existsSync(dir)) return;

  for await (const file of new Glob("**/*").scan({ cwd: dir, absolute: true, onlyFiles: true })) {
    if (file.endsWith(".br") || file.endsWith(".gz")) continue;
    if (!compressibleExtensions.has(extname(file))) continue;

    const source = await readFile(file);
    const [br, gz] = await Promise.all([
      compressBrotli(source, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        },
      }),
      compressGzip(source, { level: zlibConstants.Z_BEST_COMPRESSION }),
    ]);

    await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
  }
}

// Register the app's SSR plugin (Solid JSX transform + island bundler).
// In the monorepo this resolves via `packages/<id>/src/config`; in standalone
// it resolves via the appDir path (because the script's relative imports
// only work for monorepo, we use absolute file:// for standalone).
const configPath = resolve(appDir, "src/config");
const { app, plugin } = await import(configPath);

// 1. Server entry — also emits dist/_ssr/<island>.js via the SSR plugin.
// @peculiar/x509 uses tsyringe, whose decorators require this polyfill before
// any app dependency is evaluated. A wrapper keeps that ordering identical for
// every production app without requiring app-owned bootstrap imports.
const serverEntry = resolve(dist, ".server-entry.ts");
const reflectMetadata = Bun.resolveSync("reflect-metadata", frameworkDir);
await writeFile(
  serverEntry,
  `import ${JSON.stringify(reflectMetadata)};\nexport { default } from ${JSON.stringify(resolve(appDir, "src/index.ts"))};\n`,
);
let server: Awaited<ReturnType<typeof Bun.build>>;
try {
  server = await Bun.build({
    entrypoints: [serverEntry],
    outdir: dist,
    naming: "server.js",
    target: "bun",
    minify: true,
    define: {
      __CLOUD_RELEASE__: JSON.stringify(release),
      __CLOUD_SYNC_VERSION__: JSON.stringify(syncVersion),
    },
    plugins: [(app?.plugin ?? plugin)()],
  });
} finally {
  await rm(serverEntry, { force: true });
}
if (!server.success) {
  for (const m of server.logs) console.error(m);
  throw new Error("Server bundle failed");
}

// 2. Per-app Tailwind stylesheet.
const appCss = resolve(appDir, "src/styles/app.css");
if (existsSync(appCss)) {
  const out = resolve(distPublic, appId);
  await mkdir(out, { recursive: true });
  const css = await Bun.build({
    entrypoints: [appCss],
    outdir: out,
    naming: "app.css",
    root,
    plugins: [tailwind],
  });
  if (!css.success) {
    for (const m of css.logs) console.error(m);
    throw new Error("App CSS build failed");
  }
}

// 3. Per-app static assets.
const appPublic = resolve(appDir, "public");
if (existsSync(appPublic)) {
  await cp(appPublic, resolve(distPublic, appId), { recursive: true });
}

if (appId !== "core" && app) {
  await writeAppFavicon({
    publicDir: distPublic,
    appId,
    icon: app.meta.icon,
  });
}

// 4. Optional app-specific extras (e.g. core's global.css + logo + katex).
const extras = resolve(appDir, "scripts/build-extras.ts");
if (existsSync(extras)) {
  process.env.WORKSPACE_ROOT = root;
  process.env.DIST_DIR = dist;
  await import(extras);
}

await buildBrowserPerformance(distPublic, appId);
await precompressDistAssets(resolve(dist, "public"));
await precompressDistAssets(resolve(dist, "_ssr"));

console.log(`Built ${appId} → ${dist}`);
