import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "cloud-markdown-ssr-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { AssistantMarkdownBlock } = await import("./primitives");

test("Markdown renders native links on the server without accessing the DOM", () => {
  const html = '<p>Read <a href="/report.md" target="_blank">Report</a></p>';
  const rendered = renderToString(() => createComponent(AssistantMarkdownBlock, { html }));
  expect(rendered).toContain(html);
  expect(rendered).not.toContain('role="button"');
  expect(rendered).not.toContain("tabindex");
});
