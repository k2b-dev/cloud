#!/usr/bin/env bun
/**
 * Pack a `cld` module as a package plugin, for authors without a Cloud
 * application:
 *
 *   bun run node_modules/@k2b/cloud/scripts/cli-pack.ts src/cli.ts --references src/cli-references --out dist/cld-plugin
 *
 * Writes the same verified bundle the application build writes to
 * `dist/cli/<name>/` (`cli.js`, `references/`, `manifest.json`), plus a
 * `package.json` whose `cld.manifest` points at the manifest. Name and version
 * come from `package.json` in the current directory.
 */
import { lstat, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCliPlugin, writeCliPlugin } from "../src/_internal/cli-plugins";
import { validateCloudCliModule } from "../src/cli/plugin";

const USAGE = "Usage: bun run node_modules/@k2b/cloud/scripts/cli-pack.ts <module.ts> --references <dir> --out <dir>";

const HELP = `${USAGE}

Packs a cld module as a package plugin: the bundled module cli.js, the skill
references (index.md plus further Markdown files), manifest.json with the
SHA-512 of every file, and a package.json with "cld": { "manifest": "manifest.json" }.
Name and version come from package.json in the current directory.

--out must be missing, empty, or an earlier pack output, which is replaced.
Ship the result with \`npm publish <out>\` or \`npm pack <out>\`.`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (path: string): Promise<unknown> =>
  readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => null);

const parseArgs = (args: string[]) => {
  const [module, ...rest] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index]!, rest[index + 1]];
    if (!["--references", "--out"].includes(flag) || !value || value.startsWith("-") || flags.has(flag)) throw new Error(USAGE);
    flags.set(flag, value);
  }
  const references = flags.get("--references");
  const out = flags.get("--out");
  if (!module || module.startsWith("-") || !references || !out) throw new Error(USAGE);
  return { module: resolve(module), references: resolve(references), out: resolve(out) };
};

const containsPath = (directory: string, path: string): boolean => {
  const inside = relative(directory, path);
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

/** Empty `out` for a fresh pack; anything but an earlier pack output stays untouched. */
const prepareOut = async (out: string, inputs: string[]): Promise<void> => {
  const refusal = `Refusing --out ${out}: it must be missing, empty, or an earlier pack output.`;
  const output = await realpath(out).catch(() => out);
  for (const input of inputs) {
    const path = await realpath(input).catch(() => input);
    if (containsPath(out, input) || containsPath(output, path)) throw new Error(refusal);
  }
  const info = await lstat(out).catch(() => null);
  if (!info) return;
  if (!info.isDirectory()) throw new Error(refusal);
  const entries = await readdir(out);
  if (entries.length === 0) return;
  const previous = await readJson(join(out, "package.json"));
  if (
    entries.some((entry) => !["package.json", "manifest.json", "cli.js", "references"].includes(entry)) ||
    !isRecord(previous) ||
    !isRecord(previous.cld) ||
    previous.cld.manifest !== "manifest.json"
  )
    throw new Error(refusal);
  await rm(out, { recursive: true });
};

const pack = async (args: string[]): Promise<void> => {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const options = parseArgs(args);
  const cwd = process.cwd();
  const manifest = await readJson(join(cwd, "package.json"));
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== "string" ||
    !manifest.name ||
    typeof manifest.version !== "string" ||
    !manifest.version
  ) {
    throw new Error(`${join(cwd, "package.json")} needs a string name and version.`);
  }
  const { name: packageName, version } = manifest;
  await prepareOut(options.out, [cwd, options.module, options.references]);
  const loaded: unknown = await import(pathToFileURL(options.module).href);
  const module = validateCloudCliModule(isRecord(loaded) ? loaded.default : undefined);
  const plugin = await buildCliPlugin({
    appDir: cwd,
    appId: packageName,
    name: module.name,
    declaration: { module: options.module, references: options.references },
    version,
  });
  await writeCliPlugin(options.out, plugin);
  await writeFile(
    join(options.out, "package.json"),
    `${JSON.stringify({ name: packageName, version, type: "module", cld: { manifest: "manifest.json" } }, null, 2)}\n`,
  );
  const references = plugin.manifest.files.filter((file) => file.path.startsWith("references/")).length;
  console.log(
    `Packed ${packageName}@${version} (module "${module.name}", ${references} reference files) to ${options.out}. Ship it with \`npm publish ${options.out}\` or \`npm pack ${options.out}\`.`,
  );
};

pack(Bun.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.replace(/\s*\n\s*/g, " ") : String(error));
  process.exitCode = 1;
});
