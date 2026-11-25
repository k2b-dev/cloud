import { resolve } from "node:path";

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
let total = 0;
for (const output of build.outputs) {
  const size = output.size;
  if (output.kind !== "asset") total += size;
  console.log(`${String(size).padStart(9)}  ${output.kind}  ${output.path}`);
}
console.log(`${String(total).padStart(9)}  bytes of entries and chunks`);
