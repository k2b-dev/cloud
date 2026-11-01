import type { BunPlugin } from "bun";

// Consumers in other packages typecheck this file without Babel's declarations, so resolve it from here at runtime.
const babel = async (name: string) => import(Bun.resolveSync(name, import.meta.dir));

/** Compiles Solid JSX for a test: `dom` for a page bundle or DOM test, `ssr` for a server-side import. */
export const solidTestPlugin = (generate: "dom" | "ssr" = "dom"): BunPlugin => ({
  name: `k2b-ui-test-solid-${generate}`,
  setup(build) {
    build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => {
      const [{ transformAsync }, { default: tsPreset }, { default: solidPreset }] = await Promise.all(
        ["@babel/core", "@babel/preset-typescript", "babel-preset-solid"].map(babel),
      );
      const source = await Bun.file(path).text();
      const result = await transformAsync(source, {
        filename: path,
        presets: [
          [tsPreset, {}],
          [solidPreset, { generate, hydratable: false }],
        ],
      });
      if (!result?.code) throw new Error(`Solid ${generate} transform failed: ${path}`);
      return { contents: result.code, loader: "js" };
    });
  },
});
