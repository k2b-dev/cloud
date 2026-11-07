import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chartDatumRoles } from "./index";
import { chartKinds } from "./registry";

test("core entry bundles for server and browser without Solid or DOM", async () => {
  for (const target of ["bun", "browser"] as const) {
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "index.ts")], target, minify: false });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]!.text();
    expect(code).not.toMatch(/solid-js|document\.|window\.|HTMLElement|createSignal/);
  }
  expect(Object.keys(chartKinds)).toHaveLength(15);
  expect(chartDatumRoles).toContain("interval");
});
