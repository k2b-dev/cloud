import { expect, test } from "bun:test";
import { kitHelp } from "../src/help";
import { sdkReference } from "../src/sdk";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import { kitCapabilities } from "../src/capabilities";

test("localized Help contains every SDK signature from the CLI source", () => {
  for (const locale of ["en", "de"]) {
    const documents = kitHelp.documentsByLocale?.[locale] ?? [];
    expect(documents).toHaveLength(12);
    for (const [name, signature] of sdkReference.methods) {
      const namespace = name.split(".")[0]!;
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
