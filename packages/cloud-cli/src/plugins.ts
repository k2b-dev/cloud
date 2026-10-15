/**
 * Package plugins: `cld` modules installed from a local directory, a `.tgz`,
 * or an npm package, for every profile.
 *
 * A package carries the same verified bundle a Cloud application serves
 * (`manifest.json`, `cli.js`, `references/`), packed with
 * `@k2b/cloud/scripts/cli-pack.ts`; its `package.json` points at the manifest
 * with `"cld": { "manifest": "manifest.json" }`. `cld` stages and verifies the
 * package without running its code, stores the bundle in the shared
 * content-addressed store, and records it in `<plugins>/packages.json`.
 * Plugins run in the `cld` process with the invoking user's credentials; they
 * are trusted code, not sandboxed code. Directories from the old package
 * format are listed as incompatible and never loaded.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CLOUD_CLI_MODULE_NAME, type CloudCliPluginManifest, parseCloudCliPluginManifest } from "@k2b/cloud/cli";
import { userConfigDirectory } from "./config";
import { checkPluginApiVersion } from "./plugin-store";

const execFileAsync = promisify(execFile);

export const NPM_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 60_000;
/** Directory of the plugin store inside the plugins directory; never a plugin ID. */
const STORE_DIRECTORY = "store";
const LOCKS_DIRECTORY = "locks";
const PACKAGE_RECORDS = "packages.json";
const DIGEST = /^[0-9a-f]{128}$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const pluginsDirectory = (): string => join(userConfigDirectory(), "cloud", "cld", "plugins");

export type PluginStatus = "ok" | "shadowed" | "incompatible" | "error";

export type PluginInfo = { id: string; package?: string; version?: string; source: string; status: PluginStatus; message?: string };

export class PluginError extends Error {
  constructor(
    message: string,
    readonly status: Exclude<PluginStatus, "ok"> = "error",
  ) {
    super(message);
  }
}

/** One installed package plugin; `source` is the resolved path or `npm:name@version`. */
export type PackagePlugin = { package: string; version: string; digest: string; summary: string; source: string };
export type PackagePlugins = Record<string, PackagePlugin>;

/** Drop invalid records rather than treating them as installed modules. */
export const readPackagePlugins = async (root = pluginsDirectory()): Promise<PackagePlugins> => {
  const raw: unknown = await readFile(join(root, PACKAGE_RECORDS), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const records: PackagePlugins = {};
  if (!isRecord(raw)) return records;
  for (const [name, entry] of Object.entries(raw)) {
    if (
      !CLOUD_CLI_MODULE_NAME.test(name) ||
      !isRecord(entry) ||
      typeof entry.package !== "string" ||
      !entry.package ||
      typeof entry.version !== "string" ||
      !entry.version ||
      typeof entry.digest !== "string" ||
      !DIGEST.test(entry.digest) ||
      typeof entry.summary !== "string" ||
      typeof entry.source !== "string" ||
      !entry.source
    )
      continue;
    records[name] = { package: entry.package, version: entry.version, digest: entry.digest, summary: entry.summary, source: entry.source };
  }
  return records;
};

/** Write atomically while the caller holds the packages lock inside the config lock. */
export const writePackagePlugins = async (records: PackagePlugins, root = pluginsDirectory()): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.packages-${crypto.randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(root, PACKAGE_RECORDS));
  } finally {
    await rm(temporary, { force: true });
  }
};

export const repackMessage = (name: string, version: string): string =>
  `${name}@${version} uses the old plugin format without a verified bundle; its author must re-pack it with \`bun run node_modules/@k2b/cloud/scripts/cli-pack.ts\``;

/** Every non-hidden directory except the store and locks is a legacy package installation. */
export const legacyPlugins = async (root = pluginsDirectory()): Promise<PluginInfo[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const plugins: PluginInfo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === STORE_DIRECTORY || entry.name === LOCKS_DIRECTORY) continue;
    const raw: unknown = await readFile(join(root, entry.name, "package.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    const name = isRecord(raw) && typeof raw.name === "string" ? raw.name : entry.name;
    const version = isRecord(raw) && typeof raw.version === "string" ? raw.version : "unknown";
    plugins.push({
      id: entry.name,
      package: name,
      version,
      source: join(root, entry.name),
      status: "incompatible",
      message: repackMessage(name, version),
    });
  }
  return plugins;
};

/** Remove only an exact legacy directory; never the store, locks or package records. */
export const removePlugin = async (id: string, root = pluginsDirectory()): Promise<boolean> => {
  if (!id || id.startsWith(".") || id.includes("/") || id.includes("\\") || id === STORE_DIRECTORY || id === LOCKS_DIRECTORY) return false;
  const directory = join(root, id);
  if (!(await lstat(directory).catch(() => null))?.isDirectory()) return false;
  await rm(directory, { recursive: true, force: true });
  return true;
};

/** lstat every entry, rejecting links anywhere and unlisted reference files. */
const verifyBundleDirectory = async (directory: string, manifest: CloudCliPluginManifest, prefix = ""): Promise<void> => {
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new PluginError(`Plugin bundle ${directory} must be a directory without symlinks.`);
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const file = prefix + entry;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new PluginError(`Plugin bundle contains a symlink: ${file}.`);
    if (info.isDirectory()) await verifyBundleDirectory(path, manifest, `${file}/`);
    else if (file.startsWith("references/") && !manifest.files.some((listed) => listed.path === file)) {
      throw new PluginError(`Plugin reference ${file} is not listed in its manifest.`);
    }
  }
};

/** A FIFO, device, or link would block or never end a read; metadata must be a plain file. */
const requireRegularFile = async (path: string, name: string): Promise<void> => {
  const info = await lstat(path).catch((error) => {
    throw new PluginError(`cannot read ${name} (${error instanceof Error ? error.message : String(error)})`);
  });
  if (!info.isFile()) throw new PluginError(`${name} must be a regular file.`);
};

const readPackageBundle = async (directory: string): Promise<{ manifest: CloudCliPluginManifest; bundle: string }> => {
  await requireRegularFile(join(directory, "package.json"), "package.json");
  const raw: unknown = await readFile(join(directory, "package.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      throw new PluginError(`cannot read package.json (${error instanceof Error ? error.message : String(error)})`);
    });
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name || typeof raw.version !== "string" || !raw.version) {
    throw new PluginError("package.json needs a string name and version");
  }
  if (!isRecord(raw.cld) || typeof raw.cld.manifest !== "string")
    throw new PluginError(repackMessage(raw.name, raw.version), "incompatible");
  const path = raw.cld.manifest;
  const inside = relative(resolve(directory), resolve(directory, path));
  if (!path || isAbsolute(path) || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new PluginError('"cld.manifest" must be a relative file path inside the package');
  }
  // Check every ancestor too: a symlink parent must not escape the package.
  let current = directory;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    if ((await lstat(current).catch(() => null))?.isSymbolicLink())
      throw new PluginError(`Plugin manifest path contains a symlink: ${path}.`);
  }
  await requireRegularFile(current, `plugin manifest ${path}`);
  let manifest: CloudCliPluginManifest;
  try {
    manifest = parseCloudCliPluginManifest(JSON.parse(await readFile(current, "utf8")));
  } catch (error) {
    throw new PluginError(`Invalid plugin manifest (${error instanceof Error ? error.message : String(error)}).`);
  }
  checkPluginApiVersion(manifest);
  if (manifest.app !== raw.name || manifest.version !== raw.version)
    throw new PluginError("Plugin manifest app/version must match package.json name/version.");
  const bundle = dirname(current);
  await verifyBundleDirectory(bundle, manifest);
  return { manifest, bundle };
};

export type StagedPlugin = {
  bundle: string;
  manifest: CloudCliPluginManifest;
  source: string;
  cleanup: () => Promise<void>;
};

/** A local reader applies the same exact-size contract as served downloads. */
export const readPackagePluginFile = async (staged: StagedPlugin, file: CloudCliPluginManifest["files"][number]): Promise<Uint8Array> => {
  const path = join(staged.bundle, file.path);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size !== file.size)
    throw new PluginError(`${staged.manifest.name}/${file.path} must be a regular file of exactly ${file.size} bytes.`);
  return readFile(path);
};

const parseNpmSpec = (spec: string): { name: string; version: string } => {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at < 0 ? spec : spec.slice(0, at);
  const version = at < 0 ? "latest" : spec.slice(at + 1);
  if (!NPM_NAME.test(name) || version === "") throw new PluginError(`"${spec}" is not an npm package name`);
  return { name, version };
};

const extractTarball = async (archive: string, workspace: string): Promise<string> => {
  const target = join(workspace, "unpacked");
  await mkdir(target, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", target]);
  } catch (error) {
    const message =
      isRecord(error) && typeof error.stderr === "string" ? error.stderr : error instanceof Error ? error.message : String(error);
    throw new PluginError(`Cannot unpack ${archive}: ${message.trim().split(/[\r\n]/)[0]}`);
  }
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

/** `npm:` marks an npm package spec (`npm:name`, `npm:name@version`, `npm:name@tag`). */
export const NPM_SPEC_PREFIX = "npm:";

/**
 * Whether an install target names a local path or an npm package rather than
 * a plugin served by the Cloud: `npm:<spec>`, or a path with a slash or an
 * archive extension (`./inventory`, `inventory-1.0.0.tgz`).
 */
export const isPackagePluginSource = (spec: string): boolean =>
  spec.startsWith(NPM_SPEC_PREFIX) || spec.includes("/") || /\.(tgz|tar\.gz)$/.test(spec);

/**
 * Unpack a plugin from a local `.tgz` or an npm package spec (`npm:name`,
 * `npm:name@version`, `npm:name@tag`) into a temporary directory, or read a
 * local directory in place, and verify its manifest. Nothing is imported or
 * placed yet.
 */
export const stagePlugin = async (spec: string, options: { registry?: string } = {}): Promise<StagedPlugin> => {
  const workspace = await mkdtemp(join(tmpdir(), "cld-plugin-"));
  const cleanup = () => rm(workspace, { recursive: true, force: true });
  try {
    const npm = spec.startsWith(NPM_SPEC_PREFIX);
    const local = npm ? null : await stat(spec).catch(() => null);
    let directory: string;
    let source: string;
    if (local?.isDirectory()) {
      // Read in place: storing checks every file against the confirmed manifest.
      source = resolve(spec);
      directory = source;
    } else if (local?.isFile()) {
      source = resolve(spec);
      directory = await extractTarball(source, workspace);
    } else if (npm) {
      const download = await downloadNpmTarball(spec.slice(NPM_SPEC_PREFIX.length), workspace, options.registry ?? NPM_REGISTRY);
      source = download.source;
      directory = await extractTarball(download.archive, workspace);
    } else {
      throw new PluginError(`${spec} does not exist; use ${NPM_SPEC_PREFIX}<package> for an npm package`);
    }
    return { ...(await readPackageBundle(directory)), source, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
