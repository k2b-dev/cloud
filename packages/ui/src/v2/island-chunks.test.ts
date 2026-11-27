import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// An island that uses one v2 export must load the same code whether it is built alone or beside the other islands of
// its app (#4292). Bun assigns a module to chunks per file: a file carries the union of every part any island of the
// build uses, with the imports of those parts. So a light export that shares its file with an export that imports
// heavy behaviour (Notice beside Tabs and its menu) loads that behaviour in every app that also uses the heavy one.
// Each v2 runtime export is one island here, built alone and all together the way an app builds its islands
// (production, code splitting, minified); the difference of their static closures is the coupling.
//
// The four files that mix light and heavy exports (MIXED) are only reported for now: open primitive PRs work in them,
// and each would need an allowlist entry for every export it adds. When a file is split along its heavy imports, the
// move PR removes it from MIXED, and its exports follow the rules below. A file that imports a mixed file directly
// (the filter bar imports the controls) grows with it, so it is only reported too, until that file is split.
//
// Every other export may grow by at most THRESHOLD bytes beside the others, so no new coupling comes in. The
// exports that already grew more when this test came (measured 2026-11-26) are listed by name (KNOWN); how much they
// grow is only reported, since every ordinary change to a module they share moves it. The list only shrinks: a name
// whose export no longer grows, no longer exists, or moved into a mixed file fails until it is removed, and a name
// once removed is strict again.

const v2 = resolve(import.meta.dir, "index.ts");
const THRESHOLD = 2048;
const MIXED = new Set(["./components", "./content", "./controls", "./layout"]);
// exports that already grew beside the others when this test came; only reported
const KNOWN = new Set([
  "Avatar",
  "Button",
  "Chip",
  "confirm",
  "DatePicker",
  "Dialog",
  // #4191 put Disclosure into structure.tsx, beside Group and Section, and its behaviour (useDisclosure, ui-sdk
  // collapsible) into behavior/files.tsx, beside useFilePick (ui-sdk file-input); these three go with #4354.
  "Disclosure",
  "Empty",
  "Failed",
  "Group",
  "Icon",
  "Loading",
  "Lookup",
  "Menu",
  "Popover",
  "Progress",
  "Section",
  // #4353 put Ticks into marks.tsx, the file of the style helper custom that almost every v2 file imports; goes with #4453.
  "Ticks",
  "useLocale",
  "useToast",
]);

const work = await mkdtemp(join(tmpdir(), "k2-v2-island-chunks-"));
afterAll(() => rm(work, { recursive: true, force: true }));

// Solid's DOM transform for every .tsx, done once per file for all builds.
const transformed = new Map<string, string>();
const solid: Bun.BunPlugin = {
  name: "solid-dom",
  setup(build) {
    build.onResolve({ filter: /^solid-js(?:\/(?:web|store))?$/ }, (args) => {
      const module = args.path === "solid-js" ? "solid" : args.path.slice("solid-js/".length);
      return { path: Bun.resolveSync(`${args.path}/dist/${module}.js`, import.meta.dir) };
    });
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      let contents = transformed.get(path);
      if (contents === undefined) {
        const { transformAsync } = await import("@babel/core");
        const typescript = (await import("@babel/preset-typescript")).default;
        const preset = (await import("babel-preset-solid")).default;
        const result = await transformAsync(await Bun.file(path).text(), {
          filename: path,
          babelrc: false,
          configFile: false,
          presets: [typescript, [preset, { generate: "dom", hydratable: true }]],
        });
        if (!result?.code) throw new Error(`Could not transform ${path}`);
        contents = result.code;
        transformed.set(path, contents);
      }
      return { contents, loader: "js" };
    });
  },
};

const build = async (entrypoints: string[], outdir: string) => {
  const result = await Bun.build({
    entrypoints,
    outdir,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    target: "browser",
    conditions: ["browser", "production"],
    minify: true,
    splitting: true,
    metafile: true,
    plugins: [solid],
  });
  if (!result.success || !result.metafile) throw new AggregateError(result.logs, "v2 island build failed");
  return result.metafile;
};

/** The bytes an entry loads before it runs: its file and every file it imports statically. */
const closure = (meta: Bun.BuildMetafile, entry: string) => {
  const byName = new Map(Object.entries(meta.outputs).map(([path, output]) => [path.split("/").pop()!, output]));
  const files = new Set([`${entry}.js`]);
  for (const file of files)
    for (const edge of byName.get(file)?.imports ?? []) if (edge.kind !== "dynamic-import") files.add(edge.path.split("/").pop()!);
  let bytes = 0;
  for (const file of files) bytes += byName.get(file)?.bytes ?? 0;
  return bytes;
};

test("a v2 export's island loads no more beside the other islands of an app than alone", async () => {
  // the runtime exports, as the bundler sees them
  const probe = join(work, "exports.ts");
  await writeFile(probe, `export * from ${JSON.stringify(v2)};\n`);
  const names = (await build([probe], join(work, "exports"))).outputs;
  const exports = Object.values(names).find((output) => output.entryPoint?.endsWith("exports.ts"))?.exports ?? [];
  expect(exports.length).toBeGreaterThan(40);

  // the file each export comes from, as the barrel names it
  const owner = new Map<string, string>();
  for (const [, kind, list, from] of (await Bun.file(v2).text()).matchAll(/export\s*(type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g))
    if (!kind) for (const part of list!.split(",")) if (part.trim() && !part.trim().startsWith("type ")) owner.set(part.trim(), from!);
  // a mixed file, or a file that imports one directly
  const mixedFiles = new Set(MIXED);
  for (const from of new Set(owner.values())) {
    const source = Bun.file(resolve(import.meta.dir, `${from}.tsx`));
    if (!(await source.exists())) continue;
    for (const [, target] of (await source.text()).matchAll(/from\s*"(\.\/[^"]+)"/g)) if (MIXED.has(target!)) mixedFiles.add(from);
  }
  const mixed = (name: string) => mixedFiles.has(owner.get(name) ?? "");

  const islands = exports.map((name) => {
    const file = join(work, `${name}.island.ts`);
    return { name, file };
  });
  for (const { name, file } of islands)
    await writeFile(file, `import { ${name} } from ${JSON.stringify(v2)};\nReflect.set(globalThis, "__k2", ${name});\n`);

  const together = await build(
    islands.map((island) => island.file),
    join(work, "together"),
  );
  const growth: Record<string, number> = {};
  for (const { name, file } of islands) {
    const alone = await build([file], join(work, "alone", name));
    growth[name] = closure(together, `${name}.island`) - closure(alone, `${name}.island`);
  }

  const kib = ([name, bytes]: [string, number]) => `${name} +${Math.ceil(bytes / 1024)}`;
  const grown = Object.entries(growth).filter(([, bytes]) => bytes > THRESHOLD);
  const reportMixed = grown.filter(([name]) => mixed(name)).map(kib);
  if (reportMixed.length) console.info(`v2 exports of mixed files that grow beside the others (KiB): ${reportMixed.join(", ")}`);
  const reportKnown = grown.filter(([name]) => !mixed(name) && KNOWN.has(name)).map(kib);
  if (reportKnown.length) console.info(`v2 exports known to grow beside the others (KiB): ${reportKnown.join(", ")}`);
  // a new coupling: an export outside the mixed files and not known that grows beside the others
  const over = grown
    .filter(([name]) => !mixed(name) && !KNOWN.has(name))
    .map(([name, bytes]) => `${name}: +${(bytes / 1024).toFixed(1)} KiB beside the others (at most ${THRESHOLD / 1024} KiB)`);
  // a known name whose coupling is gone, whose export is gone, or whose export lives in a mixed file, must go
  const loose = [...KNOWN]
    .filter((name) => mixed(name) || (growth[name] ?? 0) <= THRESHOLD)
    .map(
      (name) =>
        `${name}: no longer known to grow (${mixed(name) ? "a mixed file, only reported" : "it does not grow beside the others"}); remove it`,
    );
  expect(over).toEqual([]);
  expect(loose).toEqual([]);
}, 240_000);
