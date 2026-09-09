import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
const root = mkdtempSync(join(tmpdir(), "kit-markdown-policy-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { renderSafeMarkdown } = await import("./MarkdownView");

test("Markdown resource policy suppresses images and limits link navigation without changing defaults", () => {
  const source = "![Receipt](https://example.com/pixel) [FTP](ftp://example.com/file) [Web](https://example.com) <img src=x>";
  const ordinary = renderSafeMarkdown(source);
  expect(ordinary).toContain('<img src="https://example.com/pixel"');
  const isolated = renderSafeMarkdown(source, {
    allowImages: false,
    linkProtocols: ["https:", "http:", "mailto:"],
    linkTarget: "_blank",
  });
  expect(isolated).not.toContain("<img");
  expect(isolated).not.toContain('href="ftp:');
  expect(isolated).toContain("Receipt");
  expect(isolated).toContain('target="_blank" rel="noopener noreferrer"');
  expect(isolated).toContain("&lt;img");
});
