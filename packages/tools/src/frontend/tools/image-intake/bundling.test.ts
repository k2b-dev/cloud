import { expect, test } from "bun:test";

test("Bun splitting keeps libheif out of the intake entry and shared eager chunks", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./intake.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    splitting: true,
    conditions: ["browser"],
    minify: true,
  });
  expect(result.success).toBe(true);
  const outputs = await Promise.all(
    result.outputs.map(async (output) => ({ kind: output.kind, path: output.path, text: await output.text() })),
  );
  const entry = outputs.find((output) => output.kind === "entry-point");
  expect(entry).toBeDefined();
  expect(entry?.text).not.toContain("wasmBinary");
  expect(entry?.text).not.toContain("libheif");
  const decoder = outputs.filter((output) => output.text.includes("wasmBinary"));
  expect(decoder).toHaveLength(1);
  expect(decoder[0]!.kind).toBe("chunk");
  expect(decoder[0]!.text.length).toBeGreaterThan(1_000_000);
  // All other chunks can be eager imports; none carries the decoder's wasm.
  for (const output of outputs.filter((output) => output !== decoder[0])) expect(output.text.length).toBeLessThan(100_000);
});
