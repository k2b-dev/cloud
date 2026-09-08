import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import tailwind from "bun-plugin-tailwind";

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
] as const) {
  await copyFile(resolve(root, "node_modules", dependency, "LICENSE"), resolve(dist, "licenses", `${name}.txt`));
}

const ignoredSource = (path: string): boolean =>
  /\.(?:test|typecheck)\.[cm]?[jt]sx?$/.test(path) || path.endsWith("styles/css-contract-test-helpers.ts");

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

const compileModules = async (mode: "dom" | "ssr", outputRoot: string): Promise<void> => {
  for (const sourcePath of await sourceFiles(sourceRoot)) {
    const source = await readFile(sourcePath, "utf8");
    const sourceName = relative(sourceRoot, sourcePath);
    const outputPath = resolve(outputRoot, sourceName.replace(/\.[cm]?[jt]sx?$/, ".js"));
    const result = await transformAsync(source, {
      filename: sourcePath,
      sourceFileName: sourceName,
      sourceMaps: true,
      babelrc: false,
      configFile: false,
      presets: [
        [tsPreset, { allowDeclareFields: true }],
        [solidPreset, { generate: mode, hydratable: mode === "dom" }],
      ],
    });
    if (!result?.code || !result.map) {
      throw new Error(`@k2b/ui ${mode} transform failed: ${sourcePath}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${result.code}\n//# sourceMappingURL=${basename(outputPath)}.map\n`);
    await writeFile(`${outputPath}.map`, JSON.stringify(result.map));
  }
};

await compileModules("ssr", resolve(dist, "ssr"));
await compileModules("dom", resolve(dist, "browser"));

const builds = [
  {
    name: "styles",
    entrypoint: resolve(root, "src/styles/entry.css"),
    plugins: [tailwind],
  },
  {
    name: "tabler",
    entrypoint: resolve(root, "src/icons/tabler.css"),
    plugins: [],
  },
  {
    name: "plex",
    entrypoint: resolve(root, "src/fonts/plex.css"),
    plugins: [],
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

await writeFile(resolve(dist, "global.css"), '@import "./styles.css";\n@import "./plex.css";\n@import "./tabler.css";\n');

const tablerPath = resolve(dist, "tabler.css");
const tablerCss = await readFile(tablerPath, "utf8");
const optimizedTablerCss = tablerCss.replace(
  /src:url\(([^)]+\.woff2)\)\s*format\("?woff2"?\),url\([^)]+\)\s*format\("?woff"?\),url\([^)]+\)\s*format\("?truetype"?\)/,
  "src:url($1)format(woff2)",
);
if (optimizedTablerCss === tablerCss) {
  throw new Error("@k2b/ui could not reduce the Tabler preset to WOFF2");
}
await writeFile(tablerPath, optimizedTablerCss);

for (const asset of await readdir(dist)) {
  if ([".woff", ".ttf"].includes(extname(asset))) {
    await rm(resolve(dist, asset));
  }
}

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
