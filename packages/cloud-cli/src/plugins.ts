/**
 * Third-party application CLI modules installed as `cld` plugins.
 *
 * A plugin is one directory `<plugins>/<id>/` holding a `package.json` with
 * `"cld": { "apiVersion": 1, "entry": "<relative path>" }`. The entry is a
 * self-contained ESM file whose default export is a `CloudCliModule` named
 * `<id>`. Plugins run in the `cld` process with the invoking user's
 * credentials; they are trusted code, not sandboxed code.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CloudCliModule } from "@k2b/cloud/cli";
import { userConfigDirectory } from "./config";

const execFileAsync = promisify(execFile);

/** Plugin contract version: the `CloudCliModule` shape exported by `@k2b/cloud/cli`. */
export const CLD_PLUGIN_API_VERSION = 1;
export const NPM_REGISTRY = "https://registry.npmjs.org";
const INSTALL_RECORD = ".cld-install.json";
const FETCH_TIMEOUT_MS = 60_000;
const MODULE_NAME = /^[a-z][a-z0-9-]*$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export const pluginsDirectory = (): string => join(userConfigDirectory(), "cloud", "cld", "plugins");

export type PluginManifest = { package: string; version: string; entry: string };

export type PluginStatus = "ok" | "shadowed" | "incompatible" | "error";

export type PluginInfo = {
  id: string;
  package?: string;
  version?: string;
  source: string;
  status: PluginStatus;
  message?: string;
};

export class PluginError extends Error {
  constructor(
    message: string,
    readonly status: Exclude<PluginStatus, "ok"> = "error",
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Read and validate `<directory>/package.json`. */
export const readPluginManifest = async (directory: string): Promise<PluginManifest> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch (error) {
    throw new PluginError(`cannot read package.json (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new PluginError("package.json needs a string name and version");
  }
  const cld = raw.cld;
  if (!isRecord(cld)) throw new PluginError('package.json has no "cld" manifest');
  if (cld.apiVersion !== CLD_PLUGIN_API_VERSION) {
    throw new PluginError(`needs plugin API ${String(cld.apiVersion)}; this cld supports ${CLD_PLUGIN_API_VERSION}`, "incompatible");
  }
  if (typeof cld.entry !== "string" || cld.entry === "" || isAbsolute(cld.entry)) {
    throw new PluginError('"cld.entry" must be a relative file path');
  }
  const entry = resolve(directory, cld.entry);
  const inside = relative(resolve(directory), entry);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new PluginError('"cld.entry" must stay inside the plugin directory');
  if (!(await stat(entry).catch(() => null))?.isFile()) throw new PluginError(`entry ${cld.entry} does not exist`);
  return { package: raw.name, version: raw.version, entry };
};

/**
 * Check the default export structurally. `instanceof` would fail because a
 * plugin bundles its own copy of `@k2b/cloud/cli`.
 */
export const validatePluginModule = (value: unknown): CloudCliModule => {
  if (!isRecord(value)) throw new PluginError("default export is not a CLI module");
  if (typeof value.name !== "string" || !MODULE_NAME.test(value.name)) {
    throw new PluginError("default export needs a lowercase kebab-case name");
  }
  if (typeof value.summary !== "string") throw new PluginError("default export needs a string summary");
  if (typeof value.run !== "function") throw new PluginError("default export needs a run function");
  for (const key of ["help", "requiresCloudFor"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "function") throw new PluginError(`${key} must be a function`);
  }
  if (value.requiresCloud !== undefined && typeof value.requiresCloud !== "boolean") {
    throw new PluginError("requiresCloud must be a boolean");
  }
  const flags = value.booleanFlags;
  if (flags !== undefined && (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string"))) {
    throw new PluginError("booleanFlags must be a string array");
  }
  return value as CloudCliModule;
};

const importPluginModule = async (entry: string): Promise<CloudCliModule> => {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new PluginError(`cannot load entry (${error instanceof Error ? error.message : String(error)})`);
  }
  return validatePluginModule(isRecord(loaded) ? loaded.default : undefined);
};

const importInstalledPlugin = async (id: string, manifest: PluginManifest): Promise<CloudCliModule> => {
  const module = await importPluginModule(manifest.entry);
  if (module.name !== id) throw new PluginError(`module name "${module.name}" does not match its directory "${id}"`);
  return module;
};

/** Load plugin `<id>`; returns undefined when it is not installed. */
export const loadPlugin = async (id: string, root = pluginsDirectory()): Promise<CloudCliModule | undefined> => {
  if (!MODULE_NAME.test(id)) return undefined;
  const directory = join(root, id);
  if (!(await stat(directory).catch(() => null))?.isDirectory()) return undefined;
  return importInstalledPlugin(id, await readPluginManifest(directory));
};

const readInstallSource = async (directory: string): Promise<string> => {
  try {
    const record: unknown = JSON.parse(await readFile(join(directory, INSTALL_RECORD), "utf8"));
    return isRecord(record) && typeof record.source === "string" ? record.source : "manual";
  } catch {
    return "manual";
  }
};

const pluginIds = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
};

export type LoadedPlugins = { modules: CloudCliModule[]; plugins: PluginInfo[] };

/**
 * Load every installed plugin. A failing plugin is reported with its status
 * and never prevents the others or the built-in modules from working.
 * Names in `reserved` belong to built-in commands and win over `cld <id>`;
 * a shadowed plugin still loads through `cld plugins run <id>`.
 */
export const loadPlugins = async (reserved: ReadonlySet<string>, root = pluginsDirectory()): Promise<LoadedPlugins> => {
  const modules: CloudCliModule[] = [];
  const plugins: PluginInfo[] = [];
  for (const id of await pluginIds(root)) {
    const directory = join(root, id);
    const info: PluginInfo = { id, source: await readInstallSource(directory), status: "ok" };
    plugins.push(info);
    try {
      const manifest = await readPluginManifest(directory);
      info.package = manifest.package;
      info.version = manifest.version;
      const module = await importInstalledPlugin(id, manifest);
      if (reserved.has(id)) throw new PluginError(`shadowed by a built-in command, use \`cld plugins run ${id}\``, "shadowed");
      modules.push(module);
    } catch (error) {
      info.status = error instanceof PluginError ? error.status : "error";
      info.message = error instanceof Error ? error.message : String(error);
    }
  }
  return { modules, plugins };
};

export type StagedPlugin = {
  /** Temporary directory holding the unpacked package. */
  directory: string;
  manifest: PluginManifest;
  source: string;
  cleanup: () => Promise<void>;
};

const parseNpmSpec = (spec: string): { name: string; version: string } => {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at < 0 ? spec : spec.slice(0, at);
  const version = at < 0 ? "latest" : spec.slice(at + 1);
  if (!NPM_NAME.test(name) || version === "") throw new PluginError(`"${spec}" is neither a local path nor an npm package name`);
  return { name, version };
};

const extractTarball = async (archive: string, workspace: string): Promise<string> => {
  const target = join(workspace, "unpacked");
  await mkdir(target, { recursive: true });
  await execFileAsync("tar", ["-xzf", archive, "-C", target]);
  // npm tarballs wrap the package in one top-level `package/` directory.
  const entries = await readdir(target, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.isDirectory() ? join(target, entries[0]!.name) : target;
};

const downloadNpmTarball = async (spec: string, workspace: string, registry: string): Promise<{ archive: string; source: string }> => {
  const { name, version } = parseNpmSpec(spec);
  const base = registry.replace(/\/+$/, "");
  const metadataUrl = `${base}/${name.replaceAll("/", "%2f")}/${encodeURIComponent(version)}`;
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new PluginError(`npm registry returned ${response.status} for ${name}@${version}`);
  const metadata: unknown = await response.json();
  const dist = isRecord(metadata) && isRecord(metadata.dist) ? metadata.dist : undefined;
  const resolved = isRecord(metadata) && typeof metadata.version === "string" ? metadata.version : undefined;
  if (!dist || typeof dist.tarball !== "string" || typeof dist.integrity !== "string" || !resolved) {
    throw new PluginError(`npm registry metadata for ${name}@${version} has no tarball integrity`);
  }
  const [algorithm, expected] = dist.integrity.split(/-(.*)/s);
  if (algorithm !== "sha512" || !expected) throw new PluginError(`unsupported tarball integrity ${dist.integrity}`);
  const tarball = await fetch(dist.tarball, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!tarball.ok) throw new PluginError(`tarball download returned ${tarball.status}`);
  const bytes = new Uint8Array(await tarball.arrayBuffer());
  const actual = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
  if (actual !== expected) throw new PluginError(`tarball integrity mismatch for ${name}@${resolved}`);
  const archive = join(workspace, "package.tgz");
  await writeFile(archive, bytes);
  return { archive, source: `npm:${name}@${resolved}` };
};

/**
 * Unpack a plugin from a local directory, a local `.tgz`, or an npm package
 * spec (`name`, `name@version`, `name@tag`) into a temporary directory and
 * verify its manifest. Nothing is imported or placed yet.
 */
export const stagePlugin = async (spec: string, options: { registry?: string } = {}): Promise<StagedPlugin> => {
  const workspace = await mkdtemp(join(tmpdir(), "cld-plugin-"));
  const cleanup = () => rm(workspace, { recursive: true, force: true });
  try {
    const local = await stat(spec).catch(() => null);
    let directory: string;
    let source: string;
    if (local?.isDirectory()) {
      source = resolve(spec);
      directory = join(workspace, "package");
      await cp(source, directory, {
        recursive: true,
        filter: (path) => !["node_modules", ".git"].includes(basename(path)),
      });
    } else if (local?.isFile()) {
      source = resolve(spec);
      directory = await extractTarball(source, workspace);
    } else {
      const download = await downloadNpmTarball(spec, workspace, options.registry ?? NPM_REGISTRY);
      source = download.source;
      directory = await extractTarball(download.archive, workspace);
    }
    return { directory, manifest: await readPluginManifest(directory), source, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/**
 * Import the staged plugin to validate its module, then place it at
 * `<root>/<module name>`, replacing an earlier installation of the same id.
 */
export const commitPlugin = async (
  staged: StagedPlugin,
  reserved: ReadonlySet<string>,
  root = pluginsDirectory(),
): Promise<{ id: string; replaced: boolean }> => {
  const module = await importPluginModule(staged.manifest.entry);
  const id = module.name;
  if (reserved.has(id)) throw new PluginError(`plugin id "${id}" is reserved by a built-in cld command`, "shadowed");
  await writeFile(join(staged.directory, INSTALL_RECORD), `${JSON.stringify({ source: staged.source }, null, 2)}\n`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, id);
  const incoming = join(root, `.incoming-${id}-${crypto.randomUUID()}`);
  await cp(staged.directory, incoming, { recursive: true });
  const replaced = Boolean(await stat(target).catch(() => null));
  try {
    await rm(target, { recursive: true, force: true });
    await rename(incoming, target);
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
  return { id, replaced };
};

/** Remove plugin `<id>`; returns false when it is not installed. */
export const removePlugin = async (id: string, root = pluginsDirectory()): Promise<boolean> => {
  if (!MODULE_NAME.test(id)) return false;
  const directory = join(root, id);
  if (!(await stat(directory).catch(() => null))?.isDirectory()) return false;
  await rm(directory, { recursive: true, force: true });
  return true;
};
