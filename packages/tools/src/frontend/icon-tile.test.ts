import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "tools-icon-tile-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: ToolCatalog } = await import("./ToolCatalog.island.tsx");

test("catalog quick tools and task rows render shared icon tiles with app ink", () => {
  const html = renderToString(() => createComponent(ToolCatalog, {}));
  const icons = [...html.matchAll(/<span\b[^>]*class="[^"]*\btools-tool-icon\b[^"]*"[^>]*>/g)];
  expect(icons.length).toBeGreaterThan(0);
  expect(html).toContain("group/quick");
  expect(html).toContain("group/tool");
  for (const [icon] of icons) {
    const classes = icon.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
    expect(classes).toContain("k2b-icon-tile");
    expect(classes).toContain("app-accent-text");
    expect(icon).not.toMatch(/\bstyle\s*=/);
  }
  expect(html).not.toMatch(/color-mix\([^;"}]*--app-accent/);
  expect(html).not.toContain("bg-[var(--ui-selected)]");
});

// ShowToolHeader is private to the authenticated route; do not load its services.
test("tool header uses a shared icon tile with app ink and no inline styles", () => {
  const source = readFileSync(new URL("./[tool]/page.tsx", import.meta.url), "utf8");
  const header = source.slice(source.indexOf("const ShowToolHeader ="));
  const icon = header.match(/<div\b([^>]*)>\s*<i class=\{`\$\{props\.icon\}/)?.[1];
  const classes = icon?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
  expect(icon).toBeDefined();
  expect(classes).toContain("k2b-icon-tile");
  expect(classes).toContain("app-accent-text");
  expect(icon).not.toMatch(/\bstyle\s*=/);
  expect(source).not.toMatch(/color-mix\([^;"}]*--app-accent/);
  expect(source).not.toContain("bg-[var(--ui-selected)]");
});

test("catalog icon CSS leaves the chip treatment to shared utilities", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const rule = css.match(/(?:^|\n)\.tools-tool-icon\s*\{([^}]*)\}/)?.[1];
  expect(rule).toBeDefined();
  expect(rule).not.toMatch(/box-shadow|color-mix|border-radius|background/);
  expect(css).not.toMatch(/\.dark\s+\.tools-tool-icon\b[^{}]*\{/);
});
