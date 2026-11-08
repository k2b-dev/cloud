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
              // Calendar arithmetic remains owned by stdlib dates; SVG helpers must be UI-owned.
              if (importer.endsWith("/content/chart-time-axis.ts")) return;
              // The pure catalogue uses only stdlib localization, never its drawing functions.
              if (
                path === "@k2b/stdlib" &&
                (importer.endsWith("/content/chart-message-catalog.ts") || importer.endsWith("/core/chart-messages.ts"))
              )
                return;
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
  expect(Object.keys(chartKinds)).toHaveLength(20);
  expect(chartDatumRoles).toContain("interval");
});

test("the core message catalogue imports only localization from stdlib", async () => {
  const source = await Bun.file(resolve(import.meta.dir, "../../content/chart-message-catalog.ts")).text();
  expect(source.match(/import[^;]+from ["\']@k2b\/stdlib[^;]*;/g)).toEqual(['import { i18n } from "@k2b/stdlib";']);
});

test("pure SVG labels import only localization from stdlib", async () => {
  const source = await Bun.file(resolve(import.meta.dir, "chart-messages.ts")).text();
  expect(source.match(/import[^;]+from ["\']@k2b\/stdlib[^;]*;/g)).toEqual(['import { i18n } from "@k2b/stdlib";']);
});
