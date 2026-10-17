// Shared by the two browser suites; no running Cloud stack is needed.
export const uiRoot = new URL("../../../../../ui/", import.meta.url).pathname;
export async function buildHarness(entrypoint: URL): Promise<string> {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", uiRoot));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", uiRoot))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", uiRoot))).default;
  const build = await Bun.build({
    entrypoints: [entrypoint.pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-image-intake-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Image intake harness build failed");
  return build.outputs[0]!.text();
}
