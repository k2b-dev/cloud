import { expect, test } from "bun:test";
import { basename } from "node:path";

test("the public ImageEditor wrapper defers the heavy view and engine", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../ImageEditor.tsx", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    splitting: true,
    metafile: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "ImageEditor bundle fixture failed");
  if (!build.metafile) throw new Error("ImageEditor bundle fixture needs its dependency graph");
  const outputs = new Map(Object.entries(build.metafile.outputs).map(([path, output]) => [basename(path), output]));
  const initial = new Set<string>();
  const inputs = new Set<string>();
  const visit = (path: string) => {
    const key = basename(path);
    if (initial.has(key)) return;
    const output = outputs.get(key);
    if (!output) throw new Error(`Missing ImageEditor output: ${path}`);
    initial.add(key);
    for (const input of Object.keys(output.inputs)) inputs.add(input);
    for (const imported of output.imports) if (imported.kind !== "dynamic-import") visit(imported.path);
  };
  for (const output of build.outputs) if (output.kind === "entry-point") visit(output.path);
  expect(initial.size).toBeGreaterThan(0);
  for (const file of ["ImageEditorView.tsx", "image.ts", "render.ts", "geometry.ts", "model.ts"]) {
    expect([...inputs].some((input) => input.endsWith(`/image-editor/${file}`))).toBe(false);
    expect(Object.keys(build.metafile.inputs).some((input) => input.endsWith(`/image-editor/${file}`))).toBe(true);
  }
});
