import { dirname, join, normalize, resolve } from "node:path";

/**
 * The browser JavaScript a page's islands cost: builds the given island entries together (minified, shared code split
 * out once, as the page loads it) and prints the bytes of every output and the total. Evidence for the UI v2 migration.
 *
 *   bun src/frontend/users/detail/island-size.ts <island.tsx>…
 */
if (process.argv.includes("--help") || process.argv.length < 3) {
  console.log("Usage: bun island-size.ts <island entry>… — minified, split browser build; prints bytes per output and total.");
  process.exit(0);
}
const ui = resolve(import.meta.dir, "../../../../../ui");
const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
const build = await Bun.build({
  entrypoints: process.argv.slice(2).map((entry) => resolve(entry)),
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  conditions: ["browser"],
  plugins: [
    {
      name: "solid-islands",
      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "dom", hydratable: true }]],
          });
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Island build failed");
// Assets (such as viewer workers) load only when a feature asks for them; the page itself loads entries and chunks.
// What loads with the page: the entries and every chunk they import statically, on and on; `import()` loads later.
const texts = new Map<string, { size: number; text: string }>();
for (const output of build.outputs)
  if (output.kind !== "asset") texts.set(normalize(output.path), { size: output.size, text: await output.text() });
const initial = new Set<string>();
const visit = (path: string) => {
  if (initial.has(path) || !texts.has(path)) return;
  initial.add(path);
  for (const match of texts.get(path)!.text.matchAll(/(?:^|[;}\s])import\s*(?:[^("';]*?from\s*)?["'](\.{1,2}\/[^"']+)["']/g))
    visit(normalize(join(dirname(path), match[1]!)));
};
for (const output of build.outputs) if (output.kind === "entry-point") visit(normalize(output.path));
let total = 0;
let first = 0;
for (const [path, output] of texts) {
  total += output.size;
  if (initial.has(path)) first += output.size;
  console.log(`${String(output.size).padStart(9)}  ${initial.has(path) ? "initial" : "lazy   "}  ${path}`);
}
console.log(`${String(first).padStart(9)}  bytes loaded with the page (entries and their static chunks)`);
console.log(`${String(total).padStart(9)}  bytes of entries and chunks, lazy ones included`);
