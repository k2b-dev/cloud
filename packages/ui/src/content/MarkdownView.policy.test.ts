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


test("empty Markdown table headers are omitted while alignment and emphasis survive", () => {
  const html = renderSafeMarkdown("| | |\n| --- | ---: |\n| Tip | **12,30 €** |\n| Total | **135,30 €** |");
  expect(html).not.toContain("<thead>");
  expect(html).not.toContain("<th>");
  expect(html).toContain('class="k2b-content-markdown__table"');
  expect(html).toContain('<td align="right"><strong>12,30 €</strong>');
  expect(html.match(/<tr>/g)).toHaveLength(2);
});

test("partially filled Markdown headers remain semantic headers", () => {
  const html = renderSafeMarkdown("| Name | |\n| --- | ---: |\n| Item | 1 |");
  expect(html).toContain("<thead>");
  expect(html).toContain("<th>Name</th>");
});
