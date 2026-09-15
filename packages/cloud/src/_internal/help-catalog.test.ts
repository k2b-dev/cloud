import { describe, expect, test } from "bun:test";
import { helpResourceUri, parseHelpResourceUri, selectHelpMarkdown } from "./help-catalog";

describe("Help excerpts", () => {
  test("round-trips stable Help resource URIs", () => {
    const uri = helpResourceUri("inventory", "getting started");
    expect(uri).toBe("cloud://help/inventory/getting%20started");
    expect(parseHelpResourceUri(uri)).toEqual({ appId: "inventory", documentId: "getting started" });
    expect(parseHelpResourceUri("https://example.com/help")).toBeNull();
  });
});

test("exact headings select complete sections in short and long articles", () => {
  for (const filler of ["Short intro.", "Background. ".repeat(800)]) {
    const markdown = `${filler}\n\n## kit.ui.select {icon="code"}\nSignature\n\n### Example\nExample code\n\n## kit.ui.table {icon="table"}\nOther method`;
    const selected = selectHelpMarkdown(markdown, "kit.ui.select");
    expect(selected?.markdown).toContain("### Example\nExample code");
    expect(selected?.markdown).not.toContain("kit.ui.table");
    expect(selected?.markdown.length).toBeLessThan(7000);
  }
});

test("keeps long relevant excerpts bounded", () => {
  const selected = selectHelpMarkdown("Background. ".repeat(900) + "\n\n## Access\nEditors can update inventory.", "Access");
  expect(selected.markdown).toContain("Editors can update inventory");
  expect(selected.markdown.length).toBeLessThanOrEqual(7000);
  expect(selected.truncated).toBe(true);
});
