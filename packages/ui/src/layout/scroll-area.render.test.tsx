import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-scroll-area-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ScrollArea } = await import("../index");

describe("ScrollArea", () => {
  test("renders one native scrollport with optional preserved position", () => {
    const html = renderToString(() =>
      createComponent(ScrollArea, {
        class: "inventory-scroll",
        scrollPreserveKey: "inventory",
        role: "region",
        "aria-label": "Inventory",
        children: "Inventory rows",
      }),
    );

    expect(html).toContain('class="k2b-scroll-area inventory-scroll');
    expect(html).toContain('data-scroll-preserve="inventory"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Inventory"');
    expect(html).toContain("Inventory rows");
  });

  test("reserves a stable gutter without owning the surrounding layout", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const rule = css.match(/\.k2b-ui \.k2b-scroll-area \{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("min-width: 0");
    expect(rule).toContain("min-height: 0");
    expect(rule).toContain("overflow: auto");
    expect(rule).toContain("scrollbar-gutter: stable");
    expect(rule).not.toContain("overscroll-behavior");
    expect(rule).not.toContain("flex:");
    expect(rule).not.toMatch(/(?:^|\n)\s*height:/);
    expect(rule).not.toMatch(/(?:^|\n)\s*padding:/);
  });
});
