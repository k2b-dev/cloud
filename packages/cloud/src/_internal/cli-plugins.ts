/**
 * `cld` plugins served by the application that owns them.
 *
 * `defineApp({ cli })` names each CLI module and the paths of its source and
 * skill references. The production build bundles every module into one
 * self-contained ESM file and writes it with its references and manifest to
 * `dist/cli/<name>/`. At run time the application serves those files under
 * `/cli/plugins/<name>/`; in development it builds them from source on first
 * request. Only authenticated callers allowed by `cli.plugins.access` get any
 * of them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Glob } from "bun";
import { type Context, Hono } from "hono";
import { every } from "hono/combine";
import { createMiddleware } from "hono/factory";
import {
  CLOUD_CLI_API_VERSION,
  CLOUD_CLI_MODULE_NAME,
  CLOUD_CLI_PLUGIN_ENTRY,
  CLOUD_CLI_PLUGIN_ROUTE,
  CLOUD_CLI_REFERENCE_INDEX,
  type CloudCliPluginFile,
  type CloudCliPluginManifest,
  cloudCliPluginDigest,
  isCloudCliPluginFilePath,
  parseCloudCliPluginManifest,
  sha512Hex,
  validateCloudCliModule,
} from "../cli/plugin";
import { env } from "../config/env";
import type { AppCliModules } from "../contracts/app";
import { type AuthContext, auth } from "../server/middleware/auth";
import { logger } from "../services/logging";
import { get } from "../services/settings";
import { buildMetadata } from "./build-metadata";

/** Set by `scripts/build.ts`; the bundle lives next to `dist/cli/`. */
declare const __CLOUD_CLI_PLUGINS__: string | undefined;

export const CLI_PLUGIN_ACCESS_SETTING = "cli.plugins.access";

/** Reject names and paths that cannot become a served plugin. Returns the module names. */
export const validateAppCliModules = (appId: string, cli: AppCliModules | undefined): string[] => {
  const names = Object.keys(cli ?? {});
  for (const name of names) {
    if (!CLOUD_CLI_MODULE_NAME.test(name)) throw new Error(`App "${appId}" declares CLI module "${name}"; use a kebab-case name`);
    const declaration = cli?.[name];
    for (const key of ["module", "references"] as const) {
      const path = declaration?.[key];
      if (typeof path !== "string" || path === "" || isAbsolute(path)) {
        throw new Error(`App "${appId}" CLI module "${name}" needs a relative ${key} path`);
      }
    }
  }
  return names;
};

export type BuiltCliPlugin = {
  manifest: CloudCliPluginManifest;
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
};

const referenceFiles = async (directory: string): Promise<Map<string, Uint8Array<ArrayBuffer>>> => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for await (const path of new Glob("**/*").scan({ cwd: directory, onlyFiles: true, dot: true })) {
    const name = `references/${path.split(sep).join("/")}`;
    if (!isCloudCliPluginFilePath(name)) throw new Error(`CLI reference ${path} must be a Markdown file with a plain name`);
    files.set(name, new Uint8Array(await readFile(join(directory, path))));
  }
  if (!files.has(CLOUD_CLI_REFERENCE_INDEX)) throw new Error(`CLI references in ${directory} need an index.md`);
  return files;
};

/**
 * Bundle one CLI module and collect its references. The bundle carries every
 * dependency, including its own copy of `@k2b/cloud/cli`, because `cld`
 * installs no plugin dependencies.
 */
export const buildCliPlugin = async (params: {
  appDir: string;
  appId: string;
  name: string;
  declaration: { module: string; references: string };
  version: string;
}): Promise<BuiltCliPlugin> => {
  const { appDir, appId, name, declaration, version } = params;
  const result = await Bun.build({
    entrypoints: [resolve(appDir, declaration.module)],
    target: "bun",
    format: "esm",
    minify: true,
    // Playwright references this optional BiDi adapter lazily; Cloud uses CDP.
    external: ["chromium-bidi/*"],
  });
  if (!result.success) {
    throw new Error(`CLI module "${name}" failed to bundle:\n${result.logs.map((log) => String(log)).join("\n")}`);
  }
  if (result.outputs.length !== 1 || result.outputs[0]!.kind !== "entry-point") {
    throw new Error(`CLI module "${name}" must bundle into one file; it produced ${result.outputs.length}`);
  }
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
    [CLOUD_CLI_PLUGIN_ENTRY, new Uint8Array(await result.outputs[0]!.arrayBuffer())],
    ...(await referenceFiles(resolve(appDir, declaration.references))),
  ]);
  const list: CloudCliPluginFile[] = [...files]
    .map(([path, bytes]) => ({ path, size: bytes.byteLength, sha512: sha512Hex(bytes) }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  return {
    manifest: {
      apiVersion: CLOUD_CLI_API_VERSION,
      name,
      app: appId,
      version,
      entry: CLOUD_CLI_PLUGIN_ENTRY,
      digest: cloudCliPluginDigest(list),
      files: list,
    },
    files,
  };
};

/** Write a built plugin to `<directory>/`, then import it once to check its default export. */
export const writeCliPlugin = async (directory: string, plugin: BuiltCliPlugin): Promise<void> => {
  for (const [path, bytes] of plugin.files) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(plugin.manifest, null, 2)}\n`);
  const loaded: unknown = await import(pathToFileURL(join(directory, CLOUD_CLI_PLUGIN_ENTRY)).href);
  const module = validateCloudCliModule(typeof loaded === "object" && loaded !== null ? (loaded as { default?: unknown }).default : null);
  if (module.name !== plugin.manifest.name) {
    throw new Error(`CLI module declared as "${plugin.manifest.name}" exports the name "${module.name}"`);
  }
};

type ServedCliPlugin = {
  manifest: CloudCliPluginManifest;
  read: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
};

const builtPluginsDirectory = (): string | null =>
  typeof __CLOUD_CLI_PLUGINS__ === "string" ? fileURLToPath(new URL(__CLOUD_CLI_PLUGINS__, import.meta.url)) : null;

const loadBuiltPlugin = async (root: string, name: string): Promise<ServedCliPlugin> => {
  const directory = join(root, name);
  const manifest = parseCloudCliPluginManifest(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  return { manifest, read: async (path) => new Uint8Array(await readFile(join(directory, path))) };
};

const buildSourcePlugin = async (appId: string, name: string, declaration: { module: string; references: string }) => {
  const plugin = await buildCliPlugin({
    appDir: env.APP_DIR ?? process.cwd(),
    appId,
    name,
    declaration,
    version: buildMetadata.version,
  });
  return { manifest: plugin.manifest, read: async (path: string) => plugin.files.get(path)! };
};

/** Resolves served plugins: prebuilt files in production, a cached source build in development. */
const createPluginSource = (appId: string, cli: AppCliModules, root: string | null) => {
  const cache = new Map<string, Promise<ServedCliPlugin>>();
  return (name: string): Promise<ServedCliPlugin> | null => {
    const declaration = Object.hasOwn(cli, name) ? cli[name] : undefined;
    if (!declaration) return null;
    let pending = cache.get(name);
    if (!pending) {
      pending = root ? loadBuiltPlugin(root, name) : buildSourcePlugin(appId, name, declaration);
      // A failed source build is retried on the next request instead of being cached.
      pending.catch(() => cache.delete(name));
      cache.set(name, pending);
    }
    return pending;
  };
};

/**
 * Access rule for every plugin route, the list included: an authenticated
 * caller (session, OAuth token, or API key) with `read` scope when OAuth is
 * used, and no guest account unless `cli.plugins.access` is `all_users`. A
 * service account without a delegated user is not a guest.
 */
export const requireCliPluginAccess = every(
  auth.requireRole("authenticated"),
  auth.requireOAuthScope("read"),
  createMiddleware<AuthContext>(async (c, next) => {
    const access = await get<string>(CLI_PLUGIN_ACCESS_SETTING);
    if (access !== "all_users" && c.get("user")?.profile === "guest") {
      return c.json({ code: "FORBIDDEN", message: "CLI plugins are available to full accounts only" }, 403);
    }
    return next();
  }),
);

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } as const;

/**
 * Framework-owned plugin routes of one application, mounted at
 * `/cli/plugins`. The gateway reaches them through the `/cli/plugins/<name>`
 * prefixes `defineApp` adds to the application's routes.
 */
export const createCliPluginRoutes = (appId: string, cli: AppCliModules, builtRoot = builtPluginsDirectory()) => {
  const source = createPluginSource(appId, cli, builtRoot);
  const log = logger("cli-plugins");
  const served = async (c: Context<AuthContext>): Promise<ServedCliPlugin | Response> => {
    const pending = source(c.req.param("name") ?? "");
    if (!pending) return c.json({ code: "NOT_FOUND", message: "CLI plugin not found" }, 404);
    try {
      return await pending;
    } catch (error) {
      log.error("CLI plugin unavailable", {
        appId,
        name: c.req.param("name"),
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ code: "UNAVAILABLE", message: "CLI plugin is unavailable" }, 503);
    }
  };
  return new Hono<AuthContext>()
    .get("/:name/manifest.json", requireCliPluginAccess, async (c) => {
      const plugin = await served(c);
      if (plugin instanceof Response) return plugin;
      return c.json(plugin.manifest, 200, privateHeaders);
    })
    .get("/:name/*", requireCliPluginAccess, async (c) => {
      const plugin = await served(c);
      if (plugin instanceof Response) return plugin;
      const prefix = `${CLOUD_CLI_PLUGIN_ROUTE}/${plugin.manifest.name}/`;
      const path = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
      if (!plugin.manifest.files.some((file) => file.path === path)) {
        return c.json({ code: "NOT_FOUND", message: "CLI plugin file not found" }, 404);
      }
      const bytes = await plugin.read(path);
      return c.body(bytes, 200, { ...privateHeaders, "content-type": CONTENT_TYPES[path.slice(path.lastIndexOf("."))]! });
    });
};

/** The gateway prefixes of an application's plugin routes. */
export const cliPluginRoutePrefixes = (names: readonly string[]): string[] => names.map((name) => `${CLOUD_CLI_PLUGIN_ROUTE}/${name}`);
