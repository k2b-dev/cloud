import { resolve } from "node:path";

// Temporary: bytes per source module of one island (unminified, one bundle), to find what makes it heavy.
const ui = resolve(import.meta.dir, "../../../../../ui");
const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
const build = await Bun.build({
  entrypoints: [resolve(process.argv[2]!)],
  target: "browser",
  format: "esm",
  conditions: ["browser"],
  plugins: [
    {
      name: "solid",
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
const text = await build.outputs[0]!.text();
const sizes = new Map<string, number>();
let current = "(start)";
for (const line of text.split("\n")) {
  const mark = line.match(/^\/\/ (\S+)$/);
  if (mark) {
    current = mark[1]!.replace(/^(\.\.\/)+/, "").replace(/node_modules\/\.bun\/[^/]+\/node_modules\//, "nm/");
    continue;
  }
  const group = current.split("/").slice(0, current.startsWith("nm/") ? 3 : 4).join("/");
  sizes.set(group, (sizes.get(group) ?? 0) + line.length + 1);
}
for (const [name, size] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(String(size).padStart(9), name);
