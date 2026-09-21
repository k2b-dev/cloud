import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { installAppWorkspaceController } from "./app-workspace-controller";
import { APP_WORKSPACE_SIDEBAR_COLLAPSED } from "./app-workspace-state";

type Frame = (time: number) => void;
type Rect = { height: number; width: number };

let window: HappyWindow;
let frames: Map<number, Frame>;
let frameId = 0;
let resizeObservers: TestResizeObserver[];
const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const globalKeys = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const setRect = (element: Element, rect: Rect) => {
  setDynamicRect(element, () => rect);
};

const setDynamicRect = (element: Element, readRect: () => Rect) => {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const rect = readRect();
      return {
        bottom: rect.height,
        height: rect.height,
        left: 0,
        right: rect.width,
        toJSON: () => ({}),
        top: 0,
        width: rect.width,
        x: 0,
        y: 0,
      };
    },
  });
};

const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
};

const workspace = (
  options: { collapsible?: boolean; height?: number; resizable?: boolean; sidebarWidth?: number; width?: number } = {},
) => {
  const root = document.createElement("div");
  root.dataset.k2bAppWorkspace = "";
  root.dataset.workspaceResizable = options.resizable === false ? "false" : "true";
  setRect(root, { height: options.height ?? 700, width: options.width ?? 1000 });

  const sidebar = document.createElement("aside");
  sidebar.className = "k2b-app-workspace__sidebar";
  sidebar.dataset.workspaceResizable = "true";
  sidebar.dataset.workspaceCollapsible = options.collapsible ? "true" : "false";
  setRect(sidebar, { height: 700, width: options.sidebarWidth ?? 176 });
  root.append(sidebar);

  const handle = document.createElement("button");
  handle.dataset.appWorkspaceResize = "sidebar";
  handle.dataset.workspaceResizeEdge = "end";
  sidebar.append(handle);
  document.body.append(root);

  return { handle, root, sidebar };
};

const dispatchKey = (element: Element, key: string) => {
  element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key }) as unknown as Event);
};

beforeEach(() => {
  window = new HappyWindow({ url: "https://ui.test/" });
  frames = new Map();
  frameId = 0;
  resizeObservers = [];
  for (const key of globalKeys) previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: Frame) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
});

afterEach(() => {
  window.close();
  for (const key of globalKeys) {
    const descriptor = previousGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  previousGlobals.clear();
});

describe("AppWorkspace resize controller behaviour", () => {
  test("collapses from the sidebar minimum and restores the remembered width", () => {
    const { handle, root, sidebar } = workspace({ collapsible: true });
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, sidebarWidth: 248, sidebarCollapsed: false }),
      writeState: (state) => written.push(state),
    });

    dispatchKey(handle, "ArrowLeft");
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe(`${APP_WORKSPACE_SIDEBAR_COLLAPSED}px`);
    expect(root.dataset.sidebarCollapsed).toBe("true");
    expect(written.at(-1)).toMatchObject({ sidebarWidth: 248, sidebarCollapsed: true });

    setRect(sidebar, { height: 700, width: APP_WORKSPACE_SIDEBAR_COLLAPSED });
    dispatchKey(handle, "ArrowRight");
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("248px");
    expect(root.dataset.sidebarCollapsed).toBeUndefined();
    expect(written.at(-1)).toMatchObject({ sidebarWidth: 248, sidebarCollapsed: false });
    dispose();
  });

  test("applies vertical arrow steps relative to the drawer handle edge", () => {
    const { root } = workspace({ height: 900 });
    const panel = document.createElement("section");
    panel.id = "activity";
    panel.dataset.workspaceResizable = "true";
    setRect(panel, { height: 320, width: 1000 });
    root.append(panel);
    const handle = document.createElement("button");
    handle.dataset.appWorkspaceResize = "drawer";
    handle.dataset.workspacePanelId = "activity";
    handle.dataset.workspaceResizeEdge = "end";
    handle.setAttribute("aria-controls", panel.id);
    root.append(handle);
    const dispose = installAppWorkspaceController({ root });

    dispatchKey(handle, "ArrowUp");
    expect(root.style.getPropertyValue("--k2b-workspace-drawer-activity-height")).toBe("312px");

    handle.dataset.workspaceResizeEdge = "start";
    dispatchKey(handle, "ArrowUp");
    expect(root.style.getPropertyValue("--k2b-workspace-drawer-activity-height")).toBe("328px");
    dispose();
  });

  test("resizes a detail panel from its leading edge", () => {
    const { root } = workspace();
    const panel = document.createElement("aside");
    panel.id = "record";
    panel.className = "k2b-app-workspace__detail";
    panel.dataset.workspaceResizable = "true";
    setRect(panel, { height: 700, width: 384 });
    root.append(panel);
    const handle = document.createElement("button");
    handle.dataset.appWorkspaceResize = "detail";
    handle.dataset.workspacePanelId = "record";
    handle.dataset.workspaceResizeEdge = "start";
    handle.setAttribute("aria-controls", panel.id);
    root.insertBefore(handle, panel);
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({ root, writeState: (state) => written.push(state) });

    dispatchKey(handle, "ArrowLeft");
    expect(root.style.getPropertyValue("--k2b-workspace-detail-record-width")).toBe("392px");
    expect(written.at(-1)).toMatchObject({ detailWidths: { record: 392 } });
    dispose();
  });

  test("tracks the latest live sidebar pointer once per animation frame before applying its snap", () => {
    const { handle, root } = workspace({ collapsible: true });
    const dispose = installAppWorkspaceController({ root });

    handle.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 176,
        pointerId: 7,
      }) as unknown as Event,
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 206, pointerId: 7 }));
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 218, pointerId: 7 }));
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("");
    flushFrames();

    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("218px");
    expect(root.dataset.workspaceResizeActive).toBe("sidebar");
    dispose();
  });

  test("flushes the latest live resize before disposal", () => {
    const { handle, root } = workspace();
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({ root, writeState: (state) => written.push(state) });

    handle.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 176, pointerId: 7 }) as unknown as Event,
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 218, pointerId: 7 }));
    dispose();

    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("218px");
    expect(written.at(-1)).toMatchObject({ sidebarWidth: 218 });
  });

  test("keeps a live pane preference through multi-pane reconciliation", async () => {
    const { root } = workspace({ width: 1400 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    let mainWidth = 1200;
    setDynamicRect(main, () => ({ height: 700, width: mainWidth }));

    const pane = document.createElement("section");
    pane.id = "conversation-list";
    pane.className = "k2b-app-workspace__main-pane";
    pane.dataset.workspaceResizable = "true";
    const paneVariable = "--k2b-workspace-pane-conversations-width";
    setDynamicRect(pane, () => ({
      height: 700,
      width: Number.parseFloat(root.style.getPropertyValue(paneVariable)) || 430,
    }));
    const paneHandle = document.createElement("button");
    paneHandle.dataset.appWorkspaceResize = "pane";
    paneHandle.dataset.workspacePanelId = "conversations";
    paneHandle.dataset.workspaceResizeEdge = "end";
    paneHandle.dataset.workspaceDefaultSize = "430";
    paneHandle.dataset.workspaceMinSize = "300";
    paneHandle.dataset.workspaceMaxSize = "620";
    paneHandle.setAttribute("aria-controls", pane.id);
    const secondPane = document.createElement("section");
    secondPane.id = "activity-list";
    secondPane.className = "k2b-app-workspace__main-pane";
    secondPane.dataset.workspaceResizable = "true";
    const secondVariable = "--k2b-workspace-pane-activity-width";
    setDynamicRect(secondPane, () => ({
      height: 700,
      width: Number.parseFloat(root.style.getPropertyValue(secondVariable)) || 400,
    }));
    const secondHandle = document.createElement("button");
    secondHandle.dataset.appWorkspaceResize = "pane";
    secondHandle.dataset.workspacePanelId = "activity";
    secondHandle.dataset.workspaceDefaultSize = "400";
    secondHandle.dataset.workspaceMinSize = "300";
    secondHandle.dataset.workspaceMaxSize = "620";
    secondHandle.setAttribute("aria-controls", secondPane.id);
    const primary = document.createElement("section");
    primary.className = "k2b-app-workspace__main-primary";
    main.append(pane, paneHandle, primary, secondHandle, secondPane);
    root.append(main);

    const detail = document.createElement("aside");
    detail.className = "k2b-app-workspace__detail";
    detail.hidden = true;
    root.append(detail);

    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { conversations: 430, activity: 400 } }),
      writeState: (state) => written.push(state),
    });
    flushFrames();

    paneHandle.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 430,
        pointerId: 7,
      }) as unknown as Event,
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 480, pointerId: 7 }));
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("480px");

    mainWidth = 1000;
    detail.hidden = false;
    await Promise.resolve();
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("351px");
    expect(root.style.getPropertyValue(secondVariable)).toBe("329px");

    resizeObservers.forEach((observer) => observer.trigger());
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("351px");

    window.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 480, pointerId: 7 }));
    expect(root.style.getPropertyValue(paneVariable)).toBe("351px");
    expect(written).toEqual([expect.objectContaining({ paneWidths: { conversations: 480, activity: 400 } })]);

    resizeObservers.forEach((observer) => observer.trigger());
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("351px");

    paneHandle.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 351,
        pointerId: 8,
      }) as unknown as Event,
    );
    resizeObservers.forEach((observer) => observer.trigger());
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("351px");
    window.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 351, pointerId: 8 }));
    expect(root.style.getPropertyValue(paneVariable)).toBe("351px");
    expect(written).toHaveLength(1);
    dispose();
  });

  test("settles pointer cancellation and window blur exactly once", () => {
    const { handle, root } = workspace({ sidebarWidth: 220 });
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({ root, writeState: (state) => written.push(state) });
    flushFrames();

    handle.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 220,
        pointerId: 7,
      }) as unknown as Event,
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 240, pointerId: 7 }));
    resizeObservers.forEach((observer) => observer.trigger());
    flushFrames();
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("240px");

    window.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 7 }));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ sidebarWidth: 240, sidebarCollapsed: false });
    expect(root.dataset.workspaceResizeActive).toBeUndefined();
    expect(handle.dataset.workspaceResizeActive).toBeUndefined();

    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 260, pointerId: 7 }));
    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 7 }));
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("240px");
    expect(written).toHaveLength(1);

    handle.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 220,
        pointerId: 8,
      }) as unknown as Event,
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 250, pointerId: 8 }));
    window.dispatchEvent(new window.Event("blur"));
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ sidebarWidth: 250, sidebarCollapsed: false });

    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 8 }));
    expect(written).toHaveLength(2);
    dispose();
  });

  test("does not reconcile a hidden, zero-width or locked workspace", () => {
    for (const mode of ["hidden", "zero", "locked"] as const) {
      const { root } = workspace({
        resizable: mode !== "locked",
        width: mode === "zero" ? 0 : 1000,
      });
      if (mode === "hidden") root.style.display = "none";
      const dispose = installAppWorkspaceController({
        root,
        readState: () => ({ version: 2, sidebarWidth: 248 }),
      });
      flushFrames();
      expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width"), mode).toBe("");
      dispose();
      root.remove();
    }
  });

  test("refits panes when detail visibility changes without overwriting their preferred width", async () => {
    let rootWidth = 1300;
    const { root } = workspace({ sidebarWidth: 208 });
    setDynamicRect(root, () => ({ height: 700, width: rootWidth }));

    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    const primary = document.createElement("section");
    primary.className = "k2b-app-workspace__main-primary";
    main.append(primary);

    const pane = document.createElement("section");
    pane.id = "main-two";
    pane.className = "k2b-app-workspace__main-pane";
    pane.dataset.workspaceResizable = "true";
    const paneVariable = "--k2b-workspace-pane-main-2-width";
    setDynamicRect(pane, () => ({
      height: 700,
      width: Number.parseFloat(root.style.getPropertyValue(paneVariable)) || 640,
    }));
    const paneHandle = document.createElement("button");
    paneHandle.dataset.appWorkspaceResize = "pane";
    paneHandle.dataset.workspacePanelId = "main-2";
    paneHandle.dataset.workspaceDefaultSize = "640";
    paneHandle.dataset.workspaceMinSize = "240";
    paneHandle.dataset.workspaceMaxSize = "640";
    paneHandle.setAttribute("aria-controls", pane.id);
    main.append(paneHandle, pane);
    root.append(main);

    const detail = document.createElement("aside");
    detail.id = "record";
    detail.className = "k2b-app-workspace__detail";
    detail.dataset.workspaceResizable = "true";
    detail.hidden = true;
    setRect(detail, { height: 700, width: 288 });
    const detailHandle = document.createElement("button");
    detailHandle.dataset.appWorkspaceResize = "detail";
    detailHandle.dataset.workspacePanelId = "record";
    detailHandle.dataset.workspaceDefaultSize = "288";
    detailHandle.dataset.workspaceMinSize = "288";
    detailHandle.dataset.workspaceMaxSize = "640";
    detailHandle.setAttribute("aria-controls", detail.id);
    root.append(detailHandle, detail);
    setDynamicRect(main, () => ({
      height: 700,
      width: rootWidth - 208 - (detail.hidden ? 0 : 288),
    }));

    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { "main-2": 640 } }),
      writeState: (state) => written.push(state),
    });
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("640px");

    detail.hidden = false;
    await Promise.resolve();
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("484px");
    expect(written).toEqual([]);

    detail.hidden = true;
    await Promise.resolve();
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("640px");

    rootWidth = 1100;
    resizeObservers.forEach((observer) => observer.trigger());
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("572px");

    rootWidth = 1300;
    resizeObservers.forEach((observer) => observer.trigger());
    flushFrames();
    expect(root.style.getPropertyValue(paneVariable)).toBe("640px");
    dispose();
  });

  test("shrinks multiple auxiliary panes fairly around the flexible main anchor", () => {
    const { root } = workspace({ sidebarWidth: 208, width: 1208 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    setRect(main, { height: 700, width: 1000 });
    const primary = document.createElement("section");
    primary.className = "k2b-app-workspace__main-primary";
    main.append(primary);

    for (const id of ["two", "three"]) {
      const pane = document.createElement("section");
      pane.id = `main-${id}`;
      pane.className = "k2b-app-workspace__main-pane";
      pane.dataset.workspaceResizable = "true";
      const variable = `--k2b-workspace-pane-${id}-width`;
      setDynamicRect(pane, () => ({
        height: 700,
        width: Number.parseFloat(root.style.getPropertyValue(variable)) || 500,
      }));
      const handle = document.createElement("button");
      handle.dataset.appWorkspaceResize = "pane";
      handle.dataset.workspacePanelId = id;
      handle.dataset.workspaceDefaultSize = "500";
      handle.dataset.workspaceMinSize = "240";
      handle.dataset.workspaceMaxSize = "640";
      handle.setAttribute("aria-controls", pane.id);
      main.append(handle, pane);
    }
    root.append(main);

    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { two: 500, three: 500 } }),
    });
    flushFrames();

    expect(root.style.getPropertyValue("--k2b-workspace-pane-two-width")).toBe("340px");
    expect(root.style.getPropertyValue("--k2b-workspace-pane-three-width")).toBe("340px");
    dispose();
  });

  test("measures marquee labels lazily and clears cached geometry on resize", () => {
    const { root, sidebar } = workspace();
    const item = document.createElement("div");
    item.className = "k2b-app-workspace__sidebar-item";
    const label = document.createElement("span");
    label.className = "k2b-app-workspace__sidebar-item-label";
    label.dataset.marquee = "true";
    Object.defineProperty(label, "clientWidth", { configurable: true, value: 80 });
    const text = document.createElement("span");
    text.className = "k2b-app-workspace__sidebar-item-label-text";
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 120 });
    label.append(text);
    item.append(label);
    sidebar.append(item);
    const dispose = installAppWorkspaceController({ root });

    label.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true }) as unknown as Event);
    flushFrames();
    expect(label.dataset.overflow).toBe("true");
    expect(label.style.getPropertyValue("--k2b-sidebar-label-overflow")).toBe("40px");

    window.dispatchEvent(new window.Event("resize"));
    expect(label.dataset.overflow).toBeUndefined();
    expect(label.style.getPropertyValue("--k2b-sidebar-label-overflow")).toBe("");
    dispose();
  });

  test("refreshes handle values on focus and removes listeners on dispose", () => {
    const { handle, root } = workspace({ sidebarWidth: 220 });
    const dispose = installAppWorkspaceController({ root });

    handle.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
    dispose();

    dispatchKey(handle, "ArrowRight");
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("");
  });
});
