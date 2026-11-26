/**
 * Measures the browser JS a page's islands weigh: bundles the given island entries together (shared code split into
 * shared chunks, as a page loads them), minified, and prints the bytes of all chunks, plain and gzipped.
 *
 *   bun src/frontend/audit/island-size.ts <island.tsx> [<island.tsx> …]
 */
import { resolve } from "node:path";

const entries = process.argv.slice(2);
if (entries.length === 0 || entries.includes("--help")) {
  console.log(
    "Usage: bun src/frontend/audit/island-size.ts <island.tsx> [<island.tsx> …]\nPrints the minified bytes of the islands' browser bundle.",
  );
  process.exit(entries.length === 0 ? 1 : 0);
}

const ui = resolve(import.meta.dir, "../../../../ui");
const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;

const build = await Bun.build({
  entrypoints: entries.map((entry) => resolve(entry)),
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  conditions: ["browser"],
  plugins: [
    {
      name: "solid-island-size",
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
const texts = await Promise.all(build.outputs.map((output) => output.text()));
const bytes = texts.reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
const gzip = texts.reduce((sum, text) => sum + Bun.gzipSync(new TextEncoder().encode(text)).length, 0);
console.log(JSON.stringify({ entries: entries.length, chunks: build.outputs.length, bytes, gzip }));
