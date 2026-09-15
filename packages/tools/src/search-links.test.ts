import { expect, test } from "bun:test";
import { resolveRegistry } from "./frontend/tools/registry";
import { germanToolSearchLabels, toolSearchLinks } from "./search-links";

test("every registered tool contributes its existing route, labels and bilingual search text", () => {
  const english = resolveRegistry("en");
  const german = resolveRegistry("de");
  expect(toolSearchLinks).toHaveLength(english.tools.length);
  expect(new Set(toolSearchLinks.map((link) => link.href)).size).toBe(toolSearchLinks.length);
  for (const tool of english.tools) {
    const link = toolSearchLinks.find((link) => link.href === `/tools/${tool.id}`)!;
    expect(link.label).toBe(tool.name);
    expect(link.keywords.join(" ")).toContain(tool.description.toLowerCase());
    expect(germanToolSearchLabels[link.href]).toBe(german.toolById(tool.id)?.name);
  }
  const qr = toolSearchLinks.find((link) => link.href === "/tools/qr")!;
  expect(qr.keywords.join(" ")).toContain("qr");
});
