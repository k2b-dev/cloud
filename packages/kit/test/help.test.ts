import { expect, test } from "bun:test";
import { kitHelp } from "../src/help";
import { sdkReference } from "../src/sdk";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { kitCapabilities } from "../src/capabilities";

test("localized Help contains every SDK signature from the CLI source", () => {
  for (const locale of ["en", "de"]) {
    const documents = kitHelp.documentsByLocale?.[locale] ?? [];
    expect(documents).toHaveLength(20);
    for (const [name, signature] of sdkReference.methods) {
      const namespace = name.startsWith("ui.modal.") ? "modals" : name === "ui.chart" ? "charts" : name.split(".")[0]!;
      expect(kitHelp.getMarkdown(`kit-sdk-${namespace}`, locale)).toContain(`kit.${signature}`);
    }
    for (const doc of documents) expect(new TextEncoder().encode(doc.markdown).length).toBeLessThan(128 * 1024);
    expect(kitHelp.getMarkdown("kit-assistant", locale)).toContain("read_help");
  }
});
test("Assistant authoring instructions name only declared Kit operations", async () => {
  const source = await Bun.file(new URL("../../cloud/src/ai/kit-skill.ts", import.meta.url)).text();
  compileCapabilityManifest("kit", kitCapabilities);
  const names = new Set([...Object.keys(kitCapabilities.queries), ...Object.keys(kitCapabilities.actions)].map((name) => `kit.${name}`));
  for (const name of source.match(/kit\.(?:app|source)\.[a-z]+/g) ?? []) expect(names.has(name)).toBe(true);
  expect(source).not.toContain("kit.sdk.read");
});

 test("CRUD example fits one Help read and exact SDK headings keep the full method", async () => {
  const { createHelpCatalog, readHelpCatalog } = await import("../../cloud/src/_internal/help-catalog");
  const catalog = createHelpCatalog([{ appId: "kit", appName: "Kit", appIcon: "ti ti-code", manifestHash: "test", documents: kitHelp.documents }]);
  const read = (documentId: string, query?: string) => readHelpCatalog(catalog, { appId: "kit", documentId, query });
  expect(read("kit-crud-example")?.truncated).toBe(false);
  const method = read("kit-sdk-ui", "kit.ui.select")!.markdown;
  expect(method).toContain("No onChange");
  expect(method).toContain("Returns");
  expect(method).toContain("Example");
  expect(method).not.toContain("## kit.ui.table");
});
