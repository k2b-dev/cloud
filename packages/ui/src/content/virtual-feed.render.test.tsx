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
  test("renders a sized scrollport, the items at its end in the flow, and a separate log on the server", () => {
    const html = renderToString(() => feed({ class: "activity", busy: true }));

    expect(html).toMatch(/class="k2b-virtual-feed activity"[^>]*data-server=""/);
    expect(html).toMatch(/class="k2b-virtual-feed__viewport"[^>]*tabindex="-1"/);
    expect(html).toContain('role="feed"');
    expect(html).toContain('aria-label="Build activity"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/class="k2b-sr-only"[^>]*role="log"[^>]*aria-live="polite"[^>]*aria-relevant="additions"/);
    // The first picture already shows the items; the browser places the same rows before it paints.
    expect(html.match(/role="article"/g)).toHaveLength(2);
    expect(html).toMatch(/data-key="a"[^>]*data-server=""/);
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html).not.toContain("translateY");
    expect(html).not.toContain("k2b-virtual-feed__end");
    expect(html).not.toContain("k2b-virtual-feed__sticky");
  });

  test("renders on the server only the items at the starting point that fill a screen", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ id: `e${index}`, text: `Entry ${index}` }));
    const keysOf = (html: string) => [...html.matchAll(/data-key="(e\d+)"/g)].map((match) => match[1]);
    // 40 px each, so 1,600 px of estimates are 40 items: the newest at the end, or the first at the start.
    const end = keysOf(renderToString(() => feed({ items: many })));
    expect(end).toHaveLength(40);
    expect(end[0]).toBe("e160");
    expect(end.at(-1)).toBe("e199");
    const start = keysOf(renderToString(() => feed({ items: many, anchor: "start" })));
    expect(start).toHaveLength(40);
    expect(start[0]).toBe("e0");
    expect(start.at(-1)).toBe("e39");
  });

  test("a list that starts at the top renders its separators and its load-more edge on the server", () => {
    const html = renderToString(() =>
      feed({
        anchor: "start",
        stickySeparators: true,
        separator: (entry: Entry, previous: Entry | undefined) => (previous ? undefined : `Group of ${entry.text}`),
        hasMore: true,
        onLoadMore: () => undefined,
      }),
    );
    expect(html).toMatch(/class="k2b-virtual-feed"[^>]*data-anchor="start"/);
    expect(html).toContain("Group of First");
    expect(html.match(/k2b-virtual-feed__separator/g)).toHaveLength(1);
    expect(html).toMatch(/class="k2b-load-more"[^>]*data-state="idle"/);
    expect(html).toContain("Load more");
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("k2b-load-more"));
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
