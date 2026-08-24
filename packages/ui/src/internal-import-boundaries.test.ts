import { expect, test } from "bun:test";

test("production modules import sibling families directly instead of through barrels", async () => {
  const violations: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx}");

  for await (const path of glob.scan({ cwd: import.meta.dir })) {
    if (/\.(?:test|typecheck)\.[cm]?[jt]sx?$/.test(path) || path === "index.ts") continue;
    const source = await Bun.file(`${import.meta.dir}/${path}`).text();
    if (/from\s+["']\.\.\/(?:actions|chat|content|feedback|inputs|intl|layout|surfaces|widgets)["']/.test(source)) {
      violations.push(path);
    }
  }

  expect(violations).toEqual([]);
});
