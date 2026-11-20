import { basename, resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { catalogVariantSource } from "../../packages/cloud/src/_internal/catalog-variants";
import { buildIslandClosure } from "./island-closure";

/** Rewrites one source module as an island build variant does. */
export type IslandSourceTransform = (source: string, path: string) => string | Promise<string>;

/** The source rewrite of one Cloud language build, the island code a page in that language loads. */
export const cloudLanguageBuild =
  (variant: string): IslandSourceTransform =>
  (source, path) =>
    catalogVariantSource(source, path, variant);

/** The given files plus every reachable module `transform` changes, found the way `@k2b/ssr` finds them for variants. */
const variantFiles = async (entries: string[], overrides: Record<string, string> | undefined, transform: IslandSourceTransform) => {
  const discovery = await Bun.build({
    files: overrides,
    entrypoints: entries,
    target: "browser",
    conditions: ["browser", "production"],
    external: ["solid-js/jsx-runtime", "solid-js/jsx-dev-runtime"],
    jsx: { runtime: "automatic", importSource: "solid-js" },
    metafile: true,
  });
  if (!discovery.success || !discovery.metafile) throw new AggregateError(discovery.logs, "Could not list the island modules");
  const files = { ...overrides };
  for (const input of Object.keys(discovery.metafile.inputs)) {
    const path = resolve(input);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    const source = files[path] ?? (await Bun.file(path).text());
    const contents = await transform(source, path);
    if (contents !== source) files[path] = contents;
  }
  return files;
};

/**
 * One split production build, counting each eagerly reachable output once, without dynamic-import edges. Modules whose
 * code reaches no output are measured as stubs: their unused code would otherwise change the minifier's names and the
 * chunk hashes, and the Brotli size with them, by tens of bytes (#2875). The live code is measured as built.
 */
export async function islandBundleSize(entries: string[], overrides?: Record<string, string>, transform?: IslandSourceTransform) {
  const files = transform ? await variantFiles(entries, overrides, transform) : overrides;
  const first = await buildIslandClosure(entries, files);
  if (!first.metafile) throw new Error("Missing island bundle metafile");
  const used = new Set<string>();
  for (const output of Object.values(first.metafile.outputs))
    for (const [input, details] of Object.entries(output.inputs)) if (details.bytesInOutput) used.add(resolve(input));
  const dead = new Set(
    Object.keys(first.metafile.inputs)
      .map((input) => resolve(input))
      .filter((input) => !used.has(input)),
  );
  // Every name a module of the build imports or re-exports by name; a dead module keeps only those exports.
  const imported = new Set<string>();
  for (const input of Object.keys(first.metafile.inputs)) {
    const path = resolve(input);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    const code = files?.[path] ?? (await Bun.file(path).text());
    for (const [, list] of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\b/g))
      for (const item of list!.split(",")) {
        const name = item
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0];
        if (name) imported.add(name);
      }
  }
  const build = await buildIslandClosure(entries, files, dead, imported);
  const meta = build.metafile;
  if (!meta) throw new Error("Missing island bundle metafile");
  const outputs = new Map(Object.entries(meta.outputs).map(([path, output]) => [basename(path), output]));
  const eagerChunks = new Set<string>();
  const visit = (path: string) => {
    const key = basename(path);
    if (eagerChunks.has(key)) return;
    const output = outputs.get(key);
    if (!output) throw new Error(`Missing island output ${path}`);
    eagerChunks.add(key);
    for (const edge of output.imports) if (edge.kind !== "dynamic-import") visit(edge.path);
  };
  const entryPaths = new Set(entries.map((entry) => resolve(entry)));
  for (const [path, output] of outputs) if (output.entryPoint && entryPaths.has(resolve(output.entryPoint))) visit(path);
  if (!eagerChunks.size) throw new Error("No island entries found in bundle outputs");
  const eagerInputs = new Set<string>();
  const allInputs = new Set<string>();
  for (const [path, output] of outputs)
    for (const [input, details] of Object.entries(output.inputs)) {
      if (!details.bytesInOutput) continue;
      allInputs.add(input);
      if (eagerChunks.has(path)) eagerInputs.add(input);
    }
  let eagerBrotliBytes = 0;
  let eagerText = "";
  for (const output of build.outputs)
    if (eagerChunks.has(basename(output.path)) && output.path.endsWith(".js")) {
      const bytes = new Uint8Array(await output.arrayBuffer());
      eagerText += new TextDecoder().decode(bytes);
      eagerBrotliBytes += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength;
    }
  return {
    eagerBrotliBytes,
    /** The eager outputs' minified JavaScript, concatenated. */
    eagerText,
    eagerInputs: [...eagerInputs].sort(),
    dynamicInputs: [...allInputs].filter((input) => !eagerInputs.has(input)).sort(),
    eagerChunks: [...eagerChunks].sort(),
  };
}
