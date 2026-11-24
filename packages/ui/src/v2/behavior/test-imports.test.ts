import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const here = import.meta.dir;
const packageRoot = resolve(here, "../../..");

// A test process compiles no Solid module (`.tsx`) unless a test registers a plugin first; CI runs every browser test
// file in a process of its own. A static import that reaches a `.tsx`, even through a plain `.ts` module, is then
// loaded with Bun's own JSX ("React is not defined" here, "Export named 'jsxDEV' not found" in CI's production
// mode). It only worked where another test in the same process had registered the plugin first (#4053, webkit 6).
// So every test here imports `.tsx` only dynamically, after `registerSsrTestPlugin`, or through a browser bundle.
const staticImports = (source: string): string[] =>
  [...source.matchAll(/^import\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)].map((match) => match[1] ?? "");

const resolveRelative = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")].find(
    (path) => existsSync(path) && /\.tsx?$/.test(path),
  );
};

/** The first `.tsx` a file reaches through static relative imports, with the chain that leads there. */
const firstSolidModule = (file: string, seen = new Set<string>()): string[] | undefined => {
  if (seen.has(file)) return undefined;
  seen.add(file);
  for (const specifier of staticImports(readFileSync(file, "utf8"))) {
    const target = resolveRelative(file, specifier);
    if (!target) continue;
    if (target.endsWith(".tsx")) return [relative(packageRoot, target)];
    const chain = firstSolidModule(target, seen);
    if (chain) return [relative(packageRoot, target), ...chain];
  }
  return undefined;
};

test("no test of the v2 behaviour layer reaches a Solid module through a static import", async () => {
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("*.test.ts").scan({ cwd: here })) {
    const chain = firstSolidModule(resolve(here, path));
    if (chain) offenders.push(`${path} → ${chain.join(" → ")}`);
  }
  expect(offenders).toEqual([]);
});
