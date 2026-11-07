import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chartDatumRoles } from "./index";
import { chartKinds } from "./registry";

test("core entry bundles for server and browser without Solid, DOM or upstream drawing imports", async () => {
  for (const target of ["bun", "browser"] as const) {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "index.ts")],
      target,
      minify: false,
      plugins: [
        {
          name: "no-upstream-drawing",
          setup(builder) {
            builder.onResolve({ filter: /^@k2b\/stdlib(?:\/|$)/ }, ({ path, importer }) => {
              // Calendar arithmetic and message catalogs remain owned by stdlib; SVG helpers must be UI-owned.
              if (importer.endsWith("/content/chart-time-axis.ts") || importer.endsWith("/core/category-labels.ts")) return;
              throw new Error(`Chart core must not load upstream drawing imports: ${path}`);
            });
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]!.text();
    expect(code).not.toMatch(/solid-js|document\.|window\.|HTMLElement|createSignal/);
    expect([...code.matchAll(/\.stdlib-chart-reference \{/g)]).toHaveLength(1);
  }
  expect(Object.keys(chartKinds)).toHaveLength(15);
  expect(chartDatumRoles).toContain("interval");
});
