import { describe, expect, test } from "bun:test";
import {
  activatePanesItem,
  addPanesItem,
  applyPanesIntent,
  createPanesLayout,
  getPanesDropTargets,
  isPanesItemVisible,
  type PanesLayout,
  parsePanesLayout,
  reconcilePanesLayout,
  removePanesItem,
  resizePanesSplit,
  samePanesIntent,
} from "./panes-layout";

const splitLayout = (): PanesLayout => ({
  version: 2,
  root: {
    type: "split",
    direction: "horizontal",
    ratio: 0.6,
    first: { type: "group", items: ["one", "two"], active: "one" },
    second: { type: "group", items: ["three"], active: "three" },
  },
});

describe("Panes layout", () => {
  test("creates strict version 2 groups and an explicit empty layout", () => {
    expect(createPanesLayout(["one", "two"])).toEqual({
      version: 2,
      root: { type: "group", items: ["one", "two"], active: "one" },
    });
    expect(createPanesLayout([])).toEqual({ version: 2, root: null });
    expect(() => createPanesLayout(["same", "same"])).toThrow('duplicate id "same"');
  });

  test("parses only valid v2 layouts without repairing input", () => {
    expect(parsePanesLayout(splitLayout())).toEqual(splitLayout());
    expect(parsePanesLayout({ root: splitLayout().root })).toBeNull();
    expect(parsePanesLayout({ version: 1, root: splitLayout().root })).toBeNull();
    expect(parsePanesLayout({ version: 2, root: { type: "group", items: [], active: "one" } })).toBeNull();
    expect(parsePanesLayout({ version: 2, root: { type: "group", items: ["one", "one"], active: "one" } })).toBeNull();
    expect(parsePanesLayout({ version: 2, root: { type: "group", items: ["one"], active: "two" } })).toBeNull();
  });

  test("activates and queries items while sharing untouched branches", () => {
    const layout = splitLayout();
    const next = activatePanesItem(layout, "two");
    expect(next).not.toBe(layout);
    if (next.root?.type !== "split" || layout.root?.type !== "split") throw new Error("Expected split layouts");
    expect(next.root.second).toBe(layout.root.second);
    expect(isPanesItemVisible(next, "two")).toBe(true);
    expect(isPanesItemVisible(next, "one")).toBe(false);
    expect(activatePanesItem(next, "two")).toBe(next);
    expect(activatePanesItem(next, "missing")).toBe(next);
  });

  test("adds, removes, collapses groups, and supports the empty workspace", () => {
    const empty = createPanesLayout([]);
    const first = addPanesItem(empty, { itemId: "one", targetItemId: null });
    const appended = addPanesItem(first, { itemId: "three", targetItemId: "one" });
    const inserted = addPanesItem(appended, { itemId: "two", targetItemId: "one", beforeItemId: "three" });
    expect(inserted.root).toEqual({ type: "group", items: ["one", "two", "three"], active: "two" });
    expect(removePanesItem(inserted, "two").root).toEqual({ type: "group", items: ["one", "three"], active: "three" });
    expect(removePanesItem(first, "one")).toEqual(empty);
    expect(removePanesItem(splitLayout(), "three").root).toEqual({ type: "group", items: ["one", "two"], active: "one" });
  });

  test("reconciles an explicitly desired open inventory", () => {
    const next = reconcilePanesLayout(splitLayout(), ["two", "four"]);
    expect(next.root).toEqual({ type: "group", items: ["two", "four"], active: "two" });
    expect(reconcilePanesLayout(next, ["two", "four"])).toBe(next);
    expect(reconcilePanesLayout(next, [])).toEqual(createPanesLayout([]));
  });

  test("reorders tabs, moves between groups, and splits exact groups", () => {
    const tabs = createPanesLayout(["one", "two", "three"]);
    expect(applyPanesIntent(tabs, { type: "tab", itemId: "three", targetItemId: "one", beforeItemId: "one" }).root).toEqual({
      type: "group",
      items: ["three", "one", "two"],
      active: "three",
    });
    const moved = applyPanesIntent(splitLayout(), { type: "tab", itemId: "two", targetItemId: "three", beforeItemId: "three" });
    expect(moved.root).toMatchObject({ first: { items: ["one"] }, second: { items: ["two", "three"], active: "two" } });
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const split = applyPanesIntent(splitLayout(), { type: "split", itemId: "two", targetItemId: "three", side });
      expect(split.root?.type).toBe("split");
      expect(isPanesItemVisible(split, "two")).toBe(true);
    }
  });

  test("enumerates direct, deduplicated, capability-filtered targets", () => {
    const targets = getPanesDropTargets(splitLayout(), "one", { movable: true, split: "both" });
    expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
    expect(targets.some((target) => target.kind === "split" && target.targetItemId === "two" && target.side === "right")).toBe(true);
    expect(targets.some((target) => target.kind === "group" && target.targetItemId === "three")).toBe(true);
    for (const target of targets) expect(applyPanesIntent(splitLayout(), target.intent)).not.toEqual(splitLayout());
    const vertical = getPanesDropTargets(splitLayout(), "one", { movable: true, split: "vertical" });
    expect(vertical.filter((target) => target.kind === "split").every((target) => target.side === "top" || target.side === "bottom")).toBe(
      true,
    );
    expect(getPanesDropTargets(splitLayout(), "one", { movable: false, split: "both" })).toEqual([]);
  });

  test("keeps append intents distinct from an item named end", () => {
    const layout = createPanesLayout(["end", "source", "target"]);
    const targets = getPanesDropTargets(layout, "source", { movable: true, split: false });
    const beforeEnd = targets.find((target) => target.beforeItemId === "end")?.intent ?? null;
    const atEnd = targets.find((target) => target.beforeItemId === null)?.intent ?? null;
    expect(beforeEnd).not.toBeNull();
    expect(atEnd).not.toBeNull();
    expect(samePanesIntent(beforeEnd, atEnd)).toBe(false);
    expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
  });

  test("omits split targets that reproduce the current layout", () => {
    const layout: PanesLayout = {
      version: 2,
      root: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "group", items: ["left"], active: "left" },
        second: { type: "group", items: ["right"], active: "right" },
      },
    };
    const intent = { type: "split", itemId: "right", targetItemId: "left", side: "right" } as const;
    expect(applyPanesIntent(layout, intent)).toBe(layout);
    expect(
      getPanesDropTargets(layout, "right", { movable: true, split: "both" }).some((target) => samePanesIntent(target.intent, intent)),
    ).toBe(false);
  });

  test("never creates a layout beyond the strict depth budget", () => {
    const itemIds = Array.from({ length: 16 }, (_, index) => `item${index}`);
    let layout = createPanesLayout(itemIds);
    let targetItemId = "item0";
    let rejected = false;
    for (let index = itemIds.length - 1; index > 0; index -= 1) {
      const intent = { type: "split", itemId: itemIds[index]!, targetItemId, side: "right" } as const;
      const next = applyPanesIntent(layout, intent);
      if (next === layout) {
        rejected = true;
        expect(
          getPanesDropTargets(layout, intent.itemId, { movable: true, split: "both" }).some((target) =>
            samePanesIntent(target.intent, intent),
          ),
        ).toBe(false);
      }
      layout = next;
      expect(parsePanesLayout(layout)).not.toBeNull();
      targetItemId = itemIds[index]!;
    }
    expect(rejected).toBe(true);
  });

  test("resizes a nested split by structural path", () => {
    const nested: PanesLayout = {
      version: 2,
      root: {
        type: "split",
        direction: "vertical",
        ratio: 0.4,
        first: splitLayout().root!,
        second: { type: "group", items: ["four"], active: "four" },
      },
    };
    const resized = resizePanesSplit(nested, ["first"], 0.99);
    expect(resized.root?.type === "split" && resized.root.first.type === "split" && resized.root.first.ratio).toBe(0.92);
    if (resized.root?.type !== "split" || nested.root?.type !== "split") throw new Error("Expected split layouts");
    expect(resized.root.second).toBe(nested.root.second);
    expect(resizePanesSplit(nested, ["second"], 0.5)).toBe(nested);
  });
});
