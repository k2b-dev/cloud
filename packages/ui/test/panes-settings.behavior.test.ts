import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { applyPanesIntent, type PanesLayout } from "../src/layout/panes-layout";
import { createDomTestHarness } from "./dom";

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  right: left + width,
  top,
  bottom: top + height,
  width,
  height,
  toJSON: () => ({}),
});

describe("@k2b/ui Panes and SettingsModal behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps one roving tab stop, active-only content, and separate close chrome", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: { type: "group", items: ["source", "preview"], active: "source" },
    });
    const closed: string[] = [];
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items: [
            { id: "source", title: "Source", icon: "ti ti-code", onClose: () => closed.push("source"), render: () => "Source editor" },
            { id: "preview", title: "Preview", onClose: () => closed.push("preview"), render: () => "Preview content" },
          ],
        }),
      dom.root,
    );

    const tabs = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs()).toHaveLength(2);
    expect(tabs()[0]?.parentElement?.dataset.closable).toBe("true");
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    expect(tabs()[0]?.getAttribute("aria-controls")).toBeTruthy();
    expect(tabs()[1]?.hasAttribute("aria-controls")).toBe(false);
    expect(tabs()[0]?.parentElement?.parentElement?.getAttribute("role")).toBe("tablist");
    expect(dom.root.textContent).toContain("Source editor");
    expect(dom.root.textContent).not.toContain("Preview content");
    const closes = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-panes__close"));
    expect(closes).toHaveLength(2);
    expect(closes.every((close) => close.parentElement?.querySelector('[role="tab"]') !== close)).toBe(true);
    expect(tabs()[0]?.contains(closes[0] ?? null)).toBe(false);
    const previewTab = tabs()[1];
    if (!previewTab) throw new Error("Expected preview tab");
    previewTab.getBoundingClientRect = () => rect(80, 0, 100, 40);

    previewTab.dispatchEvent(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 20,
        pointerId: 2,
        pointerType: "mouse",
        isPrimary: true,
      }) as unknown as Event,
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointermove", {
        clientX: 102,
        clientY: 21,
        pointerId: 2,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    tabs()[1]?.parentElement?.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        bubbles: true,
        clientX: 102,
        clientY: 21,
        pointerId: 2,
        pointerType: "mouse",
        isPrimary: true,
      }) as unknown as Event,
    );
    await Promise.resolve();
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(dom.root.textContent).toContain("Preview content");

    tabs()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await Promise.resolve();
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1]?.hasAttribute("aria-controls")).toBe(false);
    expect(tabs()[0]?.getAttribute("aria-controls")).toBeTruthy();
    expect(dom.root.textContent).toContain("Source editor");
    expect(dom.root.textContent).not.toContain("Preview content");
    tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    tabs()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(closed).toEqual(["preview"]);
    closes[0]?.click();
    expect(closed).toEqual(["preview", "source"]);

    dispose();
    dom.cleanup();
  });

  test("activates a non-movable tab exactly once and clears cancelled pointer presses", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const changes: PanesLayout[] = [];
    const dispose = render(
      () =>
        createComponent(Panes, {
          layout: { version: 2, root: { type: "group", items: ["source", "preview"], active: "source" } },
          onLayoutChange: (next) => changes.push(next),
          movable: false,
          items: [
            { id: "source", title: "Source", render: () => "Source editor" },
            { id: "preview", title: "Preview", render: () => "Preview content" },
          ],
        }),
      dom.root,
    );
    const preview = dom.root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Preview"]');
    if (!preview) throw new Error(dom.root.innerHTML);
    preview.getBoundingClientRect = () => rect(80, 0, 100, 40);
    const pressPreview = (
      preview as HTMLButtonElement & {
        $$pointerdown?: (event: PointerEvent & { currentTarget: HTMLButtonElement }) => void;
        $$click?: (event?: MouseEvent) => void;
      }
    ).$$pointerdown;
    const clickPreview = (preview as HTMLButtonElement & { $$click?: (event?: MouseEvent) => void }).$$click;
    if (!pressPreview || !clickPreview) throw new Error("Expected preview pointer handlers");

    pressPreview({ button: 0, isPrimary: true, pointerId: 3, currentTarget: preview } as PointerEvent & {
      currentTarget: HTMLButtonElement;
    });
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        clientX: 300,
        clientY: 20,
        pointerId: 3,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        clientX: 100,
        clientY: 20,
        pointerId: 3,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    expect(changes).toHaveLength(0);

    pressPreview({ button: 0, isPrimary: true, pointerId: 4, currentTarget: preview } as PointerEvent & {
      currentTarget: HTMLButtonElement;
    });
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointercancel", {
        pointerId: 99,
        pointerType: "touch",
        isPrimary: false,
      }),
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        clientX: 102,
        clientY: 21,
        pointerId: 4,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    clickPreview(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as MouseEvent);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.root).toEqual({ type: "group", items: ["source", "preview"], active: "preview" });

    dispose();
    dom.cleanup();
  });

  test("does not activate an inactive tab once its pointer gesture becomes a drag", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: { type: "group", items: ["source", "preview"], active: "source" },
    });
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items: [
            { id: "source", title: "Source", render: () => "Source editor" },
            { id: "preview", title: "Preview", render: () => "Preview content" },
          ],
        }),
      dom.root,
    );
    const preview = dom.root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Preview"]');
    const surface = preview?.parentElement;
    if (!preview || !surface) throw new Error(dom.root.innerHTML);
    preview.getBoundingClientRect = () => rect(80, 0, 100, 40);
    surface.getBoundingClientRect = () => rect(80, 0, 100, 40);
    const pressPreview = (
      preview as HTMLButtonElement & {
        $$pointerdown?: (event: PointerEvent & { currentTarget: HTMLButtonElement }) => void;
      }
    ).$$pointerdown;
    if (!pressPreview) throw new Error("Expected preview pointer handler");
    dom.document.addEventListener(
      "pointerdown",
      () =>
        pressPreview({ button: 0, isPrimary: true, pointerId: 5, currentTarget: preview } as PointerEvent & {
          currentTarget: HTMLButtonElement;
        }),
      { once: true },
    );
    preview.dispatchEvent(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 20,
        pointerId: 5,
        pointerType: "mouse",
        isPrimary: true,
      }) as unknown as Event,
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointermove", {
        clientX: 120,
        clientY: 20,
        pointerId: 5,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    expect(dom.window.document.body.querySelector('.k2b-panes__drag-preview[aria-hidden="true"]')).not.toBeNull();
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        clientX: 120,
        clientY: 20,
        pointerId: 5,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    expect(layout().root).toEqual({ type: "group", items: ["source", "preview"], active: "source" });

    dispose();
    dom.cleanup();
  });

  test("mounts a persisted nested layout without changing its active contents", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const persisted: PanesLayout = {
      version: 2,
      root: {
        type: "split",
        direction: "horizontal",
        ratio: 0.6,
        first: { type: "group", items: ["source", "preview"], active: "preview" },
        second: { type: "group", items: ["history"], active: "history" },
      },
    };
    const items = [
      { id: "source", title: "Source", render: () => "Source editor" },
      { id: "preview", title: "Preview", render: () => "Preview content" },
      { id: "history", title: "History", render: () => "History content" },
    ];
    const [layout, setLayout] = createSignal(persisted);
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items,
          ariaLabel: "Persisted panes",
        }),
      dom.root,
    );
    expect(dom.root.textContent).toContain("Preview content");
    expect(dom.root.textContent).toContain("History content");
    expect(dom.root.textContent).not.toContain("Source editor");
    const source = dom.root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Source"]');
    const activateSource = (source as (HTMLButtonElement & { $$click?: () => void }) | null)?.$$click;
    expect(typeof activateSource).toBe("function");
    activateSource?.();
    await Promise.resolve();
    const activatedRoot = layout().root;
    expect(activatedRoot?.type).toBe("split");
    if (activatedRoot?.type !== "split" || activatedRoot.first.type !== "group") throw new Error("Expected a split with a first group");
    expect(activatedRoot.first.active).toBe("source");
    expect(dom.root.textContent).toContain("Source editor");
    expect(dom.root.textContent).not.toContain("Preview content");
    dispose();
    dom.cleanup();
  });

  test("overlays a scrollbar without changing the tab-row geometry", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const itemIds = Array.from({ length: 12 }, (_, index) => `item${index}`);
    const [showAdd, setShowAdd] = createSignal(false);
    const dispose = render(
      () =>
        createComponent(Panes, {
          layout: { version: 2, root: { type: "group", items: itemIds, active: itemIds[0]! } },
          onLayoutChange: () => undefined,
          items: itemIds.map((id) => ({ id, title: id, render: () => id })),
          get onAddItem() {
            return showAdd() ? () => undefined : undefined;
          },
        }),
      dom.root,
    );
    const tablist = dom.root.querySelector<HTMLDivElement>(".k2b-panes__tabs");
    if (!tablist) throw new Error(dom.root.innerHTML);
    Object.defineProperties(tablist, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 400 },
      scrollLeft: { configurable: true, writable: true, value: 100 },
    });
    tablist.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    const scrollbar = dom.root.querySelector<HTMLElement>(".k2b-panes__tabs-scrollbar");
    expect(scrollbar?.getAttribute("aria-hidden")).toBe("true");
    expect(scrollbar?.querySelector("span")?.getAttribute("style")).toContain("--k2b-panes-scroll-left: 50px");
    expect(scrollbar?.querySelector("span")?.getAttribute("style")).toContain("--k2b-panes-scroll-width: 100px");
    const initialStyle = scrollbar?.querySelector("span")?.getAttribute("style");
    Object.defineProperty(tablist, "scrollWidth", { configurable: true, value: 600 });
    setShowAdd(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(scrollbar?.querySelector("span")?.getAttribute("style")).not.toBe(initialStyle);
    dispose();
    dom.cleanup();
  });

  test("keeps rounded split-target hit testing inside the clipped element", async () => {
    const dom = createDomTestHarness();
    const { pointerHitsPanesDropTarget } = await import("../src/layout/Panes");
    const element = dom.root.ownerDocument.createElement("div");
    const visibleChild = dom.root.ownerDocument.createElement("span");
    const clippedCorner = dom.root.ownerDocument.createElement("span");
    element.append(visibleChild);
    const entry = {
      containsPointer: true,
      element,
      meta: {
        label: "Add top",
        target: {
          id: "split:top",
          kind: "split" as const,
          targetItemId: "preview",
          side: "top" as const,
          intent: { type: "split" as const, itemId: "source", targetItemId: "preview", side: "top" as const },
        },
      },
      rect: rect(0, 0, 200, 50),
    };
    expect(pointerHitsPanesDropTarget(entry, { x: 100, y: 25 }, visibleChild)).toBe(true);
    expect(pointerHitsPanesDropTarget(entry, { x: 100, y: 25 }, clippedCorner)).toBe(false);
    dom.cleanup();
  });

  test("resizes a persisted split with the complete separator keyboard contract", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "group", items: ["source"], active: "source" },
        second: { type: "group", items: ["preview"], active: "preview" },
      },
    });
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items: [
            { id: "source", title: "Source", render: () => "Source" },
            { id: "preview", title: "Preview", render: () => "Preview" },
          ],
        }),
      dom.root,
    );
    const separator = dom.root.querySelector<HTMLButtonElement>('[role="separator"]');
    if (!separator) throw new Error(dom.root.innerHTML);
    const resizeKeyDown = (separator as HTMLButtonElement & { $$keydown?: (event: KeyboardEvent) => void }).$$keydown;
    expect(typeof resizeKeyDown).toBe("function");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    resizeKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    const resizedRoot = layout().root;
    expect(resizedRoot?.type).toBe("split");
    if (resizedRoot?.type !== "split") throw new Error("Expected a split layout");
    expect(resizedRoot.ratio).toBe(0.52);
    expect(separator.getAttribute("aria-valuenow")).toBe("52");
    resizeKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    await Promise.resolve();
    const shiftedRoot = layout().root;
    expect(shiftedRoot?.type).toBe("split");
    if (shiftedRoot?.type !== "split") throw new Error("Expected a split layout");
    expect(shiftedRoot.ratio).toBe(0.44);
    resizeKeyDown?.(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await Promise.resolve();
    expect(separator.getAttribute("aria-valuenow")).toBe("8");
    resizeKeyDown?.(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await Promise.resolve();
    expect(separator.getAttribute("aria-valuenow")).toBe("92");
    dispose();
    dom.cleanup();
  });

  test("snaps neighboring nested split separators without changing the layout model", async () => {
    const dom = createDomTestHarness();
    const { default: Panes, resolvePanesResizeSnap } = await import("../src/layout/Panes");
    const source = { coordinate: 100, crossStart: 0, crossEnd: 100 };
    const neighbor = { coordinate: 108, crossStart: 116, crossEnd: 216 };
    expect(resolvePanesResizeSnap(104, source, [neighbor])).toEqual({ coordinate: 108, snappedTo: 108 });
    expect(resolvePanesResizeSnap(119, source, [neighbor], { activeCoordinate: 108 })).toEqual({ coordinate: 108, snappedTo: 108 });
    expect(resolvePanesResizeSnap(121, source, [neighbor], { activeCoordinate: 108 })).toEqual({ coordinate: 121, snappedTo: null });
    expect(resolvePanesResizeSnap(104, source, [{ ...neighbor, crossStart: 117, crossEnd: 217 }])).toEqual({
      coordinate: 104,
      snappedTo: null,
    });
    expect(resolvePanesResizeSnap(104, source, [{ ...neighbor, crossStart: 50, crossEnd: 150 }])).toEqual({
      coordinate: 104,
      snappedTo: null,
    });
    expect(resolvePanesResizeSnap(120, source, [neighbor, { ...neighbor, coordinate: 112 }], { previousCoordinate: 100 })).toEqual({
      coordinate: 112,
      snappedTo: 112,
    });

    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: {
          type: "split",
          direction: "vertical",
          ratio: 0.5,
          first: { type: "group", items: ["left-top"], active: "left-top" },
          second: { type: "group", items: ["left-bottom"], active: "left-bottom" },
        },
        second: {
          type: "split",
          direction: "vertical",
          ratio: 0.51,
          first: { type: "group", items: ["right-top"], active: "right-top" },
          second: { type: "group", items: ["right-bottom"], active: "right-bottom" },
        },
      },
    });
    const ids = ["left-top", "left-bottom", "right-top", "right-bottom"];
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items: ids.map((id) => ({ id, title: id, render: () => id })),
        }),
      dom.root,
    );
    const verticalSplits = Array.from(dom.root.querySelectorAll<HTMLElement>('.k2b-panes__split[data-direction="vertical"]'));
    if (verticalSplits.length !== 2) throw new Error(dom.root.innerHTML);
    const leftSeparator = verticalSplits[0]!.querySelector<HTMLElement>(":scope > .k2b-panes__separator");
    const rightSeparator = verticalSplits[1]!.querySelector<HTMLElement>(":scope > .k2b-panes__separator");
    if (!leftSeparator || !rightSeparator) throw new Error("Expected neighboring horizontal separators");
    verticalSplits[0]!.getBoundingClientRect = () => rect(0, 0, 496, 600);
    verticalSplits[1]!.getBoundingClientRect = () => rect(504, 0, 496, 600);
    leftSeparator.getBoundingClientRect = () => rect(0, 296, 496, 8);
    rightSeparator.getBoundingClientRect = () => rect(504, 302, 496, 8);
    const resizeKeyDown = (rightSeparator as HTMLElement & { $$keydown?: (event: KeyboardEvent) => void }).$$keydown;
    expect(typeof resizeKeyDown).toBe("function");
    resizeKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await Promise.resolve();
    const snappedRoot = layout().root;
    if (snappedRoot?.type !== "split" || snappedRoot.second.type !== "split") throw new Error("Expected nested split layout");
    expect(snappedRoot.second.ratio).toBe(0.5);
    resizeKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await Promise.resolve();
    const releasedRoot = layout().root;
    if (releasedRoot?.type !== "split" || releasedRoot.second.type !== "split") throw new Error("Expected nested split layout");
    expect(releasedRoot.second.ratio).toBe(0.52);
    setLayout({ version: 2, root: { ...releasedRoot, second: { ...releasedRoot.second, ratio: 0.51 } } });
    await Promise.resolve();
    const resizePointerDown = (rightSeparator as HTMLElement & { $$pointerdown?: (event: PointerEvent) => void }).$$pointerdown;
    expect(typeof resizePointerDown).toBe("function");
    resizePointerDown?.(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 750,
        clientY: 306,
        pointerId: 9,
        pointerType: "mouse",
        isPrimary: true,
      }) as unknown as PointerEvent,
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointermove", {
        clientX: 750,
        clientY: 305,
        pointerId: 9,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        clientX: 750,
        clientY: 305,
        pointerId: 9,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    const pointerSnappedRoot = layout().root;
    if (pointerSnappedRoot?.type !== "split" || pointerSnappedRoot.second.type !== "split") throw new Error("Expected nested split layout");
    expect(pointerSnappedRoot.second.ratio).toBe(0.5);
    dispose();
    dom.cleanup();
  });

  test("snaps neighboring nested split widths on the same runtime geometry", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "group", items: ["top-left"], active: "top-left" },
          second: { type: "group", items: ["top-right"], active: "top-right" },
        },
        second: {
          type: "split",
          direction: "horizontal",
          ratio: 0.51,
          first: { type: "group", items: ["bottom-left"], active: "bottom-left" },
          second: { type: "group", items: ["bottom-right"], active: "bottom-right" },
        },
      },
    });
    const ids = ["top-left", "top-right", "bottom-left", "bottom-right"];
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items: ids.map((id) => ({ id, title: id, render: () => id })),
        }),
      dom.root,
    );
    const horizontalSplits = Array.from(dom.root.querySelectorAll<HTMLElement>('.k2b-panes__split[data-direction="horizontal"]'));
    if (horizontalSplits.length !== 2) throw new Error(dom.root.innerHTML);
    const topSeparator = horizontalSplits[0]!.querySelector<HTMLElement>(":scope > .k2b-panes__separator");
    const bottomSeparator = horizontalSplits[1]!.querySelector<HTMLElement>(":scope > .k2b-panes__separator");
    if (!topSeparator || !bottomSeparator) throw new Error("Expected neighboring vertical separators");
    horizontalSplits[0]!.getBoundingClientRect = () => rect(0, 0, 1000, 296);
    horizontalSplits[1]!.getBoundingClientRect = () => rect(0, 304, 1000, 296);
    topSeparator.getBoundingClientRect = () => rect(496, 0, 8, 296);
    bottomSeparator.getBoundingClientRect = () => rect(506, 304, 8, 296);
    const resizePointerDown = (bottomSeparator as HTMLElement & { $$pointerdown?: (event: PointerEvent) => void }).$$pointerdown;
    if (!resizePointerDown) throw new Error("Expected pointer resize handler");
    resizePointerDown(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 510,
        clientY: 450,
        pointerId: 10,
        pointerType: "mouse",
        isPrimary: true,
      }) as unknown as PointerEvent,
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointermove", {
        clientX: 505,
        clientY: 450,
        pointerId: 10,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointerup", { pointerId: 10, pointerType: "mouse", isPrimary: true }));
    await Promise.resolve();
    const snappedRoot = layout().root;
    if (snappedRoot?.type !== "split" || snappedRoot.second.type !== "split") throw new Error("Expected nested split layout");
    expect(snappedRoot.second.ratio).toBe(0.5);
    dispose();
    dom.cleanup();
  });

  test("passes group and empty-workspace add targets to the consumer", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: { type: "group", items: ["source"], active: "source" },
    });
    const targets: Array<string | null> = [];
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          onAddItem: (target) => targets.push(target),
          items: [{ id: "source", title: "Source", render: () => "Source" }],
        }),
      dom.root,
    );
    const groupAdd = dom.root.querySelector<HTMLButtonElement>(".k2b-panes__add--tab");
    if (!groupAdd) throw new Error(dom.root.innerHTML);
    const addClick = (groupAdd as HTMLButtonElement & { $$click?: () => void }).$$click;
    expect(typeof addClick).toBe("function");
    addClick?.();
    expect(targets).toEqual(["source"]);
    setLayout({ version: 2, root: null });
    await Promise.resolve();
    const emptyAdd = dom.root.querySelector<HTMLButtonElement>(".k2b-panes__empty .k2b-panes__add");
    const emptyAddClick = (emptyAdd as (HTMLButtonElement & { $$click?: () => void }) | null)?.$$click;
    expect(typeof emptyAddClick).toBe("function");
    emptyAddClick?.();
    expect(targets).toEqual(["source", null]);
    dispose();
    dom.cleanup();
  });

  test("keeps active content mounted across same-group reorder and descriptor rebuilds", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: { type: "group", items: ["one", "two"], active: "one" },
    });
    const [descriptorVersion, setDescriptorVersion] = createSignal(0);
    let renders = 0;
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          get items() {
            descriptorVersion();
            return [
              {
                id: "one",
                title: "One",
                render: () => {
                  renders += 1;
                  return "One";
                },
              },
              { id: "two", title: "Two", render: () => "Two" },
            ];
          },
        }),
      dom.root,
    );
    expect(renders).toBe(1);
    setLayout(applyPanesIntent(layout(), { type: "tab", itemId: "one", targetItemId: "two", beforeItemId: null }));
    setDescriptorVersion(1);
    await Promise.resolve();
    expect(layout().root).toEqual({ type: "group", items: ["two", "one"], active: "one" });
    expect(renders).toBe(1);
    expect(dom.root.textContent).toContain("One");
    dispose();
    dom.cleanup();
  });

  test("shows explicit targets and drops through the advertised group intent", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "group", items: ["source"], active: "source" },
        second: { type: "group", items: ["preview"], active: "preview" },
      },
    });
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items: [
            { id: "source", title: "Source", render: () => "Source" },
            { id: "preview", title: "Preview", render: () => "Preview" },
          ],
        }),
      dom.root,
    );
    const groups = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-panes__group"));
    const tabs = Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (groups.length !== 2 || tabs.length !== 2) throw new Error("Expected two pane groups");
    groups[0]!.getBoundingClientRect = () => rect(0, 0, 300, 180);
    groups[1]!.getBoundingClientRect = () => rect(0, 180, 300, 180);
    tabs[0]!.getBoundingClientRect = () => rect(0, 0, 120, 40);
    tabs[1]!.getBoundingClientRect = () => rect(0, 180, 120, 40);
    const source = tabs[0]!.parentElement;
    if (!source?.matches("[data-dnd-draggable]")) throw new Error("Expected draggable source tab");
    source.getBoundingClientRect = () => rect(0, 0, 120, 40);
    const previewSource = source.querySelector<HTMLElement>("[data-dnd-preview]");
    if (!previewSource) throw new Error("Expected a dedicated tab drag preview");
    previewSource.getBoundingClientRect = () => rect(8, 6, 92, 28);
    previewSource.style.borderRadius = "8px";
    previewSource.style.overflow = "hidden";
    tabs[0]!.dispatchEvent(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
      }) as unknown as Event,
    );
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointermove", {
        clientX: 30,
        clientY: 30,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    const pointerPreview = dom.window.document.body.querySelector(".k2b-panes__drag-preview[aria-hidden='true']") as HTMLElement | null;
    expect(pointerPreview).not.toBeNull();
    expect(pointerPreview).not.toBe(previewSource);
    expect(pointerPreview?.style.width).toBe("92px");
    expect(pointerPreview?.style.height).toBe("28px");
    expect(pointerPreview?.style.borderRadius).toBe("8px");
    expect(pointerPreview?.style.overflow).toBe("hidden");
    const targets = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-panes__drop-target"));
    if (targets.length === 0) throw new Error(dom.root.innerHTML);
    expect(targets.some((target) => target.dataset.kind === "group")).toBe(true);
    expect(targets.some((target) => target.dataset.kind === "split")).toBe(true);
    expect(targets.some((target) => target.dataset.disabled)).toBe(false);
    const groupTarget = groups[1]!.querySelector<HTMLElement>('[data-kind="group"]');
    if (!groupTarget) throw new Error("Expected group target");
    expect(groupTarget.title).toBe("Add to Preview");
    expect(groupTarget.querySelector("i")).not.toBeNull();
    expect(groupTarget.querySelector("span")).toBeNull();
    groupTarget.getBoundingClientRect = () => rect(80, 240, 140, 48);
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointermove", {
        clientX: 120,
        clientY: 260,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    expect(groupTarget.dataset.active).toBe("true");
    dom.window.dispatchEvent(
      new dom.window.PointerEvent("pointerup", {
        clientX: 120,
        clientY: 260,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    await Promise.resolve();
    expect(layout().root).toEqual({ type: "group", items: ["preview", "source"], active: "source" });
    expect(dom.root.querySelector(".k2b-panes__drop-target")).toBeNull();
    expect(dom.window.document.body.querySelector(".k2b-panes__drag-preview[aria-hidden='true']")).toBeNull();
    dispose();
    dom.cleanup();
  });

  test("uses the advertised tab and trapezoid intents for keyboard drops", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const press = (element: HTMLElement, key: string) =>
      element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
    const chooseTarget = async (source: HTMLButtonElement, target: () => HTMLElement | null) => {
      press(source, " ");
      await Promise.resolve();
      const targets = Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-panes__drop-target"));
      targets.forEach((candidate, index) => {
        const verticalEdge = candidate.dataset.zone === "left" || candidate.dataset.zone === "right";
        const horizontalEdge = candidate.dataset.zone === "top" || candidate.dataset.zone === "bottom";
        const width = verticalEdge ? 48 : 120;
        const height = horizontalEdge ? 48 : candidate.dataset.kind === "split" ? 200 : 48;
        candidate.getBoundingClientRect = () => rect(index * 240, index * 240, width, height);
      });
      const wanted = target();
      if (!wanted) throw new Error(dom.root.innerHTML);
      if (wanted.dataset.zone) expect(wanted.title).toMatch(/^Add (top|right|bottom|left) of /);
      press(source, "ArrowLeft");
      await Promise.resolve();
      for (let index = 0; index < targets.length && wanted.dataset.active !== "true"; index += 1) {
        press(source, "ArrowRight");
        await Promise.resolve();
      }
      expect(wanted.dataset.active).toBe("true");
      const liveRegions = dom.window.document.body.querySelectorAll('[role="status"]');
      const liveRegion = liveRegions.item(liveRegions.length - 1);
      await Promise.resolve();
      expect(liveRegion?.textContent).toContain("Move Source to");
      press(source, " ");
      await Promise.resolve();
      expect(liveRegion?.textContent).toContain("Moved Source to");
    };

    const [layout, setLayout] = createSignal<PanesLayout>({
      version: 2,
      root: {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "group", items: ["source"], active: "source" },
        second: { type: "group", items: ["preview"], active: "preview" },
      },
    });
    const items = [
      { id: "source", title: "Source", render: () => "Source" },
      { id: "preview", title: "Preview", render: () => "Preview" },
    ];
    const dispose = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return layout();
          },
          onLayoutChange: setLayout,
          items,
        }),
      dom.root,
    );
    const source = dom.root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Source"]');
    if (!source) throw new Error(dom.root.innerHTML);
    source.parentElement!.getBoundingClientRect = () => rect(0, 0, 120, 40);
    await chooseTarget(
      source,
      () =>
        Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-panes__group"))[1]?.querySelector<HTMLElement>('[data-zone="right"]') ??
        null,
    );
    expect(layout().root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "group", items: ["preview"], active: "preview" },
      second: { type: "group", items: ["source"], active: "source" },
    });
    expect(dom.window.document.activeElement?.getAttribute("aria-label")).toBe("Source");
    dispose();

    const [tabsLayout, setTabsLayout] = createSignal<PanesLayout>({
      version: 2,
      root: { type: "group", items: ["source", "middle", "end"], active: "source" },
    });
    const disposeTabs = render(
      () =>
        createComponent(Panes, {
          get layout() {
            return tabsLayout();
          },
          onLayoutChange: setTabsLayout,
          items: [...items, { id: "middle", title: "Middle", render: () => "Middle" }, { id: "end", title: "End", render: () => "End" }],
        }),
      dom.root,
    );
    const sourceTab = dom.root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Source"]');
    const endTab = dom.root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="End"]');
    if (!sourceTab || !endTab) throw new Error(dom.root.innerHTML);
    sourceTab.parentElement!.getBoundingClientRect = () => rect(0, 0, 120, 40);
    press(sourceTab, " ");
    await Promise.resolve();
    const betweenTabsTarget = dom.root.querySelector<HTMLElement>('[data-kind="tab"][data-placement="tab"]');
    const tabEndTarget = dom.root.querySelector<HTMLElement>('[data-kind="tab"][data-placement="tab-end"]');
    expect(betweenTabsTarget?.querySelector("i")?.classList.contains("ti-spacing-horizontal")).toBe(true);
    expect(tabEndTarget?.querySelector("i")).toBeNull();
    press(sourceTab, "Escape");
    await Promise.resolve();
    await chooseTarget(sourceTab, () => endTab.parentElement?.querySelector<HTMLElement>('[data-placement="tab"]') ?? null);
    expect(tabsLayout().root).toEqual({ type: "group", items: ["middle", "source", "end"], active: "source" });
    disposeTabs();
    dom.cleanup();
  });

  test("keeps settings tab props live and only controls the rendered panel", async () => {
    const dom = createDomTestHarness();
    const { default: SettingsModal } = await import("../src/layout/SettingsModal");
    const [title, setTitle] = createSignal("General");
    const [icon, setIcon] = createSignal("ti ti-settings");
    const dispose = render(() => {
      const tabs = [
        createComponent(SettingsModal.Tab, {
          id: "general",
          get title() {
            return title();
          },
          get icon() {
            return icon();
          },
          children: "General content",
        }),
        createComponent(SettingsModal.Tab, {
          id: "security",
          title: "Security",
          icon: "ti ti-lock",
          children: ["Security content", createComponent(SettingsModal.Footer, { children: "Security save controls" })],
        }),
      ];
      return createComponent(SettingsModal, {
        title: "Application settings",
        get children() {
          return [
            createComponent(SettingsModal.Group, { title: "Workspace", children: tabs[0] }),
            createComponent(SettingsModal.Group, { title: "Restricted", children: tabs[1] }),
          ];
        },
      });
    }, dom.root);
    const tabs = () => Array.from(dom.root.querySelectorAll<HTMLElement>('[role="tab"]'));
    const activeControls = () =>
      tabs()
        .find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.getAttribute("aria-controls");
    expect(tabs()[0]?.getAttribute("aria-controls")).toBeTruthy();
    expect(tabs()[1]?.hasAttribute("aria-controls")).toBe(false);
    setTitle("Workspace");
    setIcon("ti ti-layout");
    expect(tabs()[0]?.textContent).toContain("Workspace");
    tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(dom.document.getElementById(activeControls() ?? "")?.textContent).toContain("Security content");
    expect(dom.root.querySelector(".k2b-settings__footer")?.textContent).toContain("Security save controls");
    dispose();
    dom.cleanup();
  });

  test("moves ordered settings items only in available directions", async () => {
    const dom = createDomTestHarness();
    const { default: SettingsCollection } = await import("../src/layout/SettingsCollection");
    const moves: number[] = [];
    const dispose = render(
      () =>
        createComponent(SettingsCollection, {
          title: "Statuses",
          children: createComponent(SettingsCollection.Item, {
            title: "Open",
            children: createComponent(SettingsCollection.Item.Actions, {
              children: createComponent(SettingsCollection.Item.Reorder, {
                label: "Open",
                index: 0,
                count: 2,
                onMove: (direction) => moves.push(direction),
              }),
            }),
          }),
        }),
      dom.root,
    );
    const up = dom.root.querySelector<HTMLButtonElement>('[aria-label="Move Open up"]');
    const down = dom.root.querySelector<HTMLButtonElement>('[aria-label="Move Open down"]');
    expect(up?.disabled).toBe(true);
    expect(down?.disabled).toBe(false);
    up?.click();
    down?.click();
    expect(moves).toEqual([1]);
    dispose();
    dom.cleanup();
  });
});
