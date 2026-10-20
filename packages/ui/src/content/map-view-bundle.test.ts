import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const dist = resolve(import.meta.dir, "../../dist");
describe("MapView bundle boundary", () => {
  test("keeps MapLibre and its .js worker outside both entrypoints' static closures", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "k2b-map-bundle-"));
    try {
      const entries = ["button", "map"].map((name) => resolve(directory, `${name}.ts`));
      const result = await Bun.build({
        entrypoints: entries,
        files: Object.fromEntries(
          entries.map((entry, i) => [
            entry,
            `import { ${i ? "MapView" : "Button"} } from ${JSON.stringify(resolve(dist, "browser/index.js"))}; globalThis.component${i} = ${i ? "MapView" : "Button"};`,
          ]),
        ),
        target: "browser",
        format: "esm",
        splitting: true,
        metafile: true,
        outdir: directory,
      });
      if (!result.success || !result.metafile) throw new AggregateError(result.logs, "Map bundle failed");
      const outputs = result.metafile.outputs;
      const outputAt = (path: string) => Object.keys(outputs).find((key) => key === path || basename(key) === basename(path));
      const closure = (entry: string, dynamic = false): Set<string> => {
        const found = new Set<string>();
        const visit = (path: string) => {
          const key = outputAt(path);
          if (!key || found.has(key)) return;
          found.add(key);
          for (const edge of outputs[key]!.imports) if (dynamic || edge.kind !== "dynamic-import") visit(edge.path);
        };
        visit(entry);
        return found;
      };
      const hasMaplibre = (key: string) => Object.keys(outputs[key]!.inputs).some((input) => input.includes("/maplibre-gl/"));
      const maplibreChunks = Object.keys(outputs).filter(hasMaplibre);
      expect(maplibreChunks.length).toBeGreaterThan(0);
      for (const entry of ["button.js", "map.js"]) {
        expect([...closure(entry)].some(hasMaplibre)).toBe(false);
      }
      const lazy = new Set([...closure("map.js", true)].filter((key) => !closure("map.js").has(key)));
      for (const chunk of maplibreChunks) expect(lazy.has(chunk)).toBe(true);
      const workers = result.outputs.filter((output) => output.kind === "asset" && /map-view-worker.*\.js$/.test(output.path));
      expect(workers).toHaveLength(1);
      const worker = workers[0]!;
      expect(worker.path).not.toEndWith(".mjs");
      const references: string[] = [];
      for (const output of result.outputs.filter((output) => output.kind !== "asset")) {
        if ((await output.text()).includes(basename(worker.path))) references.push(outputAt(output.path)!);
      }
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) expect(lazy.has(reference)).toBe(true);
      expect(readFileSync(resolve(dist, "browser/content/map-view-live.js"), "utf8")).toContain('with { type: "file" }');
      expect(readFileSync(resolve(dist, "licenses/maplibre-gl.txt"), "utf8").length).toBeGreaterThan(100);
      expect(existsSync(resolve(dist, "browser/content/map-view-worker.d.js"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("the server entry can be bundled for a real consumer", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "k2b-map-server-bundle-"));
    try {
      const entry = resolve(directory, "server.ts");
      const result = await Bun.build({
        entrypoints: [entry],
        files: { [entry]: `import { MapView } from ${JSON.stringify(resolve(dist, "ssr/index.js"))}; export { MapView };` },
        target: "bun",
        format: "esm",
        splitting: true,
        outdir: directory,
        metafile: true,
      });
      if (!result.success) throw new AggregateError(result.logs, "Server consumer bundle failed");
      const server = Object.values(result.metafile!.outputs).find(
        (output) => output.entryPoint && basename(output.entryPoint) === basename(entry),
      );
      expect(server).toBeDefined();
      expect(Object.keys(server!.inputs).some((path) => path.includes("/maplibre-gl/"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("no server module statically imports MapLibre", async () => {
    for await (const path of new Bun.Glob("**/*.js").scan({ cwd: resolve(dist, "ssr") })) {
      const source = readFileSync(resolve(dist, "ssr", path), "utf8");
      expect(source).not.toMatch(/from\s+["']maplibre-gl["']/);
    }
  });
  test("the server entry's static module closure never imports MapLibre", () => {
    const seen = new Set<string>();
    const visit = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      const source = readFileSync(path, "utf8");
      const imports = [...source.matchAll(/(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)];
      for (const match of imports) {
        const specifier = match[1]!;
        expect(specifier).not.toBe("maplibre-gl");
        if (specifier.startsWith(".")) {
          const target = resolve(path, "..", specifier);
          visit(
            existsSync(`${target}.js`)
              ? `${target}.js`
              : existsSync(target) && target.endsWith(".js")
                ? target
                : resolve(target, "index.js"),
          );
        }
      }
    };
    visit(resolve(dist, "ssr/index.js"));
    expect([...seen].some((path) => path.endsWith("MapView.js"))).toBe(true);
  });
});
