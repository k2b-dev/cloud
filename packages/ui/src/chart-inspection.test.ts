import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chartMessages } from "./content/chart-message-catalog";

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
      expect(specifier === "solid-js" || specifier.startsWith("solid-js/"), `${file} imports ${specifier}`).toBe(false);
      expect(specifier.includes("chart-message-catalog"), `${file} imports a UI message catalogue`).toBe(false);
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
  test("resolves area labels without the Solid locale hook", () => {
    expect(chartMessages.resolve(["de"]).t.chartFields({ key: "areaTotal" })).toBe("Zusammen");
    expect(chartMessages.resolve(["de"]).t.chartFields({ key: "total" })).toBe("Gesamt");
    expect(chartMessages.resolve(["en"]).t.chartFields({ key: "areaTotal" })).toBe("Total");
  });

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
    const build = await Bun.build({
      entrypoints: ["chart-inspection-budget"],
      // Match the packed consumer's single public export without installing another dependency tree.
      plugins: [
        {
          name: "chart-inspection-budget",
          setup(builder) {
            builder.onResolve({ filter: /^chart-inspection-budget$/ }, () => ({ path: "entry", namespace: "inspection-budget" }));
            builder.onLoad({ filter: /.*/, namespace: "inspection-budget" }, () => ({
              contents: `export { inspectChart } from ${JSON.stringify(resolve(packageRoot, "dist/browser/chart-inspection.js"))};`,
              loader: "ts",
            }));
          },
        },
      ],
      target: "browser",
      external: ["solid-js", "solid-js/*"],
      minify: true,
    });
    expect(build.success).toBe(true);
    const output = await build.outputs[0]!.text();
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(17_000);
    await assertFrameworkFreeGraph(resolve(packageRoot, "dist/browser/chart-inspection.js"), ".js");
    await assertFrameworkFreeGraph(resolve(packageRoot, "dist/types/chart-inspection.d.ts"), ".d.ts");
  });
});
