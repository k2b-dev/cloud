import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { type PresetItem, transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import tailwind from "bun-plugin-tailwind";
import { buildPlexFonts } from "./plex-fonts";
import { buildTablerPreset } from "./tabler-fonts";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const buildComplete = resolve(dist, ".build-complete");
const sourceRoot = resolve(root, "src");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(resolve(dist, "licenses"));
for (const [dependency, name] of [
  ["@fontsource/ibm-plex-sans", "ibm-plex-sans"],
  ["@fontsource/ibm-plex-mono", "ibm-plex-mono"],
  ["@tabler/icons-webfont", "tabler-icons"],
  ["emojibase-data", "emojibase-data"],
] as const) {
  await copyFile(resolve(root, "node_modules", dependency, "LICENSE"), resolve(dist, "licenses", `${name}.txt`));
}

const ignoredSource = (path: string): boolean =>
  /\.(?:test|typecheck)\.[cm]?[jt]sx?$/.test(path) ||
  path.endsWith("styles/css-contract-test-helpers.ts") ||
  path.endsWith("charts/parity.ts") ||
  path.endsWith(".d.ts");

const sourceFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !ignoredSource(path)) files.push(path);
  }
  return files;
};

const typescript: PresetItem = [tsPreset, {}];

const compileModules = async (mode: "dom" | "ssr", outputRoot: string): Promise<void> => {
  for (const sourcePath of await sourceFiles(sourceRoot)) {
    const source = await readFile(sourcePath, "utf8");
    const sourceName = relative(sourceRoot, sourcePath);
    const outputPath = resolve(outputRoot, sourceName.replace(/\.[cm]?[jt]sx?$/, ".js"));
    // onMount never runs on the server. Keep its lazy browser engine out of the SSR module graph,
    // including when a consumer bundles the server entry and resolves every dynamic import.
    if (mode === "ssr" && sourceName === "content/map-view-live.ts") {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, 'export function createMap() { throw new Error("MapView live rendering requires a browser"); }\n');
      continue;
    }
    // The PDF engine is no module of the package graph: it is bundled on its own below and loaded by address.
    if (sourceName === "content/pdf-engine.ts") continue;
    const result = await transformAsync(source, {
      filename: sourcePath,
      sourceFileName: sourceName,
      sourceMaps: true,
      babelrc: false,
      configFile: false,
      // Babel 8 parses every file with the JSX syntax Solid enables, so plain TypeScript skips it.
      presets: /\.[jt]sx$/.test(sourcePath) ? [typescript, [solidPreset, { generate: mode, hydratable: mode === "dom" }]] : [typescript],
    });
    if (!result?.code || !result.map) {
      throw new Error(`@k2b/ui ${mode} transform failed: ${sourcePath}`);
    }
    let code = result.code;
    // MapLibre ships its worker as .mjs, which @k2b/ssr does not serve; the browser build uses the .js copy below.
    if (mode === "dom" && sourceName === "content/map-view-live.ts") {
      const worker = '"maplibre-gl/dist/maplibre-gl-worker.mjs"';
      if (!code.includes(worker)) throw new Error("@k2b/ui could not find the MapLibre worker import in map-view-live");
      code = code.replace(worker, '"./map-view-worker.js"');
    }
    // The PDF loader imports the engine and the pdf.js worker as files. The browser build points them at the bundled
    // engine and the .js worker copy below, which a host's bundler copies next to its chunks. On the server nothing
    // opens a document, so both addresses stay empty there.
    if (sourceName === "content/pdf-document.ts") {
      for (const [specifier, browserFile] of [
        ["./pdf-engine.ts", "./pdf-viewer-engine.js"],
        ["pdfjs-dist/legacy/build/pdf.worker.min.mjs", "./pdf-viewer-worker.js"],
      ] as const) {
        const fileImport = new RegExp(
          `import (\\w+) from "${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}" with \\{\\s*type: "file"\\s*\\};`,
        );
        const match = code.match(fileImport);
        if (!match) throw new Error(`@k2b/ui could not find the file import of ${specifier} in pdf-document`);
        code = code.replace(
          match[0],
          mode === "dom" ? `import ${match[1]} from "${browserFile}" with { type: "file" };` : `const ${match[1]} = "";`,
        );
      }
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${code}\n//# sourceMappingURL=${basename(outputPath)}.map\n`);
    await writeFile(`${outputPath}.map`, JSON.stringify(result.map));
  }
};

await compileModules("ssr", resolve(dist, "ssr"));
await compileModules("dom", resolve(dist, "browser"));

await copyFile(resolve(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"), resolve(dist, "browser/content/map-view-worker.js"));
await copyFile(resolve(root, "node_modules/maplibre-gl/LICENSE.txt"), resolve(dist, "licenses/maplibre-gl.txt"));
await copyFile(
  resolve(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  resolve(dist, "browser/content/pdf-viewer-worker.js"),
);
await copyFile(resolve(root, "node_modules/pdfjs-dist/LICENSE"), resolve(dist, "licenses/pdfjs-dist.txt"));
// pdf.js and its glue as one self-contained module. Hosts load it by address, so it never enters their bundles,
// not even a classic script that could not parse pdf.js's module syntax.
const engine = await Bun.build({
  entrypoints: [resolve(sourceRoot, "content/pdf-engine.ts")],
  outdir: resolve(dist, "browser/content"),
  naming: { entry: "pdf-viewer-engine.js" },
  target: "browser",
  format: "esm",
  minify: true,
});
if (!engine.success) throw new AggregateError(engine.logs, "@k2b/ui could not bundle the PDF engine");

const builds = [
  {
    name: "styles",
    entrypoint: resolve(root, "src/styles/entry.css"),
    plugins: [tailwind],
  },
] as const;

for (const build of builds) {
  const result = await Bun.build({
    entrypoints: [build.entrypoint],
    outdir: dist,
    naming: `${build.name}.css`,
    minify: true,
    plugins: [...build.plugins],
  });

  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error(`@k2b/ui ${build.name} stylesheet build failed`);
  }
}

await buildPlexFonts(dist);
await buildTablerPreset(dist);

// The classless page stylesheet ships as written: it targets current engines and stays readable.
await copyFile(resolve(root, "src/base/base.css"), resolve(dist, "base.css"));

await writeFile(resolve(dist, "global.css"), '@import "./styles.css";\n@import "./plex.css";\n@import "./tabler.css";\n');

await writeFile(buildComplete, "");

const declarations = Bun.spawnSync({
  cmd: [resolve(root, "node_modules/.bin/tsc"), "-p", resolve(root, "tsconfig.build.json"), "--pretty", "false"],
  stdout: "inherit",
  stderr: "inherit",
});
if (declarations.exitCode !== 0) {
  throw new Error("@k2b/ui declaration build failed");
}

console.log("Built modular @k2b/ui browser/SSR JavaScript, declarations, styles, and optional presets");
