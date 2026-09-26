/**
 * Plugins served by a profile's Cloud.
 *
 * Every application serves its own `cld` module under `/cli/plugins/<name>/`
 * with a manifest that lists each file's SHA-512. `cld` downloads a plugin,
 * checks every file against the manifest and the manifest against its digest,
 * and keeps it content-addressed in `<plugins>/store/<digest>/`. Each profile
 * locks the plugins it uses (`name -> { app, version, digest }`) in the `cld`
 * config, so profiles for different Clouds use different versions and share
 * identical ones.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLOUD_CLI_API_VERSION,
  CLOUD_CLI_MODULE_NAME,
  CLOUD_CLI_PLUGIN_ENTRY,
  CLOUD_CLI_PLUGIN_ROUTE,
  type CloudCliModule,
  type CloudCliPluginManifest,
  type CloudCliPluginSummary,
  parseCloudCliPluginManifest,
  sha512Hex,
  validateCloudCliModule,
} from "@k2b/cloud/cli";
import { PluginError, pluginsDirectory } from "./plugins";

/** One locked plugin of a profile. `summary` lets `cld help` list it without loading it. */
export type LockedPlugin = { app: string; version: string; digest: string; summary: string };
export type PluginLock = Record<string, LockedPlugin>;

type CloudFetch = (path: string, init?: RequestInit) => Promise<Response>;

const DIGEST = /^[0-9a-f]{128}$/;
const INCOMING_PREFIX = ".incoming-";
/** An incoming directory this old belongs to a process that did not finish. */
const ABANDONED_INCOMING_MS = 60 * 60_000;

export const pluginStoreDirectory = (root = pluginsDirectory()): string => join(root, "store");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const failure = (response: Response, what: string): PluginError => {
  if (response.status === 401) return new PluginError(`${what}: the Cloud rejected the login (401). Run \`cld login\`.`);
  if (response.status === 403) return new PluginError(`${what}: this Cloud does not offer CLI plugins to your account (403).`);
  return new PluginError(`${what}: the Cloud answered ${response.status}.`);
};

/** `GET /cli/plugins` of the profile's Cloud; empty when the Cloud serves none. */
export const fetchAvailablePlugins = async (fetch: CloudFetch): Promise<CloudCliPluginSummary[]> => {
  const response = await fetch(CLOUD_CLI_PLUGIN_ROUTE, { headers: { accept: "application/json" } });
  // Clouds released before served plugins answer 404: they serve none.
  if (response.status === 404) return [];
  if (!response.ok) throw failure(response, "Cannot list plugins");
  const payload: unknown = await response.json().catch(() => null);
  const plugins = isRecord(payload) ? payload.plugins : undefined;
  if (!Array.isArray(plugins)) throw new PluginError("Cannot list plugins: the Cloud sent an invalid list.");
  return plugins.filter(
    (plugin): plugin is CloudCliPluginSummary =>
      isRecord(plugin) &&
      typeof plugin.name === "string" &&
      CLOUD_CLI_MODULE_NAME.test(plugin.name) &&
      typeof plugin.app === "string" &&
      typeof plugin.version === "string",
  );
};

/** Fetch and verify one plugin manifest, including the plugin API version. */
export const fetchPluginManifest = async (fetch: CloudFetch, name: string): Promise<CloudCliPluginManifest> => {
  const response = await fetch(`${CLOUD_CLI_PLUGIN_ROUTE}/${name}/manifest.json`, { headers: { accept: "application/json" } });
  if (response.status === 404) throw new PluginError(`This Cloud serves no plugin "${name}".`);
  if (!response.ok) throw failure(response, `Cannot read plugin "${name}"`);
  let manifest: CloudCliPluginManifest;
  try {
    manifest = parseCloudCliPluginManifest(await response.json());
  } catch (error) {
    throw new PluginError(`Plugin "${name}" has an invalid manifest (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (manifest.name !== name) throw new PluginError(`Plugin "${name}" answered with a manifest for "${manifest.name}".`);
  if (manifest.apiVersion !== CLOUD_CLI_API_VERSION) {
    throw new PluginError(
      manifest.apiVersion > CLOUD_CLI_API_VERSION
        ? `Plugin "${name}" needs plugin API ${manifest.apiVersion}; this cld supports ${CLOUD_CLI_API_VERSION}. Run \`cld update\`.`
        : `Plugin "${name}" uses plugin API ${manifest.apiVersion}; this cld supports ${CLOUD_CLI_API_VERSION}. Update the Cloud or install an older cld.`,
      "incompatible",
    );
  }
  return manifest;
};

/** Read a response body of exactly `size` bytes; stop as soon as it is longer. */
const readExactly = async (response: Response, size: number, label: string): Promise<Uint8Array> => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (offset + chunk.value.byteLength > size) {
        await reader.cancel();
        throw new PluginError(`${label} is larger than its manifest says.`);
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  }
  if (offset !== size) throw new PluginError(`${label} is smaller than its manifest says.`);
  return bytes;
};

const loadModuleFile = async (entry: string, name: string): Promise<CloudCliModule> => {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new PluginError(`Plugin "${name}" cannot load (${error instanceof Error ? error.message : String(error)}).`);
  }
  let module: CloudCliModule;
  try {
    module = validateCloudCliModule(isRecord(loaded) ? loaded.default : undefined);
  } catch (error) {
    throw new PluginError(`Plugin "${name}" is invalid: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (module.name !== name) throw new PluginError(`Plugin "${name}" exports the module "${module.name}".`);
  return module;
};

/**
 * Download every file of `manifest` into a new incoming directory of the
 * store, verifying size and SHA-512, then load the module once to check it.
 * The caller places the result with {@link placePlugin}.
 */
export const downloadPlugin = async (
  fetch: CloudFetch,
  manifest: CloudCliPluginManifest,
  root = pluginsDirectory(),
): Promise<{ incoming: string; module: CloudCliModule }> => {
  const store = pluginStoreDirectory(root);
  await mkdir(store, { recursive: true, mode: 0o700 });
  const incoming = join(store, `${INCOMING_PREFIX}${crypto.randomUUID()}`);
  try {
    await Promise.all(
      manifest.files.map(async (file) => {
        const response = await fetch(`${CLOUD_CLI_PLUGIN_ROUTE}/${manifest.name}/${file.path}`);
        if (!response.ok) throw failure(response, `Cannot download ${manifest.name}/${file.path}`);
        const bytes = await readExactly(response, file.size, `${manifest.name}/${file.path}`);
        if (sha512Hex(bytes) !== file.sha512) throw new PluginError(`${manifest.name}/${file.path} does not match its SHA-512.`);
        const target = join(incoming, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600 });
      }),
    );
    await writeFile(join(incoming, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { incoming, module: await loadModuleFile(join(incoming, CLOUD_CLI_PLUGIN_ENTRY), manifest.name) };
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
};

/** Move a verified download to `store/<digest>`; an identical plugin already there is kept. */
export const placePlugin = async (incoming: string, digest: string, root = pluginsDirectory()): Promise<void> => {
  const target = join(pluginStoreDirectory(root), digest);
  if ((await stat(target).catch(() => null))?.isDirectory()) {
    await rm(incoming, { recursive: true, force: true });
    return;
  }
  await rename(incoming, target);
};

/** Whether the store holds the plugin with `digest`. */
export const hasStoredPlugin = async (digest: string, root = pluginsDirectory()): Promise<boolean> =>
  DIGEST.test(digest) &&
  Boolean((await stat(join(pluginStoreDirectory(root), digest, CLOUD_CLI_PLUGIN_ENTRY)).catch(() => null))?.isFile());

/** Load the locked plugin `name` from the store. */
export const loadStoredPlugin = async (name: string, locked: LockedPlugin, root = pluginsDirectory()): Promise<CloudCliModule> => {
  if (!(await hasStoredPlugin(locked.digest, root))) {
    throw new PluginError(`Plugin "${name}" is missing from the plugin store. Run \`cld plugins install ${name}\`.`);
  }
  return loadModuleFile(join(pluginStoreDirectory(root), locked.digest, CLOUD_CLI_PLUGIN_ENTRY), name);
};

/** The skill reference files of a stored plugin, as `references/<path>` in manifest order. */
export const storedReferenceFiles = async (locked: LockedPlugin, root = pluginsDirectory()): Promise<string[]> => {
  const raw: unknown = JSON.parse(await readFile(join(pluginStoreDirectory(root), locked.digest, "manifest.json"), "utf8"));
  return parseCloudCliPluginManifest(raw)
    .files.map((file) => file.path)
    .filter((path) => path.startsWith("references/"))
    .map((path) => path.slice("references/".length));
};

/** Read one skill reference of a stored plugin; `file` defaults to `index.md`. */
export const readStoredReference = async (
  name: string,
  locked: LockedPlugin,
  file = "index.md",
  root = pluginsDirectory(),
): Promise<string> => {
  if (!(await hasStoredPlugin(locked.digest, root))) {
    throw new PluginError(`Plugin "${name}" is missing from the plugin store. Run \`cld plugins install ${name}\`.`);
  }
  const files = await storedReferenceFiles(locked, root);
  if (!files.includes(file)) {
    throw new PluginError(`Plugin "${name}" has no reference "${file}". Available: ${files.join(", ")}.`);
  }
  return readFile(join(pluginStoreDirectory(root), locked.digest, "references", file), "utf8");
};

/**
 * Remove stored plugins that no profile locks, and incoming directories that
 * an interrupted process left behind. Run it while holding the config lock.
 */
export const collectPluginGarbage = async (referenced: ReadonlySet<string>, root = pluginsDirectory()): Promise<string[]> => {
  const store = pluginStoreDirectory(root);
  const removed: string[] = [];
  for (const entry of await readdir(store, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const path = join(store, entry.name);
    if (DIGEST.test(entry.name) && !referenced.has(entry.name)) {
      await rm(path, { recursive: true, force: true });
      removed.push(entry.name);
    } else if (entry.name.startsWith(INCOMING_PREFIX)) {
      const modified = (await stat(path).catch(() => null))?.mtimeMs ?? Date.now();
      if (Date.now() - modified > ABANDONED_INCOMING_MS) await rm(path, { recursive: true, force: true });
    }
  }
  return removed;
};

/** Parse a profile's plugin lock, dropping entries that cannot be valid. */
export const readPluginLock = (value: unknown): PluginLock => {
  if (!isRecord(value)) return {};
  const lock: PluginLock = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      CLOUD_CLI_MODULE_NAME.test(name) &&
      isRecord(entry) &&
      typeof entry.app === "string" &&
      typeof entry.version === "string" &&
      typeof entry.digest === "string" &&
      DIGEST.test(entry.digest)
    ) {
      lock[name] = {
        app: entry.app,
        version: entry.version,
        digest: entry.digest,
        summary: typeof entry.summary === "string" ? entry.summary : "",
      };
    }
  }
  return lock;
};
