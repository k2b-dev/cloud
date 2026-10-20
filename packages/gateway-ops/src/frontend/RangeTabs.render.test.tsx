import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "gateway-range-tabs-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: RangeTabs } = await import("./RangeTabs");

test("range tabs retain links and expose just the current range as a page", () => {
  const items = ["1h", "6h", "24h", "7d", "30d"].map((id) => ({ id, href: `/admin/gateway/apps?keep=yes&range=${id}` }));
  const html = renderToString(() => createComponent(RangeTabs, { caption: "Window", label: "Traffic window", current: "24h", items }));
  expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>Window<\/span>/);
  expect(html).toMatch(/<nav[^>]*class="k2b-view-tabs[^>]*aria-label="Traffic window"/);
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
  expect(links).toHaveLength(items.length);
  for (const [index, item] of items.entries()) {
    const attrs = links[index]![1]!;
    expect(attrs).toContain(`href="${item.href.replaceAll("&", "&amp;")}"`);
    expect(attrs.includes('aria-current="page"')).toBe(item.id === "24h");
    expect(links[index]![2]).toContain(item.id);
  }
  expect(html).not.toContain('data-variant="primary"');
});
