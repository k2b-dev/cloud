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
// The allowlist holds the coupling measured on 2026-11-26 (d4f6ceee6f) in KiB with about 10 % headroom, so ordinary
// work on a coupled file does not touch it. It only shrinks: split a file along its heavy imports, and the entries of
// the exports that no longer grow must go (the test says which). Every export not listed may grow by at most
// THRESHOLD bytes, so no new coupling comes in.

const v2 = resolve(import.meta.dir, "index.ts");
const THRESHOLD = 2048;
// export → most KiB its island may grow beside the others
const coupled: Record<string, number> = {
  Avatar: 24,
  Band: 485,
  Bar: 485,
  Button: 17,
  Canvas: 485,
  Cells: 486,
  Check: 380,
  Chip: 10,
  Choice: 379,
  confirm: 98,
  DateInput: 148,
  DatePicker: 22,
  Dialog: 98,
  Digest: 523,
  Empty: 19,
  Facts: 458,
  Failed: 13,
  Field: 382,
  FilterBar: 108,
  Group: 18,
  Icon: 30,
  Inline: 483,
  Input: 373,
  List: 481,
  ListOrder: 350,
  Loading: 29,
  Lookup: 28,
  Menu: 27,
  Nav: 362,
  Notice: 521,
  Pane: 486,
  Path: 538,
  Popover: 68,
  Progress: 25,
  Prose: 405,
  RecordHead: 522,
  Row: 459,
  Section: 18,
  Select: 212,
  StatusRow: 510,
  Steps: 538,
  Table: 428,
  Tabs: 365,
  Text: 477,
  Tiles: 485,
  useLocale: 20,
  useToast: 56,
  viewIcon: 533,
  Workspace: 291,
};

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

  const over = Object.entries(growth)
    .filter(([name, bytes]) => bytes > (coupled[name] === undefined ? THRESHOLD : coupled[name] * 1024))
    .map(
      ([name, bytes]) => `${name}: +${(bytes / 1024).toFixed(1)} KiB beside the others (allowed ${coupled[name] ?? THRESHOLD / 1024} KiB)`,
    );
  // an entry whose coupling is gone, or whose export is gone, must go
  const loose = Object.keys(coupled)
    .filter((name) => (growth[name] ?? 0) <= THRESHOLD)
    .map((name) => `${name}: no longer grows beside the others; remove its entry`);
  if (process.env.K2_ISLAND_CHUNKS_REPORT)
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(growth)
            .filter(([, bytes]) => bytes > THRESHOLD)
            .map(([name, bytes]) => [name, Math.ceil(bytes / 1024)]),
        ),
      ),
    );
  expect(over).toEqual([]);
  expect(loose).toEqual([]);
}, 240_000);
