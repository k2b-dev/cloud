import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readShippedCssRules, shippedStyleFiles } from "./css-contract-test-helpers";

const rules = readShippedCssRules(import.meta.dir);
const scopeSelectors = new Set([".k2b-ui", ".k2b-ui.k2b-dark", '.k2b-ui[data-theme="dark"]', ".dark .k2b-ui"]);

describe("@k2b/ui shipped stylesheet ownership", () => {
  test("loads every stylesheet exported by the package entry", () => {
    const files = shippedStyleFiles(import.meta.dir);

    expect(files).toEqual([
      "index.css",
      "feedback-parity.css",
      "layout-parity.css",
      "surfaces-widgets-parity.css",
      "content-parity.css",
      "editors-parity.css",
      "print.css",
    ]);
    for (const file of files)
      expect(
        rules.some((rule) => rule.file === file),
        file,
      ).toBe(true);
  });

  test("declares every exact component selector in one stylesheet per cascade context", () => {
    const owners = new Map<string, Set<string>>();
    for (const rule of rules) {
      if (!rule.selector.includes(".k2b-") || scopeSelectors.has(rule.selector)) continue;
      const key = `${rule.context}||${rule.selector}`;
      owners.set(key, (owners.get(key) ?? new Set()).add(rule.file));
    }

    const shared = [...owners]
      .filter(([, files]) => files.size > 1)
      .map(([selector, files]) => `${selector}: ${[...files].sort().join(", ")}`)
      .sort();

    expect(shared).toEqual([]);
  });

  test("keeps FileView geometry and nested editor fill with their respective owners", () => {
    const content = readFileSync(resolve(import.meta.dir, "content-parity.css"), "utf8");
    const editors = readFileSync(resolve(import.meta.dir, "editors-parity.css"), "utf8");
    const contentSelector = ".k2b-ui .k2b-content-file-view__editor";
    const editorSelector = '.k2b-ui .k2b-markdown-editor[data-fill="true"]';

    expect(content).toContain(contentSelector);
    expect(content).not.toContain(editorSelector);
    expect(content).not.toMatch(/\.k2b-content-file-view__editor\s*>\s*\.k2b-field/);
    expect(editors).toContain(editorSelector);
    expect(editors).not.toContain(contentSelector);
  });
});
