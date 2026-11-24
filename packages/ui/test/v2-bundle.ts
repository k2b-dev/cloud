import { resolve } from "node:path";

/**
 * A bundle of a test entry in `packages/ui/test` with Solid's compiler, for the server (`ssr`, an ES module for Bun)
 * or the browser (`dom`, a script with the development build of Solid, which throws on a hydration mismatch). Both
 * are hydratable.
 */
export const bundleV2Entry = async (entry: string, generate: "ssr" | "dom"): Promise<string> => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, entry)],
    target: generate === "ssr" ? "bun" : "browser",
    format: generate === "ssr" ? "esm" : "iife",
    conditions: generate === "ssr" ? [] : ["browser", "development"],
    plugins: [
      {
        name: "v2-entry",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate, hydratable: true }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, `${entry} bundle failed`);
  return build.outputs[0]!.text();
};
