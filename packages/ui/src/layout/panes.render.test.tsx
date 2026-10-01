import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createPanesLayout, getPanesDropTargets, type PanesLayout } from "./panes-layout";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-panes-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Panes, indexPanesDropTargets, pointerHitsPanesDropTarget } = await import("./Panes");

const layout: PanesLayout = {
  version: 2,
  root: {
    type: "split",
    direction: "horizontal",
    ratio: 0.55,
    first: { type: "group", items: ["source", "preview"], active: "source" },
    second: { type: "group", items: ["sample"], active: "sample" },
  },
};

describe("@k2b/ui Panes", () => {
  test("matches the visible 45 degree trapezoid hit areas", () => {
    const entry = (side: "top" | "right" | "bottom" | "left", width: number, height: number) => ({
      containsPointer: true,
      meta: {
        label: `Add ${side}`,
        target: {
          id: `split:${side}`,
          kind: "split" as const,
          targetItemId: "target",
          side,
          intent: { type: "split" as const, itemId: "source", targetItemId: "target", side },
        },
      },
      rect: { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) },
    });
    expect(pointerHitsPanesDropTarget(entry("top", 200, 50), { x: 25, y: 25 })).toBe(true);
    expect(pointerHitsPanesDropTarget(entry("top", 200, 50), { x: 24, y: 25 })).toBe(false);
    expect(pointerHitsPanesDropTarget(entry("left", 50, 200), { x: 25, y: 25 })).toBe(true);
    expect(pointerHitsPanesDropTarget(entry("left", 50, 200), { x: 25, y: 24 })).toBe(false);
    expect(pointerHitsPanesDropTarget(entry("bottom", 200, 50), { x: 25, y: 25 })).toBe(true);
    expect(pointerHitsPanesDropTarget(entry("bottom", 200, 50), { x: 24, y: 25 })).toBe(false);
    expect(pointerHitsPanesDropTarget(entry("right", 50, 200), { x: 25, y: 25 })).toBe(true);
    expect(pointerHitsPanesDropTarget(entry("right", 50, 200), { x: 25, y: 24 })).toBe(false);
  });

  test("indexes large tab-group targets once for direct rendering lookups", () => {
    const itemIds = Array.from({ length: 256 }, (_, index) => `item${index}`);
    const targets = getPanesDropTargets(createPanesLayout(itemIds), "item128", { movable: true, split: false });
    const index = indexPanesDropTargets(targets);
    const group = index.get("item0");
    expect(index.size).toBe(1);
    expect(group?.body).toEqual([]);
    expect(group?.tabs.size).toBe(targets.length);
    for (const target of targets) {
      if (target.kind !== "tab") throw new Error("Expected only tab targets");
      expect(group?.tabs.get(target.beforeItemId ?? null)).toBe(target);
    }
  });

  test("renders nested SSR tabs, separators, and only active factories", () => {
    const calls: string[] = [];
    const html = renderToString(() =>
      createComponent(Panes, {
        layout,
        onLayoutChange: () => undefined,
        ariaLabel: "Template workspace",
        items: [
          { id: "source", title: "Source", render: () => (calls.push("source"), "Source editor") },
          { id: "preview", title: "Preview", render: () => (calls.push("preview"), "Preview content") },
          { id: "sample", title: "Sample", render: () => (calls.push("sample"), "Sample content") },
        ],
      }),
    );
    expect(html).toContain("data-k2b-panes");
    expect(html).toContain('aria-label="Template workspace"');
    expect(html).toContain('role="separator"');
    expect(html.match(/role="tablist"/g)?.length).toBe(2);
    expect(html).toContain("Source editor");
    expect(html).toContain("Sample content");
    expect(html).not.toContain("Preview content");
    expect(calls).toEqual(["source", "sample"]);
  });

  test("renders optional close and add actions", () => {
    const html = renderToString(() =>
      createComponent(Panes, {
        layout: { version: 2, root: { type: "group", items: ["one"], active: "one" } },
        onLayoutChange: () => undefined,
        onAddItem: () => undefined,
        items: [{ id: "one", title: "One", onClose: () => undefined, render: () => "First" }],
      }),
    );
    expect(html).toMatch(/role="tooltip"[^>]*>Close One</);
    expect(html).toMatch(/role="tooltip"[^>]*>Add pane</);
    expect(html).toContain("First");
  });

  test("renders an add action for an empty workspace", () => {
    const html = renderToString(() =>
      createComponent(Panes, {
        layout: { version: 2, root: null },
        onLayoutChange: () => undefined,
        onAddItem: () => undefined,
        items: [],
      }),
    );
    expect(html).toContain("Add pane");
    expect(html).not.toContain('role="tabpanel"');
  });

  test("rejects invalid, duplicate, and missing item definitions", () => {
    const valid: PanesLayout = { version: 2, root: { type: "group", items: ["one"], active: "one" } };
    expect(() =>
      renderToString(() =>
        createComponent(Panes, {
          layout: { ...valid, root: { ...valid.root!, active: "missing" } },
          onLayoutChange: () => undefined,
          items: [],
        }),
      ),
    ).toThrow("valid version 2 layout");
    expect(() =>
      renderToString(() =>
        createComponent(Panes, {
          layout: valid,
          onLayoutChange: () => undefined,
          items: [
            { id: "one", title: "One", render: () => "One" },
            { id: "one", title: "Duplicate", render: () => "Duplicate" },
          ],
        }),
      ),
    ).toThrow('duplicate id "one"');
    expect(() => renderToString(() => createComponent(Panes, { layout: valid, onLayoutChange: () => undefined, items: [] }))).toThrow(
      'missing item "one"',
    );
  });
});
