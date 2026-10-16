import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { markdown } from "../../shared";

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

test("Assistant resource links open at the Cloud root and keep the same reference pill", () => {
  const html = markdown.renderSync("[Note](app/notebooks/n1/notes/x) and [Draft](open/mail.draft/~x)");
  const rendered = renderToString(() => createComponent(AssistantMarkdownBlock, { html }));
  const anchors = rendered.match(/<a\b[^>]*>[\s\S]*?<\/a>/g)!;
  expect(anchors).toHaveLength(2);
  const hrefs = anchors.map((anchor) => anchor.match(/\shref="([^"]*)"/)![1]!);
  expect(hrefs.map((href) => new URL(href, "https://cloud.test/app/assistant?conversation=c1").href)).toEqual([
    "https://cloud.test/app/notebooks/n1/notes/x",
    "https://cloud.test/open/mail.draft/~x",
  ]);
  const correct = renderToString(() =>
    createComponent(AssistantMarkdownBlock, { html: markdown.renderSync("[Note](/app/notebooks/n1/notes/x)") }),
  );
  expect(anchors[0]).toBe(correct.match(/<a\b[^>]*>[\s\S]*?<\/a>/)![0]);
});

test("Assistant leaves other Markdown links exactly as rendered", () => {
  const html = markdown.renderSync(
    "[Web](https://example.com/app/x) [Base](/app/grids/base) [Heading](#heading) [Report](report.md) [Docs](docs/app/x) [Relative](./app/x) [Case](App/x) [Legacy](note://abc)",
  );
  const rendered = renderToString(() => createComponent(AssistantMarkdownBlock, { html }));
  expect(rendered).toContain(html);
});
