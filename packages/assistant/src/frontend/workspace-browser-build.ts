const ui = new URL("../../../ui/", import.meta.url).pathname;
const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
const entry = process.argv[2];
if (!entry) throw new Error("A browser test entrypoint is required");
const build = await Bun.build({
  entrypoints: [new URL(entry, import.meta.url).pathname],
  target: "browser",
  format: "esm",
  plugins: [
    {
      name: "solid-workspace-test",
      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
          });
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!build.success) throw new Error(build.logs.join("\n"));
process.stdout.write(await build.outputs[0]!.text());
