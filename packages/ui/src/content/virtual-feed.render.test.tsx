import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../styles/css-contract-test-helpers";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-virtual-feed-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { VirtualFeed } = await import("../index");

type Entry = { id: string; text: string };
const items: Entry[] = [
  { id: "a", text: "First" },
  { id: "b", text: "Second" },
];
const feed = (extra: Record<string, unknown> = {}) =>
  createComponent(VirtualFeed<Entry>, {
    items,
    getKey: (entry) => entry.id,
    estimateSize: () => 40,
    label: "Build activity",
    children: (entry) => entry.text,
    ...extra,
  });

describe("VirtualFeed", () => {
  test("renders a sized scrollport with an empty feed and a separate log on the server", () => {
    const html = renderToString(() => feed({ class: "activity", busy: true }));

    expect(html).toContain('class="k2b-virtual-feed activity"');
    expect(html).toMatch(/class="k2b-virtual-feed__viewport"[^>]*tabindex="-1"/);
    expect(html).toContain('role="feed"');
    expect(html).toContain('aria-label="Build activity"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/class="k2b-sr-only"[^>]*role="log"[^>]*aria-live="polite"[^>]*aria-relevant="additions"/);
    // Rows need the browser to measure them, so the server sends the frame only.
    expect(html).not.toContain('role="article"');
    expect(html).not.toContain("First");
    expect(html).not.toContain("k2b-virtual-feed__end");
  });

  test("shows the empty slot only without items", () => {
    expect(renderToString(() => feed({ items: [], empty: "Nothing yet" }))).toContain("Nothing yet");
    expect(renderToString(() => feed({ empty: "Nothing yet" }))).not.toContain("Nothing yet");
  });

  test("leaves the reading position to the feed and positions rows without moving each other", () => {
    const rules = readShippedCssRules(resolve(import.meta.dir, "../styles"));
    const declarations = (selector: string, context = "") => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === context);
      expect(rule, `${context} ${selector}`).toBeDefined();
      return cssDeclarations(rule!.body);
    };

    const viewport = declarations(".k2b-ui .k2b-virtual-feed__viewport");
    expect(viewport.get("overflow-anchor")).toEqual(["none"]);
    expect(viewport.get("overflow-y")).toEqual(["auto"]);
    expect(viewport.get("scrollbar-gutter")).toEqual(["stable"]);
    expect(declarations(".k2b-ui .k2b-virtual-feed__item").get("position")).toEqual(["absolute"]);
    // The highlight tints the row; it never adds a border, outline, or padding that would move content.
    const highlight = declarations(".k2b-ui .k2b-virtual-feed__item[data-highlighted]");
    expect([...highlight.keys()].sort()).toEqual(["background", "transition"]);
    expect(declarations(".k2b-ui .k2b-virtual-feed__item", "@media (prefers-reduced-motion: reduce)").get("transition")).toEqual(["none"]);
  });
});
