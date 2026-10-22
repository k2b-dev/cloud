import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");

async function assertFrameworkFreeGraph(entry: string, extension: ".js" | ".d.ts") {
  if (!existsSync(entry)) throw new Error(`Missing ${entry}; run bun run --cwd packages/ui build before this test`);
  const visited = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await Bun.file(file).text();
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      expect(specifier === "solid-js" || specifier.startsWith("solid-js/")).toBe(false);
      if (!specifier.startsWith(".")) continue;
      const base = resolve(dirname(file), specifier);
      const candidates = [base + extension, resolve(base, `index${extension}`), base];
      const dependency = candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(extension));
      if (!dependency) throw new Error(`Cannot resolve ${specifier} from ${file}`);
      await visit(dependency);
    }
  };
  await visit(entry);
}

describe("framework-free chart inspection entry", () => {
  test("bundles for browsers without Solid and exports inspectChart", async () => {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "chart-inspection.ts")],
      target: "browser",
      external: ["solid-js", "solid-js/*"],
      minify: true,
    });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    const output = await result.outputs[0]!.text();
    expect(output).not.toContain("solid-js");
    expect(output).toMatch(/export\s*\{[^}]*\binspectChart\b/);
  });

  test("keeps the published JavaScript and declaration import graphs free of Solid", async () => {
    await assertFrameworkFreeGraph(resolve(packageRoot, "dist/browser/chart-inspection.js"), ".js");
    await assertFrameworkFreeGraph(resolve(packageRoot, "dist/types/chart-inspection.d.ts"), ".d.ts");
  });
});
