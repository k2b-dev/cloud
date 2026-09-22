import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-pull-to-refresh-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { PullToRefresh, ScrollArea } = await import("../index");

describe("PullToRefresh", () => {
  test("renders an idle wrapper with a hidden live indicator around the scroll container", () => {
    const html = renderToString(() =>
      createComponent(PullToRefresh, {
        class: "inbox-refresh",
        onRefresh: async () => {},
        get children() {
          return createComponent(ScrollArea, { children: "Inbox rows" });
        },
      }),
    );

    expect(html).toContain('class="k2b-pull-to-refresh inbox-refresh"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("--k2b-pull-to-refresh-distance:0px");
    expect(html).toContain('class="k2b-pull-to-refresh__indicator" role="status" aria-live="polite"');
    expect(html).toContain('<i class="ti ti-refresh" aria-hidden="true"></i><span class="k2b-sr-only"></span>');
    expect(html).toMatch(/k2b-pull-to-refresh__indicator[\s\S]*k2b-scroll-area[^>]*>Inbox rows/);
  });

  test("moves only the indicator, uses inset elevation, and drops motion under reduced motion", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const wrapper = css.match(/\.k2b-ui \.k2b-pull-to-refresh \{([^}]*)\}/)?.[1] ?? "";
    const indicator = css.match(/\.k2b-ui \.k2b-pull-to-refresh__indicator \{([^}]*)\}/)?.[1] ?? "";
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".k2b-pull-to-refresh__indicator {")));

    expect(wrapper).toContain("position: relative");
    expect(wrapper).toContain("min-height: 0");
    expect(wrapper).not.toContain("overflow");
    expect(wrapper).not.toMatch(/(?:^|\n)\s*height:/);
    expect(indicator).toContain("box-shadow: inset");
    expect(indicator).toContain("pointer-events: none");
    expect(indicator).toContain("transform: translate(-50%, calc(var(--k2b-pull-to-refresh-distance) - 100%))");
    expect(reduced).toContain(".k2b-ui .k2b-pull-to-refresh__indicator {\n    transition: none;");
    expect(reduced).toContain(".k2b-ui .k2b-pull-to-refresh__indicator > i {\n    transform: none;");
  });
});
