import { expect, test } from "bun:test";

test("root browser build does not resolve finance peers", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../index.ts", import.meta.url).pathname], target: "browser",
    plugins: [{ name: "reject-finance-peers", setup(build) {
      build.onResolve({ filter: /^(zod|ibantools|saxes|pdf-lib|libxml2-wasm)$/ }, args => {
        throw new Error(`Root import unexpectedly resolves ${args.path}`);
      });
    } }],
  });
  expect(result.success).toBe(true);
});

test("finance browser build cannot resolve WASM or the schema, without bundler exceptions", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../../examples/finance.ts", import.meta.url).pathname, new URL("../../examples/camt.ts", import.meta.url).pathname, new URL("../../examples/einvoice.ts", import.meta.url).pathname, new URL("../../examples/datev-xml.ts", import.meta.url).pathname],
    target: "browser",
    plugins: [{ name: "reject-schema-runtime", setup(build) {
      build.onResolve({ filter: /libxml|(?:camt|sepa|einvoice|datev-xml)-schema|(?:xml-schema|sepa|einvoice|datev-xml)-validator|\/validate$/ }, args => {
        throw new Error(`Serializer unexpectedly resolves ${args.path}`);
      });
    } }],
  });
  expect(result.success).toBe(true);
  const sources = await Promise.all(result.outputs.map(output => output.text()));
  expect(sources.join("")).not.toContain("Technical Valitdation Subset");
  expect(sources.join("")).not.toContain("WebAssembly");
  // DATEV XSD text is never bundled; callers supply the schemas.
  expect(sources.join("")).not.toContain("Kontonummer in der Buchhaltung");
});

test("optional validator browser build includes the pinned schema", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./validate.ts", import.meta.url).pathname],
    target: "browser", splitting: true, external: ["module"],
  });
  expect(result.success).toBe(true);
  const sources = await Promise.all(result.outputs.map(output => output.text()));
  expect(sources.some(source => source.includes("Technical Valitdation Subset"))).toBe(true);
  expect(sources.some(source => source.includes("Kontonummer in der Buchhaltung"))).toBe(false);
});

test("schema integrity failures are structured and cannot return valid XML", async () => {
  const { validatePinnedXml } = await import("./sepa-validator");
  const result = await validatePinnedXml("<Document/>", "0".repeat(64));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.issues[0]?.code).toBe("schema_integrity");
  }
});
