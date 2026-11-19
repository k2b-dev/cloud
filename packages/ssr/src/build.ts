/**
 * Island bundler - discovers *.island.tsx and *.client.tsx files,
 * transforms them for the browser, and outputs chunks to _ssr directory.
 */

import { Glob } from "bun";
import { existsSync } from "fs";
import { mkdir, readdir, stat, unlink } from "fs/promises";
import { basename, join, relative, resolve } from "path";
import { ASSET_MANIFEST, type AssetBuild, type AssetManifest, VARIANT_NAME } from "./adapter/utils";
import { canonicalFilePath, ISLAND_ID_LENGTH, islandIdFromFile, toStableKey } from "./island-id";
import { transform } from "./transform";

type ComponentType = "island" | "client";

export type DevSourcemap = "none" | "linked" | "inline";

const getComponentType = (path: string): ComponentType => (path.includes(".client.") ? "client" : "island");

const getSelector = (type: ComponentType, id: string) =>
  type === "island" ? `solid-island[data-id="${id}"]` : `solid-client[data-id="${id}"]`;

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const GENERATED_ASSET = /^(?:[a-f0-9]{12}|chunk-[a-z0-9]+)\.js(?:\.map)?$/i;

/** Rejects nested island/client imports in the browser module graph. */
const rejectNestedComponentImports = (
  metafile: Bun.BuildMetafile | undefined,
  components: readonly { path: string }[],
  cwd: string,
): void => {
  if (!metafile) throw new Error("[ssr] Bun.build() returned no metafile, so nested island imports cannot be checked.");
  const canonicalCwd = canonicalFilePath(cwd);
  const inputKeys = new Map(Object.keys(metafile.inputs).map((key) => [resolve(process.cwd(), key), key]));
  const violations: { importer: string; nested: string; via: string[] }[] = [];

  for (const component of components) {
    const root = inputKeys.get(component.path);
    if (!root) {
      throw new Error(
        `[ssr] Bun.build() metafile has no input for ${relative(canonicalCwd, component.path)}, so nested island imports cannot be checked.`,
      );
    }
    const parents = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    const nestedFiles = new Set<string>();

    // for...of also visits entries pushed while iterating, so this walks the queue breadth-first.
    for (const current of queue) {
      for (const edge of metafile.inputs[current]?.imports ?? []) {
        const target = edge.external ? (edge.kind === "dynamic-import" ? metafile.outputs[edge.path]?.entryPoint : undefined) : edge.path;
        if (!target || !metafile.inputs[target]) continue;
        const file = resolve(process.cwd(), target);
        if (/\.(?:island|client)\.tsx$/.test(file)) {
          if (nestedFiles.has(file)) continue;
          nestedFiles.add(file);
          const via: string[] = [];
          let parent: string | null | undefined = current;
          while (parent && parent !== root) {
            via.push(resolve(process.cwd(), parent));
            parent = parents.get(parent);
          }
          violations.push({ importer: component.path, nested: file, via: via.reverse() });
          continue;
        }
        if (parents.has(target)) continue;
        parents.set(target, current);
        queue.push(target);
      }
    }
  }

  if (violations.length > 0) {
    const details = violations
      .map(
        ({ importer, nested, via }) =>
          `  ${relative(canonicalCwd, importer)} imports ${relative(canonicalCwd, nested)}${via.length ? ` via ${via.map((file) => relative(canonicalCwd, file)).join(" -> ")}` : ""}`,
      )
      .sort()
      .join("\n");
    throw new Error(
      "[ssr] Island and client modules must not import other island or client modules. Each .island.tsx and .client.tsx file is its own browser entry.\n" +
        details +
        '\nMove the shared component into a plain .tsx module and import that module from both files. Keep the .island.tsx or .client.tsx file as a thin default export, for example `export { default } from "./Inner";`.',
    );
  }
};

const removeStaleBuildAssets = async (outdir: string, outputs: readonly Bun.BuildArtifact[]): Promise<number> => {
  const current = new Set(outputs.map((output) => resolve(output.path)));
  let removed = 0;

  for await (const file of new Glob("*.js*").scan({ cwd: outdir, absolute: true })) {
    const filename = file.slice(file.lastIndexOf("/") + 1);
    if (!GENERATED_ASSET.test(filename) || current.has(resolve(file))) continue;
    await unlink(file);
    removed += 1;
  }

  return removed;
};

/**
 * Workaround for Bun bundler bug: duplicate export statements in shared chunks
 * when splitting=true. We only run this in production because rewriting chunk
 * source in dev can affect evaluation order in cyclic-sensitive modules.
 */
export const dedupeSharedChunkExports = async (outdir: string, verbose: boolean): Promise<number> => {
  let fixedChunks = 0;
  const chunkGlob = new Glob("chunk-*.js");
  for await (const chunkFile of chunkGlob.scan({ cwd: outdir, absolute: true })) {
    const src = await Bun.file(chunkFile).text();
    // Collect all export blocks and deduplicate.
    const exportRegex = /^export\s*\{[^}]*\}\s*;?\s*$/gm;
    const exportBlocks = [...src.matchAll(exportRegex)].map((m) => m[0]);
    if (exportBlocks.length > 1) {
      // Parse all exported names from all blocks.
      const seenNames = new Set<string>();
      const uniqueBlocks: string[] = [];
      for (const block of exportBlocks) {
        const names =
          block
            .match(/\{([^}]*)\}/)?.[1]
            ?.split(",")
            .map((n) => n.trim())
            .filter(Boolean) ?? [];
        const newNames = names.filter((n) => !seenNames.has(n));
        if (newNames.length > 0) {
          uniqueBlocks.push(`export { ${newNames.join(", ")} };`);
          newNames.forEach((n) => seenNames.add(n));
        }
      }
      // Replace all export blocks with deduplicated ones.
      let fixed = src;
      for (const block of exportBlocks) {
        fixed = fixed.replace(block, "");
      }
      // Append single combined export before any debugId comment.
      const debugIdIdx = fixed.lastIndexOf("//# debugId=");
      const combined = uniqueBlocks.join("\n") + "\n";
      if (debugIdIdx !== -1) {
        fixed = fixed.slice(0, debugIdIdx) + combined + fixed.slice(debugIdIdx);
      } else {
        fixed = fixed.trimEnd() + "\n" + combined;
      }
      await Bun.write(chunkFile, fixed);
      fixedChunks += 1;
      if (verbose) console.log(`  Fixed duplicate exports in ${chunkFile.split("/").pop()}`);
    }
  }
  return fixedChunks;
};

/**
 * The content version of the emitted JavaScript and the static import closure
 * of each entry. Dynamic imports stay out, so pages preload only what an entry
 * always loads. A variant's name enters its version, so two variants never
 * share a version directory.
 */
const describeAssetBuild = async (
  outdir: string,
  ids: readonly string[],
  outputs: readonly Bun.BuildArtifact[],
  metafile: Bun.BuildMetafile | undefined,
  variant?: string,
): Promise<AssetBuild> => {
  const hasher = new Bun.CryptoHasher("sha256");
  if (variant) hasher.update(variant).update("\0");
  const files = outputs.map((output) => basename(output.path)).filter((file) => file.endsWith(".js"));
  for (const file of files.sort()) {
    hasher.update(file).update("\0");
    hasher.update(await Bun.file(join(outdir, file)).arrayBuffer()).update("\0");
  }

  const graph = new Map(Object.entries(metafile?.outputs ?? {}).map(([path, output]) => [basename(path), output]));
  const entries: AssetBuild["entries"] = {};
  for (const id of [...ids].sort()) {
    const entry = `${id}.js`;
    const closure = new Set([entry]);
    // for...of also visits files added while iterating.
    for (const current of closure) {
      for (const edge of graph.get(current)?.imports ?? []) {
        const target = basename(edge.path);
        if (edge.kind !== "dynamic-import" && graph.has(target)) closure.add(target);
      }
    }
    closure.delete(entry);
    entries[id] = [entry, ...[...closure].sort()];
  }
  return { version: hasher.digest("hex").slice(0, 16), entries };
};

const writeAssetManifest = async (outdir: string, manifest: AssetManifest): Promise<void> => {
  await mkdir(outdir, { recursive: true });
  await Bun.write(join(outdir, ASSET_MANIFEST), JSON.stringify(manifest));
};

/**
 * Production island builds per variant, for example one per language. The
 * first name is the default build in `outdir`; every other name builds into
 * `outdir/<name>`. `transform` rewrites each browser source module of a
 * variant before the Solid transform.
 */
export type IslandBuildVariants = {
  names: readonly string[];
  transform: (source: string, path: string, variant: string) => string;
};

export const buildIslands = async (options: {
  pattern: string;
  outdir: string;
  cwd: string;
  componentRoots?: readonly string[];
  verbose: boolean;
  dev?: boolean;
  devSourcemap?: DevSourcemap;
  external?: string[];
  errorFallback?: string;
  /** Production only: development builds the default modules once, without `transform`. */
  variants?: IslandBuildVariants;
}): Promise<void> => {
  const { pattern, outdir, cwd, componentRoots, verbose, dev = false, devSourcemap = "linked", external, errorFallback } = options;
  const variants = dev ? undefined : options.variants;
  if (variants) {
    if (!variants.names.length) throw new Error("[ssr] Island variants need at least one name.");
    for (const name of variants.names)
      if (!VARIANT_NAME.test(name))
        throw new Error(`[ssr] Invalid island variant name ${JSON.stringify(name)}; use lowercase letters, digits, and single hyphens.`);
    if (new Set(variants.names).size !== variants.names.length) throw new Error("[ssr] Island variant names must be unique.");
  }
  const resolvedCwd = resolve(cwd);

  const totalStart = performance.now();

  const files = new Set<string>();

  const scanStart = performance.now();
  const visited = new Set<string>();
  const matcher = new Glob(pattern);
  const scan = async (directory: string, scanRoot: string): Promise<void> => {
    const canonical = canonicalFilePath(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(canonical, entry.name);
      const info = entry.isSymbolicLink() ? await stat(path) : entry;
      if (info.isDirectory()) await scan(path, scanRoot);
      else if (info.isFile() && matcher.match(relative(scanRoot, path))) files.add(canonicalFilePath(path));
    }
  };
  for (const root of componentRoots ?? [resolvedCwd]) {
    const scanRoot = canonicalFilePath(resolve(resolvedCwd, root));
    await scan(scanRoot, scanRoot);
  }
  if (verbose) console.log(`Scan: found ${files.size} file(s) in ${fmt(performance.now() - scanStart)}`);

  if (!files.size) {
    if (existsSync(outdir)) await removeStaleBuildAssets(outdir, []);
    if (!dev) await writeAssetManifest(outdir, { version: (await describeAssetBuild(outdir, [], [], undefined)).version, entries: {} });
    if (verbose) console.log("No island/client files found.");
    return;
  }

  // Build component metadata
  const components = [...files].map((componentPath) => {
    const id = islandIdFromFile(componentPath, resolvedCwd);
    const key = toStableKey(componentPath, resolvedCwd);
    const type = getComponentType(componentPath);
    const selector = getSelector(type, id);
    return { path: componentPath, id, key, type, selector };
  });

  // Detect hash collisions and fail fast with actionable diagnostics
  const idMap = new Map<string, typeof components>();
  for (const c of components) {
    if (!idMap.has(c.id)) {
      idMap.set(c.id, []);
    }
    idMap.get(c.id)!.push(c);
  }

  const collisions = [...idMap.entries()].filter(([, items]) => items.length > 1);
  if (collisions.length > 0) {
    const details = collisions
      .map(([id, items]) => {
        const list = items.map((item) => `    - ${item.key} (${relative(canonicalFilePath(resolvedCwd), item.path)})`).join("\n");
        return `  ID ${id}:\n${list}`;
      })
      .join("\n");
    throw new Error(`[ssr] Island ID collision detected. Rename files or adjust roots.\n${details}`);
  }

  // Build all islands together with code splitting
  // This ensures Solid is only bundled once as a shared chunk
  const transformTimings = verbose ? new Map<string, number>() : undefined;
  const bundleStart = performance.now();
  const [defaultName, ...variantNames] = variants?.names ?? [];
  const bundle = async (variantOutdir: string, variant?: string): Promise<{ result: Bun.BuildOutput; asset?: AssetBuild }> => {
    const rewrite = variant && variants ? (source: string, path: string) => variants.transform(source, path, variant) : undefined;
    const result = await Bun.build({
      entrypoints: components.map((c) => c.id),
      outdir: variantOutdir,
      naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
      target: "browser",
      conditions: ["browser", dev ? "development" : "production"],
      external,
      minify: !dev,
      splitting: true,
      metafile: true,
      sourcemap: dev ? devSourcemap : "none",
      plugins: [
        {
          name: "solid-islands",
          setup(build) {
            // Core, DOM and store must use the app's Solid copy and the same mode.
            // Explicit exported entries avoid mixing a production core with
            // development store/web modules from the host process conditions.
            build.onResolve({ filter: /^solid-js(?:\/(?:web|store))?$/ }, (args) => {
              const module = args.path === "solid-js" ? "solid" : args.path.slice("solid-js/".length);
              const entry = `${args.path}/dist/${dev ? "dev" : module}.js`;
              return { path: Bun.resolveSync(entry, resolvedCwd) };
            });

            // Resolve component IDs as virtual entrypoints
            build.onResolve({ filter: new RegExp(`^[a-f0-9]{${ISLAND_ID_LENGTH}}$`) }, (args) => ({
              path: args.path,
              namespace: "island",
            }));

            // Generate hydration code for each component
            build.onLoad({ filter: /.*/, namespace: "island" }, (args) => {
              const component = components.find((c) => c.id === args.path);
              if (!component) {
                return { contents: "", loader: "js" };
              }

              return {
                contents: `import{mount}from${JSON.stringify(join(import.meta.dir, "mount.ts"))};import C from${JSON.stringify(component.path)};${errorFallback ? `import F from${JSON.stringify(errorFallback)};` : ""}mount(C,${JSON.stringify(component.selector)}${errorFallback ? ",F" : ""})`,
                loader: "js",
              };
            });

            // Transform TSX/JSX with Solid DOM mode
            build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => {
              const t0 = performance.now();
              // Import with ? suffix to register file with bun --watch
              // Issue: https://github.com/oven-sh/bun/issues/4689
              const contents = await import(`${path}?`, {
                with: { type: "text" },
              });
              const source: string = contents.default;
              const result = {
                contents: await transform(rewrite ? rewrite(source, path) : source, path, "dom"),
                loader: "js" as const,
              };
              transformTimings?.set(path, performance.now() - t0);
              return result;
            });

            // A variant also rewrites plain modules, including packages; Bun loads them itself otherwise.
            if (rewrite)
              build.onLoad({ filter: /\.(?:[cm]?[jt]s)$/ }, async ({ path }) => ({
                contents: rewrite(await Bun.file(path).text(), path),
                loader: /\.[cm]?ts$/.test(path) ? "ts" : "js",
              }));
          },
        },
      ],
    });

    if (!result.success) return { result };
    rejectNestedComponentImports(result.metafile, components, resolvedCwd);
    const removed = await removeStaleBuildAssets(variantOutdir, result.outputs);
    if (verbose && removed > 0) console.log(`Removed ${removed} stale build asset(s).`);
    if (dev) {
      if (verbose) console.log("Skipped shared-chunk export rewrite in dev mode.");
      return { result };
    }
    await dedupeSharedChunkExports(variantOutdir, verbose);
    const ids = components.map((c) => c.id);
    return {
      result,
      asset: await describeAssetBuild(variantOutdir, ids, result.outputs, result.metafile, variant === defaultName ? undefined : variant),
    };
  };

  // Variants build one after another, which bounds the build's memory and CPU to one bundle at a time.
  let { result, asset } = await bundle(outdir, defaultName);
  if (asset) {
    const manifest: AssetManifest = { ...asset };
    for (const name of variantNames) {
      ({ result, asset } = await bundle(join(outdir, name), name));
      if (!asset) break;
      (manifest.variants ??= {})[name] = asset;
    }
    if (result.success) await writeAssetManifest(outdir, manifest);
  }

  if (verbose) {
    console.log(`Bundle: ${fmt(performance.now() - bundleStart)}`);
    for (const c of components) {
      const rel = relative(resolvedCwd, c.path);
      const t = transformTimings?.get(c.path);
      console.log(`  ${rel} -> ${outdir}/${c.id}.js${t != null ? ` (transform: ${fmt(t)})` : ""}`);
    }
  }
  const variantNote = variantNames.length ? ` in ${variantNames.length + 1} variants` : "";
  console.log(
    `Built ${files.size} component(s)${variantNote} to ${outdir}/ in ${fmt(performance.now() - totalStart)}${verbose ? " (total)" : ""}`,
  );

  if (!result.success) {
    console.error("Build failed:");
    result.logs.forEach((m) => console.error(`  ${m}`));
  }
};
