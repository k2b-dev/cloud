/**
 * `cld` plugin contract shared by the applications that serve plugins and by
 * `cld`, which installs and loads them.
 *
 * An application serves each declared CLI module under
 * `/cli/plugins/<name>/`: `manifest.json`, the bundled module `cli.js`, and
 * its skill references `references/<path>.md`. The manifest lists every file
 * with its SHA-512; the plugin digest is the SHA-512 of those lines, so one
 * value identifies the exact module and references.
 */
import type { CloudCliModule } from "./index";

/** Version of the `CloudCliModule` shape a plugin's default export implements. */
export const CLOUD_CLI_API_VERSION = 1;

/** Gateway route under which applications serve their `cld` plugins. */
export const CLOUD_CLI_PLUGIN_ROUTE = "/cli/plugins";

/** Module names: `cld <name>`, the plugin ID, and the route segment. */
export const CLOUD_CLI_MODULE_NAME = /^[a-z][a-z0-9-]*$/;

/** File name of the bundled module inside a plugin. */
export const CLOUD_CLI_PLUGIN_ENTRY = "cli.js";

/** Entry file of a plugin's skill references. */
export const CLOUD_CLI_REFERENCE_INDEX = "references/index.md";

const PLUGIN_FILE_PATH = /^(?:cli\.js|references\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.md)$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;

export type CloudCliPluginFile = { path: string; size: number; sha512: string };

export type CloudCliPluginManifest = {
  apiVersion: number;
  /** Module name and plugin ID. */
  name: string;
  /** ID of the application that serves the plugin. */
  app: string;
  /** Version of the serving application build. */
  version: string;
  entry: typeof CLOUD_CLI_PLUGIN_ENTRY;
  /** SHA-512 over the file list; see {@link cloudCliPluginDigest}. */
  digest: string;
  files: CloudCliPluginFile[];
};

/** One entry of `GET /cli/plugins`. */
export type CloudCliPluginSummary = { name: string; app: string; version: string };

/** Whether `path` is a file name a plugin may contain. */
export const isCloudCliPluginFilePath = (path: string): boolean => PLUGIN_FILE_PATH.test(path);

export const sha512Hex = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha512").update(bytes).digest("hex");

/**
 * Plugin digest: SHA-512 of `<sha512>  <path>\n` for every file, sorted by
 * path. This is the `sha512sum` line format, so a plugin directory can be
 * checked with standard tools.
 */
export const cloudCliPluginDigest = (files: readonly Pick<CloudCliPluginFile, "path" | "sha512">[]): string =>
  sha512Hex(
    [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => `${file.sha512}  ${file.path}\n`)
      .join(""),
  );

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate a served manifest, including its digest. Throws an `Error` naming the first problem. */
export const parseCloudCliPluginManifest = (value: unknown): CloudCliPluginManifest => {
  if (!isRecord(value)) throw new Error("plugin manifest is not an object");
  const { apiVersion, name, app, version, entry, digest, files } = value;
  if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion)) throw new Error("plugin manifest needs an integer apiVersion");
  if (typeof name !== "string" || !CLOUD_CLI_MODULE_NAME.test(name)) throw new Error("plugin manifest needs a kebab-case name");
  if (typeof app !== "string" || app === "") throw new Error("plugin manifest needs an app");
  if (typeof version !== "string" || version === "") throw new Error("plugin manifest needs a version");
  if (entry !== CLOUD_CLI_PLUGIN_ENTRY) throw new Error(`plugin manifest entry must be ${CLOUD_CLI_PLUGIN_ENTRY}`);
  if (typeof digest !== "string" || !SHA512_HEX.test(digest)) throw new Error("plugin manifest needs a SHA-512 digest");
  if (!Array.isArray(files)) throw new Error("plugin manifest needs a file list");
  const seen = new Set<string>();
  const parsed = files.map((file): CloudCliPluginFile => {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      !isCloudCliPluginFilePath(file.path) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha512 !== "string" ||
      !SHA512_HEX.test(file.sha512)
    ) {
      throw new Error("plugin manifest lists an invalid file");
    }
    if (seen.has(file.path)) throw new Error(`plugin manifest lists ${file.path} twice`);
    seen.add(file.path);
    return { path: file.path, size: file.size, sha512: file.sha512 };
  });
  if (!seen.has(CLOUD_CLI_PLUGIN_ENTRY)) throw new Error(`plugin manifest does not list ${CLOUD_CLI_PLUGIN_ENTRY}`);
  if (!seen.has(CLOUD_CLI_REFERENCE_INDEX)) throw new Error(`plugin manifest does not list ${CLOUD_CLI_REFERENCE_INDEX}`);
  if (cloudCliPluginDigest(parsed) !== digest) throw new Error("plugin manifest digest does not match its files");
  return { apiVersion, name, app, version, entry, digest, files: parsed };
};

/**
 * Check a plugin's default export structurally. `instanceof` would fail
 * because every plugin bundles its own copy of `@k2b/cloud/cli`.
 */
export const validateCloudCliModule = (value: unknown): CloudCliModule => {
  if (!isRecord(value)) throw new Error("default export is not a CLI module");
  if (typeof value.name !== "string" || !CLOUD_CLI_MODULE_NAME.test(value.name)) {
    throw new Error("default export needs a lowercase kebab-case name");
  }
  if (typeof value.summary !== "string") throw new Error("default export needs a string summary");
  if (typeof value.run !== "function") throw new Error("default export needs a run function");
  for (const key of ["help", "requiresCloudFor"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "function") throw new Error(`${key} must be a function`);
  }
  if (value.requiresCloud !== undefined && typeof value.requiresCloud !== "boolean") {
    throw new Error("requiresCloud must be a boolean");
  }
  const flags = value.booleanFlags;
  if (flags !== undefined && (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string"))) {
    throw new Error("booleanFlags must be a string array");
  }
  return value as CloudCliModule;
};
