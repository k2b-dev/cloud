import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guard (#4223 against #4434): the browser fixtures in `packages/ui/test` share one global `Window`, so two fixtures
// that declare the same `__k2…` hook with different types break the ui typecheck (TS2717) only once both are on main.
// A hook such as `__k2Mounted?: boolean` may stand in many fixtures; a name with a meaning of its own (a fixture's
// cases) gets a name of its own, such as `__k2HeadMediaCase`.

const dir = resolve(import.meta.dir, "../../test");

test("every __k2 window hook of the browser fixtures has one type wherever it is declared", () => {
  const types = new Map<string, Map<string, string[]>>();
  for (const file of readdirSync(dir).filter((name) => /\.tsx?$/.test(name))) {
    const source = readFileSync(resolve(dir, file), "utf8");
    for (const block of source.matchAll(/interface Window \{([\s\S]*?)\n\s*\}/g))
      for (const [, name, type] of block[1]!.matchAll(/^\s*(__k2\w+)\??:\s*([^;]+);/gm)) {
        const byType = types.get(name!) ?? new Map<string, string[]>();
        const normal = type!.replace(/\s+/g, " ").trim();
        byType.set(normal, [...(byType.get(normal) ?? []), file]);
        types.set(name!, byType);
      }
  }
  expect(types.size).toBeGreaterThan(5);
  const clashes = [...types].filter(([, byType]) => byType.size > 1).map(([name, byType]) => ({ name, types: Object.fromEntries(byType) }));
  expect(clashes).toEqual([]);
});
