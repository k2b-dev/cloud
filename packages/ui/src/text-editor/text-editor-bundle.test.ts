import { expect, test } from "bun:test";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";

test("initial editor engine with Yjs and awareness stays within the 140 KiB concept budget", async () => {
  // Same boundary as the approved spike: formatted/source engine, commands,
  // cell widgets, paste, Yjs and awareness. Solid controls are measured separately.
  // Match the application's split browser build. Only HTML paste loads the
  // sanitizer; its real delayed-load behavior has a separate browser regression.
  const build = await Bun.build({
    entrypoints: [new URL("../../test/text-editor-engine.fixture.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser", "production"],
    format: "esm",
    minify: true,
    splitting: true,
    metafile: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "Editor budget fixture did not build");
  if (!build.metafile) throw new Error("Editor budget build is missing its dependency graph");
  const initial = new Set<string>();
  const outputs = new Map(Object.entries(build.metafile.outputs).map(([path, output]) => [basename(path), output]));
  if (outputs.size !== Object.keys(build.metafile.outputs).length) {
    throw new Error("Ambiguous editor output names");
  }
  // Every dependency, including deferred chunks, must be part of this build.
  // Bun's typed metafile does not expose an `external` flag on output imports.
  for (const output of outputs.values()) {
    for (const imported of output.imports) {
      if (!outputs.has(basename(imported.path))) throw new Error(`Unmeasured editor dependency: ${imported.path}`);
    }
  }
  const visit = (path: string) => {
    const key = basename(path);
    if (initial.has(key)) return;
    const output = outputs.get(key);
    if (!output) throw new Error(`Missing editor output: ${path}`);
    initial.add(key);
    for (const imported of output.imports) {
      if (imported.kind !== "dynamic-import") visit(imported.path);
    }
  };
  for (const output of build.outputs) if (output.kind === "entry-point") visit(output.path);
  let eagerBytes = 0,
    deferredBytes = 0;
  for (const output of build.outputs) {
    const bytes = gzipSync(await output.arrayBuffer(), { level: 9 }).length;
    if (initial.has(basename(output.path))) eagerBytes += bytes;
    else deferredBytes += bytes;
  }
  console.info(`Editor gzip: initial=${eagerBytes}, deferred=${deferredBytes}, total=${eagerBytes + deferredBytes}`);
  expect(initial.size).toBeGreaterThan(0);
  expect(deferredBytes).toBeGreaterThan(0);
  expect(eagerBytes).toBeLessThanOrEqual(140 * 1024);
});
