import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import {
  APP_WORKSPACE_DETAIL_CLOSE_EVENT,
  APP_WORKSPACE_DETAIL_STEP_EVENT,
  APP_WORKSPACE_SIDEBAR_HIDE_EVENT,
  installAppWorkspaceController,
  parkWorkspaceDetailDrawers,
} from "./app-workspace-controller";
import { APP_WORKSPACE_DETAIL_DEFAULT, APP_WORKSPACE_SIDEBAR_COLLAPSED, fitAppWorkspacePaneSizes } from "./app-workspace-state";

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
  "MouseEvent",
  "TouchEvent",
  "Event",
  "CustomEvent",
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
  options: { collapsible?: boolean; height?: number; hideable?: boolean; resizable?: boolean; sidebarWidth?: number; width?: number } = {},
) => {
  const root = document.createElement("div");
  root.dataset.k2bAppWorkspace = "";
  // Happy DOM does not evaluate the stylesheet's container queries.
  root.style.setProperty("--k2b-workspace-level-class", (options.width ?? 1000) >= 1280 ? "3" : "2");

  root.dataset.workspaceResizable = options.resizable === false ? "false" : "true";
  setRect(root, { height: options.height ?? 700, width: options.width ?? 1000 });

  const sidebar = document.createElement("aside");
  sidebar.className = "k2b-app-workspace__sidebar";
  sidebar.style.setProperty("--k2b-workspace-sidebar-form", "column");
  sidebar.dataset.workspaceResizable = "true";
  sidebar.dataset.workspaceCollapsible = options.collapsible ? "true" : "false";
  if (options.hideable) sidebar.dataset.workspaceHideable = "true";
  setRect(sidebar, { height: 700, width: options.sidebarWidth ?? 176 });
  root.append(sidebar);

  const handle = document.createElement("button");
  handle.dataset.appWorkspaceResize = "sidebar";
  handle.dataset.workspaceResizeEdge = "end";
  handle.dataset.workspaceMinSize = "176";
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
    MouseEvent: window.MouseEvent,
    TouchEvent: window.TouchEvent,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
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
  test("restoring a sidebar width preserves the server overlay despite Main's configured minimum", () => {
    const { root, handle } = workspace({ width: 1064, sidebarWidth: 360 });
    root.style.setProperty("--k2b-workspace-main-min", "760px");
    const dispose = installAppWorkspaceController({ root, readState: () => ({ version: 2, sidebarWidth: 360 }) });
    try {
      flushFrames();
      expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("360px");
      expect(handle.getAttribute("aria-valuemax")).toBe("304");
      flushFrames();
      expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("360px");
      dispatchKey(handle, "ArrowLeft");
      expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("304px");
    } finally {
      dispose();
    }
  });

  test("Detail resizing reserves Main's configured minimum", () => {
    const { root, handle } = detailWorkspace();
    root.style.setProperty("--k2b-workspace-main-min", "760px");
    const dispose = installAppWorkspaceController({ root });
    try {
      dispatchKey(handle, "End");
      // 1400 px from Content's start to the workspace's end, less the 8 px inset and Main's 760 px.
      expect(handle.getAttribute("aria-valuemax")).toBe("632");
    } finally {
      dispose();
    }
  });

  test("sidebar resizing reserves Main's configured minimum and never sets max below min", () => {
    const { root, handle, sidebar } = workspace({ width: 1000.75, sidebarWidth: 208 });
    root.style.setProperty("--k2b-workspace-main-min", "760px");
    setDynamicRect(sidebar, () => ({
      width: Number.parseFloat(root.style.getPropertyValue("--k2b-workspace-sidebar-width")) || 208,
      height: 700,
    }));
    const dispose = installAppWorkspaceController({ root });
    try {
      for (let i = 0; i < 30; i++) dispatchKey(handle, "ArrowRight");
      expect(handle.getAttribute("aria-valuemax")).toBe("240");
      expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("240px");
      root.style.setProperty("--k2b-workspace-main-min", "980px");
      dispatchKey(handle, "ArrowRight");
      expect(handle.getAttribute("aria-valuemax")).toBe(handle.getAttribute("aria-valuemin"));
    } finally {
      dispose();
    }
  });

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
    setRect(panel, { height: 700, width: 416 });
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
    expect(root.style.getPropertyValue("--k2b-workspace-detail-record-width")).toBe("424px");
    expect(written.at(-1)).toMatchObject({ detailWidths: { record: 424 } });
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

  test("hides a hideable sidebar dragged below half its minimum without persisting the drag", () => {
    const { handle, root, sidebar } = workspace({ hideable: true, sidebarWidth: 240 });
    const written: unknown[] = [];
    // What the layout looks like when the host receives the request.
    const requests: { preview: string | undefined; width: string }[] = [];
    sidebar.addEventListener(APP_WORKSPACE_SIDEBAR_HIDE_EVENT, () =>
      requests.push({
        preview: sidebar.dataset.workspaceHidePreview,
        width: root.style.getPropertyValue("--k2b-workspace-sidebar-width"),
      }),
    );
    const dispose = installAppWorkspaceController({ root, writeState: (state) => written.push(state) });
    flushFrames();
    const drag = (clientX: number) => {
      window.dispatchEvent(new window.PointerEvent("pointermove", { clientX, pointerId: 7 }));
      flushFrames();
    };

    handle.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 240, pointerId: 7 }) as unknown as Event,
    );
    // Between the minimum and half of it the sidebar stays at its minimum.
    drag(100);
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("176px");
    expect(sidebar.dataset.workspaceHidePreview).toBeUndefined();
    drag(80);
    expect(sidebar.dataset.workspaceHidePreview).toBe("true");
    // The preview keeps the minimum width, so the work area does not change during the drag.
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("176px");
    // Dragging back out cancels the preview.
    drag(200);
    expect(sidebar.dataset.workspaceHidePreview).toBeUndefined();
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("200px");
    drag(20);
    expect(sidebar.dataset.workspaceHidePreview).toBe("true");

    window.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 20, pointerId: 7 }));
    // The request arrives in the layout the user saw at release, before the width is restored.
    expect(requests).toEqual([{ preview: "true", width: "200px" }]);
    expect(sidebar.dataset.workspaceHidePreview).toBeUndefined();
    // The width before the drag is what showing the sidebar again restores.
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("240px");
    expect(written).toEqual([]);
    dispose();
  });

  test("never hides a sidebar without the hideable marker", () => {
    const { handle, root, sidebar } = workspace({ sidebarWidth: 240 });
    const requests: Event[] = [];
    sidebar.addEventListener(APP_WORKSPACE_SIDEBAR_HIDE_EVENT, (event) => requests.push(event));
    const dispose = installAppWorkspaceController({ root });

    handle.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 240, pointerId: 7 }) as unknown as Event,
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 10, pointerId: 7 }));
    flushFrames();
    expect(sidebar.dataset.workspaceHidePreview).toBeUndefined();
    window.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 10, pointerId: 7 }));
    expect(requests).toEqual([]);
    expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("176px");
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
    setRect(detail, { height: 700, width: 320 });
    const detailHandle = document.createElement("button");
    detailHandle.dataset.appWorkspaceResize = "detail";
    detailHandle.dataset.workspacePanelId = "record";
    detailHandle.dataset.workspaceDefaultSize = "320";
    detailHandle.dataset.workspaceMinSize = "320";
    detailHandle.dataset.workspaceMaxSize = "640";
    detailHandle.setAttribute("aria-controls", detail.id);
    root.append(detailHandle, detail);
    setDynamicRect(main, () => ({
      height: 700,
      width: rootWidth - 208 - (detail.hidden ? 0 : 320 + 16),
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
    expect(root.style.getPropertyValue(paneVariable)).toBe("436px");
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

const detailWorkspace = (
  options: {
    open?: boolean;
    closable?: boolean;
    steppable?: boolean;
    documentRoot?: boolean;
    onStep?: (direction: 1 | -1) => HTMLElement | void;
  } = {},
) => {
  const { root, sidebar } = workspace({ width: 1400 });
  const content = document.createElement("div");
  content.className = "k2b-app-workspace__content";
  setRect(content, { width: 1200, height: 700 });
  const main = document.createElement("main");
  main.className = "k2b-app-workspace__main";
  const item = document.createElement("button");
  item.textContent = "Selected row";
  item.scrollIntoView = () => {};
  main.append(item);
  const aside = document.createElement("aside");
  aside.id = "detail-record";
  aside.className = "k2b-app-workspace__detail";
  aside.hidden = options.open === false;
  aside.dataset.workspaceResizable = "true";
  if (options.closable !== false) aside.dataset.workspaceDetailClosable = "true";
  if (options.steppable) aside.dataset.workspaceDetailSteppable = "true";
  const title = document.createElement("h2");
  title.textContent = "Record";
  const close = document.createElement("button");
  close.textContent = "Close";
  aside.append(title, close);
  setRect(aside, { width: 416, height: 684 });
  const handle = document.createElement("button");
  handle.dataset.appWorkspaceResize = "detail";
  handle.dataset.workspacePanelId = "record";
  handle.dataset.workspaceDefaultSize = "416";
  handle.setAttribute("aria-controls", aside.id);
  content.append(main, handle, aside);
  root.append(content);
  const closed: Event[] = [];
  const steps: number[] = [];
  aside.addEventListener(APP_WORKSPACE_DETAIL_CLOSE_EVENT, (event) => closed.push(event));
  aside.addEventListener(APP_WORKSPACE_DETAIL_STEP_EVENT, (event) => {
    if (event instanceof CustomEvent) {
      steps.push(event.detail.direction);
      const item = options.onStep?.(event.detail.direction);
      if (item instanceof HTMLElement) event.detail.item = item;
    }
  });
  return { root, content, main, item, aside, title, close, handle, sidebar, closed, steps };
};
const detailKey = (target: Element, key: string, prevented = false) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (prevented) event.preventDefault();
  target.dispatchEvent(event);
  return event;
};
const rememberPointer = (item: HTMLElement) => item.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
const detailTouch = (target: HTMLElement, type: string, x: number, y: number) => {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true });
  // happy-dom supplies TouchEvent but not Touch; only these coordinates are consumed.
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ identifier: 1, clientX: x, clientY: y }] });
  target.dispatchEvent(event);
  return event;
};

describe("phone page workspace isolation", () => {
  const viewport = (matches = true) => {
    const changes = new window.EventTarget();
    const phone = {
      matches,
      addEventListener: changes.addEventListener.bind(changes),
      removeEventListener: changes.removeEventListener.bind(changes),
    };
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) =>
        query === "(max-width: 47.999rem)" ? phone : { matches: false, addEventListener() {}, removeEventListener() {} },
    });
    return (matches: boolean) => {
      phone.matches = matches;
      changes.dispatchEvent(new window.Event("change"));
    };
  };

  test("Tab leaves visible host surfaces above a phone page operable and redirects only covered focus or body", () => {
    viewport();
    const { root, aside, close } = detailWorkspace();
    aside.dataset.workspaceDetailPhone = "page";
    const hostControl = document.createElement("button");
    const icon = document.createElement("span");
    hostControl.append(icon);
    document.body.append(hostControl);
    setRect(hostControl, { width: 80, height: 40 });
    let hit: Element | null = hostControl;
    const points: number[][] = [];
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number) => {
        points.push([x, y]);
        return hit;
      },
    });
    const dispose = installAppWorkspaceController({ root });
    try {
      for (const visibleHit of [hostControl, icon]) {
        hit = visibleHit;
        hostControl.focus();
        for (const shiftKey of [false, true]) {
          const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
          hostControl.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
          expect(document.activeElement === hostControl).toBe(true);
        }
      }
      expect(points).toEqual([
        [40, 20],
        [40, 20],
        [40, 20],
        [40, 20],
      ]);
      // The same control underneath the page must enter the page instead.
      hit = aside;
      expect(detailKey(hostControl, "Tab").defaultPrevented).toBe(true);
      expect(document.activeElement === close).toBe(true);
      // Body focus after a load still enters the page, regardless of hit-testing.
      hit = document.body;
      close.blur();
      expect(document.activeElement === document.body).toBe(true);
      expect(detailKey(document.body, "Tab").defaultPrevented).toBe(true);
      expect(document.activeElement === close).toBe(true);
    } finally {
      dispose();
    }
  });

  test("isolates only the workspace path, preserves application inert, and restores focus on close", async () => {
    viewport();
    const { root, content, main, aside, sidebar, item, close, handle } = detailWorkspace({ open: false });
    aside.dataset.workspaceDetailPhone = "page";
    sidebar.setAttribute("inert", "");
    const head = document.createElement("header");
    root.prepend(head);
    const island = document.createElement("solid-island");
    const client = document.createElement("solid-client");
    const sibling = document.createElement("button");
    const innerSibling = document.createElement("button");
    content.append(island);
    island.append(sibling, client);
    client.append(innerSibling, aside);
    const outside = document.createElement("button");
    document.body.append(outside);
    const dispose = installAppWorkspaceController({ root });
    try {
      item.focus();
      rememberPointer(item);
      aside.hidden = false;
      await window.happyDOM.whenAsyncComplete();
      const touched = [main, handle, head, sibling, innerSibling];
      for (const region of touched) expect(region.hasAttribute("inert")).toBe(true);
      for (const region of [root, content, island, client, aside, outside]) expect(region.hasAttribute("inert")).toBe(false);
      // Repeated observer runs must not forget which attributes belong to the controller.
      aside.append(document.createElement("span"));
      await window.happyDOM.whenAsyncComplete();
      close.focus();
      aside.addEventListener(APP_WORKSPACE_DETAIL_CLOSE_EVENT, () => {
        aside.hidden = true;
      });
      detailKey(close, "Escape");
      await window.happyDOM.whenAsyncComplete();
      for (const region of touched) expect(region.hasAttribute("inert")).toBe(false);
      expect(sidebar.hasAttribute("inert")).toBe(true);
      expect(document.activeElement === item).toBe(true);
    } finally {
      dispose();
    }
  });

  test("leaves sheets and desktop alone, then releases phone isolation on resize, removal, and disposal", async () => {
    const setPhone = viewport(false);
    const { root, main, aside, sidebar } = detailWorkspace();
    aside.dataset.workspaceDetailPhone = "page";
    const dispose = installAppWorkspaceController({ root: document });
    try {
      expect(root.querySelector("[inert]")).toBeNull();
      setPhone(true);
      expect(main.hasAttribute("inert")).toBe(true);
      setPhone(false);
      expect(root.querySelector("[inert]")).toBeNull();
      delete aside.dataset.workspaceDetailPhone;
      setPhone(true);
      expect(root.querySelector("[inert]")).toBeNull();
      aside.dataset.workspaceDetailPhone = "page";
      setPhone(true);
      const added = document.createElement("button");
      main.parentElement!.append(added);
      await window.happyDOM.whenAsyncComplete();
      expect(added.hasAttribute("inert")).toBe(true);
      aside.remove();
      await window.happyDOM.whenAsyncComplete();
      expect(root.querySelector("[inert]")).toBeNull();
      main.parentElement!.append(aside);
      await window.happyDOM.whenAsyncComplete();
      expect(sidebar.hasAttribute("inert")).toBe(true);
      root.remove();
      await window.happyDOM.whenAsyncComplete();
      expect(root.querySelector("[inert]")).toBeNull();
      document.body.append(root);
      await window.happyDOM.whenAsyncComplete();
      expect(main.hasAttribute("inert")).toBe(true);
    } finally {
      dispose();
    }
    expect(root.querySelector("[inert]")).toBeNull();
    setPhone(false);
    setPhone(true);
    expect(root.querySelector("[inert]")).toBeNull();
  });
});

describe("floating detail controller", () => {
  test("enables motion after two frames, including inserted roots, and cancels it on disposal", async () => {
    const { root } = detailWorkspace();
    const dispose = installAppWorkspaceController({ root: document });
    expect(root.hasAttribute("data-workspace-motion")).toBe(false);
    flushFrames();
    expect(root.hasAttribute("data-workspace-motion")).toBe(false);
    flushFrames();
    expect(root.hasAttribute("data-workspace-motion")).toBe(true);
    const inserted = detailWorkspace().root;
    await window.happyDOM.whenAsyncComplete();
    flushFrames();
    expect(inserted.hasAttribute("data-workspace-motion")).toBe(false);
    flushFrames();
    expect(inserted.hasAttribute("data-workspace-motion")).toBe(true);
    dispose();
    expect(root.hasAttribute("data-workspace-motion")).toBe(false);
    expect(inserted.hasAttribute("data-workspace-motion")).toBe(false);
    expect(frames.size).toBe(0);
  });

  test("Escape requests close only when the owning detail is closable", () => {
    const first = detailWorkspace();
    const second = detailWorkspace({ closable: false });
    const dispose = installAppWorkspaceController({ root: document });
    expect(detailKey(first.item, "Escape").defaultPrevented).toBe(true);
    expect(detailKey(second.close, "Escape").defaultPrevented).toBe(false);
    expect(first.closed).toHaveLength(1);
    expect(second.closed).toHaveLength(0);
    detailKey(document.body, "Escape");
    expect(first.closed).toHaveLength(1);
    dispose();
  });

  test("document application handlers registered later can consume detail keys", () => {
    const { root, item, closed, steps } = detailWorkspace({ steppable: true });
    const dispose = installAppWorkspaceController({ root });
    const consume = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", consume);
    for (const key of ["Escape", "j", "k", "F6"]) detailKey(item, key);
    expect(closed).toHaveLength(0);
    expect(steps).toHaveLength(0);
    document.removeEventListener("keydown", consume);
    let applicationKeys = 0;
    const observe = () => applicationKeys++;
    document.addEventListener("keydown", observe);
    detailKey(item, "Escape");
    expect(applicationKeys).toBe(1);
    expect(closed).toHaveLength(1);
    dispose();
    detailKey(item, "Escape");
    expect(closed).toHaveLength(1);
    document.removeEventListener("keydown", observe);
  });

  test("Escape clicks a declarative close button without an onClose contract", () => {
    const { root, aside, close, closed } = detailWorkspace({ closable: false });
    close.dataset.workspaceDetailClose = "";
    let clicks = 0;
    close.addEventListener("click", () => clicks++);
    const dispose = installAppWorkspaceController({ root });
    expect(detailKey(aside, "Escape").defaultPrevented).toBe(true);
    expect(clicks).toBe(1);
    expect(closed).toHaveLength(0);
    dispose();
  });

  test("a nested detail's declarative control does not make the outer panel closable", () => {
    const outer = detailWorkspace({ closable: false });
    const inner = detailWorkspace({ closable: false });
    inner.close.dataset.workspaceDetailClose = "";
    let clicks = 0;
    inner.close.addEventListener("click", () => clicks++);
    outer.aside.append(inner.root);
    const dispose = installAppWorkspaceController({ root: outer.root });
    expect(detailKey(outer.item, "Escape").defaultPrevented).toBe(false);
    expect(clicks).toBe(0);
    expect(outer.closed).toHaveLength(0);
    dispose();
  });

  test("ignores typing, menus, dialogs, expanded controls, modifiers, and prevented keys", () => {
    const { root, aside, item, closed } = detailWorkspace();
    const dispose = installAppWorkspaceController({ root });
    const input = document.createElement("input");
    aside.append(input);
    detailKey(input, "Escape");
    detailKey(item, "Escape", true);
    for (const role of ["menu", "listbox", "dialog", "textbox", "combobox", "searchbox", "spinbutton"]) {
      const region = document.createElement("div");
      region.setAttribute("role", role);
      region.append(document.createElement("button"));
      aside.append(region);
      detailKey(region.firstElementChild!, "Escape");
      region.remove();
    }
    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.append(dialog);
    detailKey(item, "Escape");
    dialog.remove();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    detailKey(item, "Escape");
    modal.remove();
    item.setAttribute("aria-expanded", "true");
    item.setAttribute("aria-haspopup", "menu");
    detailKey(item, "Escape");
    item.removeAttribute("aria-expanded");
    item.removeAttribute("aria-haspopup");
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true }));
    expect(closed).toHaveLength(0);
    dispose();
  });

  test("an expanded tree row without a popup still closes the detail with Escape", () => {
    const { root, item, closed } = detailWorkspace();
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-expanded", "true");
    const dispose = installAppWorkspaceController({ root });
    expect(detailKey(item, "Escape").defaultPrevented).toBe(true);
    expect(closed).toHaveLength(1);
    dispose();
  });

  test("the overlay sidebar handles Escape before the detail", () => {
    Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    const { root, sidebar, closed } = detailWorkspace();
    sidebar.style.setProperty("--k2b-workspace-sidebar-form", "overlay");
    const toggle = document.createElement("button");
    toggle.dataset.appWorkspaceSidebarToggle = "";
    root.prepend(toggle);
    const nav = document.createElement("button");
    sidebar.append(nav);
    const dispose = installAppWorkspaceController({ root });
    toggle.click();
    expect(root.dataset.sidebarOverlay).toBe("open");
    expect(detailKey(sidebar, "Escape").defaultPrevented).toBe(true);
    expect(root.dataset.sidebarOverlay).toBeUndefined();
    expect(closed).toHaveLength(0);
    dispose();
  });

  test("J and K step only a steppable detail and never while typing", () => {
    const { root, item, aside, steps } = detailWorkspace({ steppable: true });
    const dispose = installAppWorkspaceController({ root });
    detailKey(item, "j");
    detailKey(item, "K");
    const input = document.createElement("textarea");
    aside.append(input);
    detailKey(input, "j");
    aside.removeAttribute("data-workspace-detail-steppable");
    detailKey(item, "j");
    expect(steps).toEqual([1, -1]);
    dispose();
  });

  test("a stepped Main item becomes the return target for F6 and Escape", async () => {
    const next = document.createElement("button");
    const { root, main, item, title, aside } = detailWorkspace({ steppable: true, onStep: () => next });
    main.append(next);
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    detailKey(item, "F6");
    detailKey(title, "j");
    detailKey(title, "F6");
    expect(document.activeElement === next).toBe(true);
    detailKey(next, "F6");
    expect(detailKey(title, "Escape").defaultPrevented).toBe(true);
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === next).toBe(true);
    dispose();
  });

  for (const focus of ["old item", "elsewhere in Main"]) {
    test(`J from ${focus} focuses the stepped Main item`, () => {
      const next = document.createElement("button");
      const { root, main, item } = detailWorkspace({ steppable: true, onStep: () => next });
      main.append(next);
      const dispose = installAppWorkspaceController({ root });
      item.focus();
      const target = focus === "old item" ? item : main;
      if (target === main) {
        main.tabIndex = -1;
        main.focus();
      }
      expect(detailKey(target, "j").defaultPrevented).toBe(true);
      expect(document.activeElement === next).toBe(true);
      dispose();
    });
  }

  test("J inside the panel waits for the new title and focuses it", async () => {
    const next = document.createElement("button");
    const { root, main, item, close, title } = detailWorkspace({ steppable: true, onStep: () => next });
    main.append(next);
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    close.focus();
    detailKey(close, "j");
    expect(document.activeElement === close).toBe(true);
    title.firstChild!.nodeValue = "Next record";
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === title).toBe(true);
    dispose();
  });

  test("J inside the panel focuses a title the step swapped at once", () => {
    const next = document.createElement("button");
    const fresh = document.createElement("h2");
    fresh.textContent = "Next record";
    const { root, main, item, aside, close, title } = detailWorkspace({
      steppable: true,
      onStep: () => {
        title.remove();
        close.remove();
        aside.append(fresh);
        return next;
      },
    });
    main.append(next);
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    close.focus();
    detailKey(close, "j");
    expect(document.activeElement === fresh).toBe(true);
    dispose();
  });

  for (const second of ["another item", "nothing past the last item"]) {
    test(`a second J from the body, after the first removed the focused title, returns focus to the title for ${second}`, async () => {
      const items = [document.createElement("button"), document.createElement("button")];
      let index = 0;
      const { root, main, item, aside, title } = detailWorkspace({
        steppable: true,
        onStep: () => {
          title.remove();
          if (second === "nothing past the last item" && index === 1) return;
          return items[index++];
        },
      });
      main.append(...items);
      const dispose = installAppWorkspaceController({ root });
      item.focus();
      title.tabIndex = -1;
      title.focus();
      detailKey(title, "j");
      expect(document.activeElement === document.body).toBe(true);
      detailKey(document.body, "j");
      const fresh = document.createElement("h2");
      fresh.textContent = "Third record";
      aside.append(fresh);
      await window.happyDOM.whenAsyncComplete();
      expect(document.activeElement === fresh).toBe(true);
      dispose();
    });
  }

  test("a J from the body leaves focus alone once the person moved on from the panel", async () => {
    const next = document.createElement("button");
    const { root, main, item, aside, title } = detailWorkspace({
      steppable: true,
      onStep: () => {
        title.remove();
        return next;
      },
    });
    main.append(next);
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    title.tabIndex = -1;
    title.focus();
    detailKey(title, "j");
    rememberPointer(next);
    detailKey(document.body, "j");
    const fresh = document.createElement("h2");
    fresh.textContent = "Next record";
    aside.append(fresh);
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === document.body).toBe(true);
    dispose();
  });

  test("a step returning nothing keeps the previous item for F6", () => {
    const { root, item, title } = detailWorkspace({ steppable: true });
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    detailKey(item, "F6");
    detailKey(title, "j");
    detailKey(title, "F6");
    expect(document.activeElement === item).toBe(true);
    dispose();
  });

  test("F6 switches focus between the remembered row and title", () => {
    const { root, item, title } = detailWorkspace();
    const dispose = installAppWorkspaceController({ root });
    rememberPointer(item);
    item.focus();
    expect(detailKey(item, "F6").defaultPrevented).toBe(true);
    expect(document.activeElement === title).toBe(true);
    detailKey(title, "F6");
    expect(document.activeElement === item).toBe(true);
    dispose();
    expect(title.hasAttribute("tabindex")).toBe(false);
  });

  test("a keyboard open focuses the title and closing returns to its row", async () => {
    const { root, item, title, aside } = detailWorkspace({ open: false });
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    detailKey(item, "Enter");
    aside.hidden = false;
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === title).toBe(true);
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === item).toBe(true);
    dispose();
  });

  test("a keyboard open waits for an asynchronously rendered title", async () => {
    const { root, item, title, aside } = detailWorkspace({ open: false });
    title.remove();
    const dispose = installAppWorkspaceController({ root });
    item.focus();
    detailKey(item, "Enter");
    aside.hidden = false;
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === item).toBe(true);
    aside.append(title);
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === title).toBe(true);
    dispose();
    expect(title.hasAttribute("tabindex")).toBe(false);
  });

  for (const action of ["focus", "pointer", "key", "hide", "disconnect", "dispose"]) {
    test(`a pending title request yields to ${action}`, async () => {
      const { root, item, close, title, aside } = detailWorkspace({ open: false });
      title.remove();
      const dispose = installAppWorkspaceController({ root });
      item.focus();
      detailKey(item, "Enter");
      aside.hidden = false;
      await window.happyDOM.whenAsyncComplete();
      if (action === "focus") close.focus();
      else if (action === "pointer") rememberPointer(close);
      else if (action === "key") detailKey(item, "ArrowDown");
      else if (action === "hide") aside.hidden = true;
      else if (action === "disconnect") root.remove();
      else dispose();
      await window.happyDOM.whenAsyncComplete();
      if (action === "disconnect") document.body.append(root);
      aside.append(title);
      await window.happyDOM.whenAsyncComplete();
      expect(title.hasAttribute("tabindex")).toBe(false);
      if (action === "focus") expect(document.activeElement === close).toBe(true);
      if (action !== "dispose") dispose();
    });
  }

  for (const change of ["replacement", "text"]) {
    test(`Enter on an open panel focuses a title after ${change}`, async () => {
      const { root, item, title, aside } = detailWorkspace();
      const dispose = installAppWorkspaceController({ root });
      item.focus();
      detailKey(item, "Enter");
      const next = change === "replacement" ? document.createElement("h2") : title;
      if (next === title) title.firstChild!.nodeValue = "Another record";
      else {
        next.textContent = title.textContent;
        title.replaceWith(next);
      }
      await window.happyDOM.whenAsyncComplete();
      expect(document.activeElement === next).toBe(true);
      expect(aside.hidden).toBe(false);
      dispose();
    });
  }

  test("Enter in an editor in Main types and never moves focus to a changed title", async () => {
    const { root, main, title } = detailWorkspace();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    main.append(editor);
    const dispose = installAppWorkspaceController({ root });
    editor.focus();
    detailKey(editor, "Enter");
    title.firstChild!.nodeValue = "Renamed while typing";
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === editor).toBe(true);
    dispose();
  });

  for (const key of ["Enter", " "]) {
    test(`${key === " " ? "Space" : key} on an unchanged open panel ignores unrelated mutations`, async () => {
      const { root, item, aside, title } = detailWorkspace();
      const dispose = installAppWorkspaceController({ root });
      item.focus();
      detailKey(item, key);
      aside.append(document.createElement("span"));
      await window.happyDOM.whenAsyncComplete();
      expect(document.activeElement === item).toBe(true);
      expect(title.hasAttribute("tabindex")).toBe(false);
      dispose();
    });
  }

  test("roving row focus replaces the remembered wrapper for F6 and close", async () => {
    const { root, main, aside, title } = detailWorkspace({ open: false });
    const wrap = document.createElement("div");
    wrap.tabIndex = 0;
    wrap.style.overflowY = "auto";
    const row = document.createElement("div");
    row.tabIndex = -1;
    wrap.append(row);
    main.append(wrap);
    const dispose = installAppWorkspaceController({ root });
    rememberPointer(row);
    row.focus();
    aside.hidden = false;
    await window.happyDOM.whenAsyncComplete();
    detailKey(row, "F6");
    expect(document.activeElement === title).toBe(true);
    detailKey(title, "F6");
    expect(document.activeElement === row).toBe(true);
    title.focus();
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(document.activeElement === row).toBe(true);
    dispose();
  });

  test("levels ignore hidden handles and keep the shown-last pane flexible", () => {
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query === "(min-width: 48rem)", addEventListener() {}, removeEventListener() {} }),
    });
    const { root } = workspace({ width: 1024 });
    const main = document.createElement("div");
    main.className = "k2b-app-workspace__main";
    main.dataset.workspaceLevels = "";
    setRect(main, { width: 816, height: 700 });
    const handles: HTMLButtonElement[] = [];
    for (const [index, id] of ["sections", "items", "item"].entries()) {
      const pane = document.createElement("section");
      pane.id = id;
      pane.className = `k2b-app-workspace__main-pane ${index === 2 ? "is-primary" : ""}`;
      pane.dataset.workspaceLevel = String(index + 1);
      pane.dataset.workspaceLevelLast = index === 1 ? "1 2" : index === 2 ? "3" : "";
      pane.dataset.workspaceResizable = index === 2 ? "false" : "true";
      setRect(pane, { width: index === 0 ? 300 : 516, height: 700 });
      if (index === 2) pane.style.display = "none";
      main.append(pane);
      if (index === 2) continue;
      const handle = document.createElement("button");
      handle.dataset.appWorkspaceResize = "pane";
      handle.dataset.workspacePanelId = id;
      handle.dataset.workspaceResizeEdge = "end";
      handle.dataset.workspaceDefaultSize = "320";
      handle.dataset.workspaceMinSize = "200";
      handle.dataset.workspaceMaxSize = "720";
      handle.setAttribute("aria-controls", id);
      if (index === 1) handle.style.display = "none";
      main.append(handle);
      handles.push(handle);
    }
    root.append(main);
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { sections: 300, items: 600 } }),
      writeState: (state) => written.push(state),
    });
    try {
      flushFrames();
      expect(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")).toBe("300px");
      expect(root.style.getPropertyValue("--k2b-workspace-pane-items-width")).toBe("");
      dispatchKey(handles[1]!, "ArrowRight");
      expect(written).toEqual([]);
      // Even a mistakenly visible handle cannot turn the shown-last level into a fixed pane.
      handles[1]!.style.display = "block";
      dispatchKey(handles[1]!, "End");
      expect(written).toEqual([]);
      expect(root.style.getPropertyValue("--k2b-workspace-pane-items-width")).toBe("");
    } finally {
      dispose();
    }
  });

  test("pane limits reserve only the layout contribution of visible level separators in the same Main", () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const { root } = workspace({ width: 1440 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    main.dataset.workspaceLevels = "";
    setRect(main, { width: 1200, height: 700 });
    const handles: HTMLButtonElement[] = [];
    for (const [index, id] of ["sections", "items", "item"].entries()) {
      const pane = document.createElement("section");
      pane.id = id;
      pane.className = "k2b-app-workspace__main-pane";
      pane.dataset.workspaceLevel = String(index + 1);
      pane.dataset.workspaceLevelLast = index === 2 ? "1 2 3" : "";
      pane.dataset.workspaceResizable = index === 2 ? "false" : "true";
      setRect(pane, { width: index === 0 ? 320 : 400, height: 700 });
      main.append(pane);
      if (index === 2) continue;
      const handle = document.createElement("button");
      handle.className = "k2b-app-workspace__resize";
      handle.dataset.appWorkspaceResize = "pane";
      handle.dataset.workspacePanelId = id;
      handle.dataset.workspaceMinSize = "240";
      handle.dataset.workspaceMaxSize = "720";
      handle.setAttribute("aria-controls", id);
      handle.style.marginLeft = handle.style.marginRight = index === 0 ? "0px" : "-10px";
      setRect(handle, { width: index === 0 ? 44 : 20, height: 700 });
      main.append(handle);
      handles.push(handle);
    }
    const nested = document.createElement("main");
    nested.className = "k2b-app-workspace__main";
    main.append(nested);
    for (const parent of [main, nested]) {
      const separator = document.createElement("button");
      separator.className = "k2b-app-workspace__resize";
      separator.dataset.appWorkspaceResize = "pane";
      separator.style.marginLeft = separator.style.marginRight = "0px";
      separator.hidden = parent === main;
      setRect(separator, { width: 44, height: 700 });
      parent.append(separator);
    }
    root.append(main);
    const dispose = installAppWorkspaceController({ root });
    try {
      flushFrames();
      expect(handles[0]!.getAttribute("aria-valuemax")).toBe("436"); // 1200 - 400 - 320 - 44
      // Negative margins cancel the mouse separator's width entirely.
      setRect(handles[0]!, { width: 20, height: 700 });
      handles[0]!.style.marginLeft = handles[0]!.style.marginRight = "-10px";
      resizeObservers.forEach((observer) => observer.trigger());
      flushFrames();
      expect(handles[0]!.getAttribute("aria-valuemax")).toBe("480");
      // Every visible separator contributes, including the sibling's.
      setRect(handles[1]!, { width: 44, height: 700 });
      handles[1]!.style.marginLeft = handles[1]!.style.marginRight = "0px";
      resizeObservers.forEach((observer) => observer.trigger());
      flushFrames();
      expect(handles[0]!.getAttribute("aria-valuemax")).toBe("436");
    } finally {
      dispose();
    }
  });

  test("level visibility changes reconcile separator values without a detail transition", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query === "(min-width: 48rem)", addEventListener() {}, removeEventListener() {} }),
    });
    const { root } = workspace({ width: 1024 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    main.dataset.workspaceLevels = "";
    setRect(main, { width: 816, height: 700 });
    const pane = document.createElement("section");
    pane.id = "sections";
    pane.className = "k2b-app-workspace__main-pane";
    pane.dataset.workspaceLevel = "1";
    pane.dataset.workspaceLevelShown = "1 2 3";
    pane.dataset.workspaceResizable = "true";
    // Happy DOM has no flex layout: mimic the width after switching levels.
    setDynamicRect(pane, () => ({ width: pane.dataset.workspaceLevelShown === "2 3" ? 360 : 300, height: 700 }));
    const handle = document.createElement("button");
    handle.className = "k2b-app-workspace__resize";
    handle.dataset.appWorkspaceResize = "pane";
    handle.dataset.workspacePanelId = "sections";
    handle.setAttribute("aria-controls", pane.id);
    main.append(pane, handle);
    root.append(main);
    const detail = document.createElement("aside");
    detail.className = "k2b-app-workspace__detail";
    let detailVisibilityReads = 0;
    // detailTransition reads hidden even when visibility has not changed.
    Object.defineProperty(detail, "hidden", {
      get: () => {
        detailVisibilityReads++;
        return false;
      },
    });
    root.append(detail);
    const dispose = installAppWorkspaceController({ root });
    try {
      flushFrames();
      flushFrames();
      expect(handle.getAttribute("aria-valuenow")).toBe("300");
      detailVisibilityReads = 0;
      pane.dataset.workspaceLevelShown = "2 3";
      await window.happyDOM.whenAsyncComplete();
      expect(frames.size).toBe(1);
      flushFrames();
      expect(handle.getAttribute("aria-valuenow")).toBe("360");
      expect(detailVisibilityReads).toBe(0);
      // The newly observed attribute must not enter the detail transition path,
      // even when it is set on a detail element.
      detail.dataset.workspaceLevelShown = "2 3";
      await window.happyDOM.whenAsyncComplete();
      flushFrames();
      expect(detailVisibilityReads).toBe(0);
    } finally {
      dispose();
    }
  });

  for (const reflow of [false, true])
    test(`keyboard resizing settles CSS-shrunk fixed levels to their rendered widths${reflow ? " through flex reflow" : ""}`, () => {
      Object.defineProperty(window, "matchMedia", {
        value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      });
      const { root } = workspace({ width: 1440 });
      const main = document.createElement("main");
      main.className = "k2b-app-workspace__main";
      main.dataset.workspaceLevels = "";
      setRect(main, { width: 1200, height: 700 });
      const handles: HTMLButtonElement[] = [];
      for (const [index, [id, width]] of (
        [
          ["sections", 480],
          ["items", 400],
          ["item", 320],
        ] as const
      ).entries()) {
        const pane = document.createElement("section");
        pane.id = id;
        pane.className = `k2b-app-workspace__main-pane ${index === 2 ? "is-primary" : ""}`;
        pane.dataset.workspaceLevel = String(index + 1);
        pane.dataset.workspaceLevelLast = index === 2 ? "1 2 3" : "";
        pane.dataset.workspacePanelId = id;
        pane.dataset.workspaceResizable = index === 2 ? "false" : "true";
        setRect(pane, { width, height: 700 });
        if (reflow && index !== 2) {
          // Happy DOM has no flex layout: shrink the fixed bases into the 880 px left beside the primary.
          setDynamicRect(pane, () => {
            const sections = Number.parseFloat(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")) || 720;
            const items = Number.parseFloat(root.style.getPropertyValue("--k2b-workspace-pane-items-width")) || 640;
            return { width: ((index === 0 ? sections : items) * 880) / Math.max(880, sections + items), height: 700 };
          });
        }
        main.append(pane);
        if (index === 2) continue;
        const handle = document.createElement("button");
        handle.dataset.appWorkspaceResize = "pane";
        handle.dataset.workspacePanelId = id;
        handle.dataset.workspaceResizeEdge = "end";
        handle.dataset.workspaceDefaultSize = "320";
        handle.dataset.workspaceMinSize = "240";
        handle.dataset.workspaceMaxSize = "720";
        handle.setAttribute("aria-controls", id);
        main.append(handle);
        handles.push(handle);
      }
      root.append(main);
      const written: unknown[] = [];
      const dispose = installAppWorkspaceController({
        root,
        readState: () => ({ version: 2, paneWidths: { sections: 720, items: 640 } }),
        writeState: (state) => written.push(state),
      });
      try {
        flushFrames();
        expect(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")).toBe("720px");
        expect(root.style.getPropertyValue("--k2b-workspace-pane-items-width")).toBe("640px");
        const sectionsWidth = Math.round(main.querySelector<HTMLElement>("#sections")!.getBoundingClientRect().width);
        const itemsWidth = Math.round(main.querySelector<HTMLElement>("#items")!.getBoundingClientRect().width);
        dispatchKey(handles[0]!, "ArrowLeft");
        expect(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")).toBe(`${sectionsWidth - 8}px`);
        expect(root.style.getPropertyValue("--k2b-workspace-pane-items-width")).toBe(`${itemsWidth}px`);
        expect(written).toEqual([expect.objectContaining({ paneWidths: { sections: sectionsWidth - 8, items: itemsWidth } })]);
      } finally {
        dispose();
      }
    });

  test("a key step or drag that the limits stop keeps every level preference", () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const { root } = workspace({ width: 1440 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    main.dataset.workspaceLevels = "";
    setRect(main, { width: 800, height: 700 });
    // CSS has shrunk both stored widths (720 and 640) to the 240 px minimum.
    const handles: HTMLButtonElement[] = [];
    for (const [index, id] of ["sections", "items", "item"].entries()) {
      const pane = document.createElement("section");
      pane.id = id;
      pane.className = `k2b-app-workspace__main-pane ${index === 2 ? "is-primary" : ""}`;
      pane.dataset.workspaceLevel = String(index + 1);
      pane.dataset.workspaceLevelLast = index === 2 ? "1 2 3" : "";
      pane.dataset.workspacePanelId = id;
      pane.dataset.workspaceResizable = index === 2 ? "false" : "true";
      setRect(pane, { width: index === 2 ? 320 : 240, height: 700 });
      main.append(pane);
      if (index === 2) continue;
      const handle = document.createElement("button");
      handle.dataset.appWorkspaceResize = "pane";
      handle.dataset.workspacePanelId = id;
      handle.dataset.workspaceResizeEdge = "end";
      handle.dataset.workspaceDefaultSize = "320";
      handle.dataset.workspaceMinSize = "240";
      handle.dataset.workspaceMaxSize = "720";
      handle.setAttribute("aria-controls", id);
      main.append(handle);
      handles.push(handle);
    }
    root.append(main);
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { sections: 720, items: 640 } }),
      writeState: (state) => written.push(state),
    });
    try {
      flushFrames();
      dispatchKey(handles[0]!, "ArrowLeft");
      dispatchKey(handles[0]!, "Home");
      for (const clientX of [610, 590]) {
        handles[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 600 }));
        window.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX }));
        flushFrames();
        window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, clientX }));
        flushFrames();
      }
      expect(written).toEqual([]);
      expect(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")).toBe("720px");
      expect(root.style.getPropertyValue("--k2b-workspace-pane-items-width")).toBe("640px");
    } finally {
      dispose();
    }
  });

  test("a level without a separator keeps its width while a sibling resizes, and a press alone stores nothing", () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const { root } = workspace({ width: 1440 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    main.dataset.workspaceLevels = "";
    setRect(main, { width: 1200, height: 700 });
    // Happy DOM has no flex layout. The stylesheet keeps a level without a
    // separator at its width, so only the resizable level gives way to the
    // 880 px left beside the last level.
    const sectionsWidth = () =>
      Math.min(Number.parseFloat(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")) || 720, 880 - 320);
    let handle: HTMLButtonElement | undefined;
    for (const [index, id] of ["sections", "items", "item"].entries()) {
      const pane = document.createElement("section");
      pane.id = id;
      pane.className = `k2b-app-workspace__main-pane ${index === 2 ? "is-primary" : ""}`;
      pane.dataset.workspaceLevel = String(index + 1);
      pane.dataset.workspaceLevelLast = index === 2 ? "1 2 3" : "";
      pane.dataset.workspacePanelId = id;
      pane.dataset.workspaceResizable = index === 0 ? "true" : "false";
      if (index === 0) setDynamicRect(pane, () => ({ width: sectionsWidth(), height: 700 }));
      else setRect(pane, { width: 320, height: 700 });
      main.append(pane);
      if (index !== 0) continue;
      handle = document.createElement("button");
      handle.dataset.appWorkspaceResize = "pane";
      handle.dataset.workspacePanelId = id;
      handle.dataset.workspaceResizeEdge = "end";
      handle.dataset.workspaceDefaultSize = "320";
      handle.dataset.workspaceMinSize = "240";
      handle.dataset.workspaceMaxSize = "720";
      handle.setAttribute("aria-controls", id);
      main.append(handle);
    }
    root.append(main);
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { sections: 720 } }),
      writeState: (state) => written.push(state),
    });
    try {
      flushFrames();
      expect(sectionsWidth()).toBe(560);
      // A press and release without movement keeps the stored preference.
      handle!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 600 }));
      window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, clientX: 600 }));
      flushFrames();
      expect(written).toEqual([]);
      expect(root.style.getPropertyValue("--k2b-workspace-pane-sections-width")).toBe("720px");
      dispatchKey(handle!, "ArrowLeft");
      expect(sectionsWidth()).toBe(552);
      expect(root.style.getPropertyValue("--k2b-workspace-pane-items-width")).toBe("");
      expect(written).toEqual([expect.objectContaining({ paneWidths: { sections: 552 } })]);
    } finally {
      dispose();
    }
  });

  test("double-click resets a pane and preserves other pane preferences", () => {
    const { root } = workspace({ width: 1500 });
    const main = document.createElement("div");
    main.className = "k2b-app-workspace__main";
    setRect(main, { width: 1200, height: 700 });
    const pane = document.createElement("section");
    pane.id = "list-pane";
    pane.className = "k2b-app-workspace__main-pane";
    pane.dataset.workspaceResizable = "true";
    const variable = "--k2b-workspace-pane-list-width";
    setDynamicRect(pane, () => ({ width: Number.parseFloat(root.style.getPropertyValue(variable)) || 320, height: 700 }));
    const handle = document.createElement("button");
    handle.dataset.appWorkspaceResize = "pane";
    handle.dataset.workspacePanelId = "list";
    handle.dataset.workspaceDefaultSize = "320";
    handle.dataset.workspaceMinSize = "200";
    handle.dataset.workspaceMaxSize = "720";
    handle.setAttribute("aria-controls", pane.id);
    main.append(pane, handle);
    root.append(main);
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { list: 500, other: 420 } }),
      writeState: (state) => written.push(state),
    });
    try {
      flushFrames();
      expect(root.style.getPropertyValue(variable)).toBe("500px");
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      // Reconciliation applies the default width after removing the stored preference.
      expect(root.style.getPropertyValue(variable)).toBe("320px");
      expect(handle.getAttribute("aria-valuenow")).toBe("320");
      expect(written.at(-1)).toMatchObject({ paneWidths: { other: 420 } });
    } finally {
      dispose();
    }
  });

  test("double-click refits sibling panes around the default and preserves the primary minimum", () => {
    const { root } = workspace({ width: 1000 });
    const main = document.createElement("main");
    main.className = "k2b-app-workspace__main";
    setRect(main, { width: 1000, height: 700 });
    const variables = ["--k2b-workspace-pane-list-width", "--k2b-workspace-pane-other-width"];
    const handles: HTMLButtonElement[] = [];
    for (const [index, id] of ["list", "other"].entries()) {
      const pane = document.createElement("section");
      pane.id = `${id}-pane`;
      pane.className = "k2b-app-workspace__main-pane";
      pane.dataset.workspaceResizable = "true";
      setDynamicRect(pane, () => ({ width: Number.parseFloat(root.style.getPropertyValue(variables[index]!)) || 320, height: 700 }));
      const handle = document.createElement("button");
      handle.dataset.appWorkspaceResize = "pane";
      handle.dataset.workspacePanelId = id;
      handle.dataset.workspaceDefaultSize = "320";
      handle.dataset.workspaceMinSize = "240";
      handle.dataset.workspaceMaxSize = "640";
      handle.setAttribute("aria-controls", pane.id);
      main.append(pane, handle);
      handles.push(handle);
    }
    const primary = document.createElement("section");
    primary.className = "k2b-app-workspace__main-primary";
    setDynamicRect(primary, () => ({
      width: 1000 - variables.reduce((total, variable) => total + Number.parseFloat(root.style.getPropertyValue(variable)), 0),
      height: 700,
    }));
    main.append(primary);
    root.append(main);
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, paneWidths: { list: 240, other: 640 } }),
      writeState: (state) => written.push(state),
    });
    try {
      flushFrames();
      expect(variables.map((variable) => root.style.getPropertyValue(variable))).toEqual(["240px", "440px"]);
      expect(primary.getBoundingClientRect().width).toBe(320);
      handles[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const fitted = fitAppWorkspacePaneSizes(
        [
          { desired: 320, min: 240 },
          { desired: 640, min: 240 },
        ],
        1000 - 320,
      );
      expect(variables.map((variable) => root.style.getPropertyValue(variable))).toEqual(fitted.map((width) => `${width}px`));
      expect(primary.getBoundingClientRect().width).toBe(320);
      expect(written.at(-1)).toMatchObject({ paneWidths: { other: 640 } });
    } finally {
      dispose();
    }
  });

  test("double-click resets only the selected detail width and writes the remaining state", () => {
    const { root, handle } = detailWorkspace();
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, detailWidths: { record: 500, other: 420 } }),
      writeState: (state) => written.push(state),
    });
    flushFrames();
    expect(root.style.getPropertyValue("--k2b-workspace-detail-record-width")).toBe("500px");
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(root.style.getPropertyValue("--k2b-workspace-detail-record-width")).toBe("");
    expect(handle.getAttribute("aria-valuenow")).toBe("416");
    expect(written.at(-1)).toMatchObject({ detailWidths: { other: 420 } });
    dispose();
  });

  test("double-click overrides an inherited persisted width with the default", () => {
    const { root, handle } = detailWorkspace();
    const parent = document.createElement("div");
    const variable = "--k2b-workspace-detail-record-width";
    parent.style.setProperty(variable, "500px");
    document.body.append(parent);
    parent.append(root);
    // happy-dom does not inherit custom properties in computed styles.
    const readStyle = getComputedStyle;
    globalThis.getComputedStyle = (element) => {
      const style = readStyle(element);
      if (element !== root) return style;
      const readProperty = style.getPropertyValue.bind(style);
      style.getPropertyValue = (name) =>
        name === variable ? root.style.getPropertyValue(name) || parent.style.getPropertyValue(name) : readProperty(name);
      return style;
    };
    const written: unknown[] = [];
    const dispose = installAppWorkspaceController({
      root,
      readState: () => ({ version: 2, detailWidths: { record: 500, other: 420 } }),
      writeState: (state) => written.push(state),
    });
    flushFrames();
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(root.style.getPropertyValue(variable)).toBe(`${APP_WORKSPACE_DETAIL_DEFAULT}px`);
    expect(written.at(-1)).toMatchObject({ detailWidths: { other: 420 } });
    expect(written.at(-1)).not.toMatchObject({ detailWidths: { record: 500 } });
    dispose();
  });

  test("sync prunes detached detail, title, and motion cleanup references", async () => {
    const { root, aside, item, title } = detailWorkspace({ open: false });
    const dispose = installAppWorkspaceController({ root: document });
    item.focus();
    detailKey(item, "Enter");
    aside.hidden = false;
    await window.happyDOM.whenAsyncComplete();
    flushFrames();
    flushFrames();
    root.remove();
    const inserted = detailWorkspace().root;
    await window.happyDOM.whenAsyncComplete();
    aside.style.setProperty("--k2b-workspace-detail-sheet-height", "123px");
    expect(() => dispose()).not.toThrow();
    expect(aside.style.getPropertyValue("--k2b-workspace-detail-sheet-height")).toBe("123px");
    expect(title.getAttribute("tabindex")).toBe("-1");
    expect(root.dataset.workspaceMotion).toBe("true");
    expect(inserted.dataset.workspaceMotion).toBeUndefined();
  });
});

describe("floating detail layout changes", () => {
  for (const mode of ["sheet", "drawer"]) {
    test(`${mode} touch drags leave controls and owned gestures alone`, () => {
      Object.defineProperty(window, "matchMedia", {
        value: (query: string) => ({
          matches: mode === "sheet" ? query === "(max-width: 47.999rem)" : query === "(min-width: 48rem)",
          addEventListener() {},
          removeEventListener() {},
        }),
      });
      const { root, aside, closed } = detailWorkspace();
      const range = document.createElement("input");
      range.type = "range";
      const owned = document.createElement("div");
      owned.style.setProperty("touch-action", "none");
      const text = document.createElement("span");
      text.textContent = "Gesture-owned text";
      owned.append(text);
      const otherAxis = document.createElement("div");
      otherAxis.style.setProperty("touch-action", mode === "sheet" ? "pan-left pan-right" : "pan-up pan-down");
      const plain = document.createElement("span");
      plain.textContent = "Plain text";
      aside.append(range, owned, otherAxis, plain);
      const dispose = installAppWorkspaceController({ root });
      const swipe = (target: HTMLElement) => {
        detailTouch(target, "touchstart", 0, 0);
        const move = detailTouch(target, "touchmove", mode === "drawer" ? 100 : 0, mode === "sheet" ? 100 : 0);
        flushFrames();
        detailTouch(target, "touchend", 100, 100);
        return move;
      };
      for (const target of [range, text, otherAxis]) {
        expect(swipe(target).defaultPrevented).toBe(false);
        expect(closed).toHaveLength(0);
      }
      for (const action of ["auto", "manipulation", "pan-x pan-y"]) {
        if (mode === "drawer") aside.dataset.workspaceDetailDrawer = "open";
        plain.style.setProperty("touch-action", action);
        expect(swipe(plain).defaultPrevented).toBe(true);
      }
      expect(closed).toHaveLength(mode === "sheet" ? 3 : 0);
      if (mode === "drawer") expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      dispose();
    });
  }

  test("phone sheet drag height is bounded by the viewport instead of Content", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query === "(max-width: 47.999rem)", addEventListener() {}, removeEventListener() {} }),
    });
    const { root, content, aside } = detailWorkspace();
    setRect(content, { height: 200, width: 390 });
    setRect(aside, { height: 440, width: 390 });
    const grabber = document.createElement("button");
    grabber.className = "k2b-app-workspace__detail-grabber";
    aside.prepend(grabber);
    const dispose = installAppWorkspaceController({ root });
    grabber.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 9, clientY: 600 }));
    window.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 9, clientY: -500 }));
    flushFrames();
    expect(aside.style.getPropertyValue("--k2b-workspace-detail-sheet-height")).toBe("792px");
    window.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 9 }));
    dispose();
  });

  for (const [scrollOwner, bottom] of [
    ["document", 500],
    ["document", 300],
    ["Main", 500],
  ] as const) {
    test(`phone reveal scrolls ${scrollOwner} only for the overlap of an item ending at ${bottom}px`, async () => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
      Object.defineProperty(window, "matchMedia", {
        value: (query: string) => ({ matches: query === "(max-width: 47.999rem)", addEventListener() {}, removeEventListener() {} }),
      });
      const { root, main, aside, item } = detailWorkspace({ open: false });
      Object.defineProperty(aside, "offsetHeight", { value: 440 });
      setRect(item, { width: 100, height: bottom });
      const scrolls: ScrollToOptions[] = [];
      if (scrollOwner === "Main") {
        main.style.overflowY = "auto";
        Object.defineProperties(main, { scrollHeight: { value: 1200 }, clientHeight: { value: 800 } });
      }
      const scroller = scrollOwner === "Main" ? main : document.scrollingElement;
      Object.defineProperty(scroller, "scrollBy", { value: (options: ScrollToOptions) => scrolls.push(options) });
      let reveals = 0;
      item.scrollIntoView = () => reveals++;
      const dispose = installAppWorkspaceController({ root });
      rememberPointer(item);
      aside.hidden = false;
      await window.happyDOM.whenAsyncComplete();
      flushFrames();
      // A document that scrolls both ways gets one call; a zero left keeps it in place sideways.
      expect(scrolls).toEqual(bottom === 500 ? [expect.objectContaining({ top: 148, behavior: "smooth" })] : []);
      expect(scrolls.every((scroll) => !scroll.left)).toBe(true);
      expect(reveals).toBe(0);
      dispose();
    });
  }

  test("anchors a selected row through reflow only when its scroll position was untouched", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query === "(min-width: 48rem)", addEventListener() {}, removeEventListener() {} }),
    });
    const { root, main, item, aside } = detailWorkspace({ open: false });
    main.style.overflowY = "auto";
    Object.defineProperties(main, { scrollHeight: { value: 1000 }, clientHeight: { value: 500 } });
    main.scrollTop = 100;
    Object.defineProperty(item, "getBoundingClientRect", { value: () => ({ top: (aside.hidden ? 100 : 180) - main.scrollTop }) });
    let reveals = 0;
    item.scrollIntoView = () => {
      reveals++;
    };
    const dispose = installAppWorkspaceController({ root });
    rememberPointer(item);
    aside.hidden = false;
    await window.happyDOM.whenAsyncComplete();
    expect(main.scrollTop).toBe(180);
    expect(reveals).toBe(0);
    flushFrames();
    expect(reveals).toBe(1);
    rememberPointer(aside);
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(main.scrollTop).toBe(100);
    rememberPointer(item);
    main.scrollTop = 120;
    aside.hidden = false;
    await window.happyDOM.whenAsyncComplete();
    expect(main.scrollTop).toBe(120);
    dispose();
  });

  test("anchors a closing panel only after its motion releases the detail column", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query === "(min-width: 48rem)", addEventListener() {}, removeEventListener() {} }),
    });
    const { root, main, item, aside } = detailWorkspace();
    root.dataset.workspaceMotion = "true";
    main.style.overflowY = "auto";
    Object.defineProperties(main, { scrollHeight: { value: 1000 }, clientHeight: { value: 500 } });
    main.scrollTop = 180;
    let columnReleased = false;
    Object.defineProperty(item, "getBoundingClientRect", {
      value: () => ({ top: (columnReleased ? 100 : 180) - main.scrollTop }),
    });
    const dispose = installAppWorkspaceController({ root });
    rememberPointer(item);
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(main.scrollTop).toBe(180);
    columnReleased = true;
    const transition = (propertyName: string) => {
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: propertyName });
      return event;
    };
    root.dispatchEvent(transition("opacity"));
    aside.dispatchEvent(transition("--k2b-workspace-detail-track"));
    expect(main.scrollTop).toBe(180);
    root.dispatchEvent(transition("--k2b-workspace-detail-track"));
    expect(main.scrollTop).toBe(100);
    root.dispatchEvent(transition("--k2b-workspace-detail-track"));
    expect(main.scrollTop).toBe(100);
    dispose();
  });

  test("phone grabber drags settle at detents, suppress their click, and clean up on cancellation", () => {
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query === "(max-width: 47.999rem)", addEventListener() {}, removeEventListener() {} }),
    });
    const { root, aside, closed } = detailWorkspace();
    const grabber = document.createElement("button");
    grabber.className = "k2b-app-workspace__detail-grabber";
    grabber.setAttribute("aria-pressed", "false");
    aside.prepend(grabber);
    setRect(aside, { height: 385, width: 390 });
    const dispose = installAppWorkspaceController({ root });
    grabber.click();
    expect(aside.dataset.workspaceDetailSheet).toBe("full");
    const drag = (dy: number, cancelled = false) => {
      grabber.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 9, clientY: 100 }));
      window.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 9, clientY: 100 + dy }));
      flushFrames();
      expect(aside.dataset.workspaceDetailDragging).toBe("true");
      expect(aside.style.getPropertyValue("--k2b-workspace-detail-sheet-height")).not.toBe("");
      window.dispatchEvent(new window.PointerEvent(cancelled ? "pointercancel" : "pointerup", { pointerId: 9, clientY: 100 + dy }));
      grabber.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    };
    drag(100);
    expect(aside.dataset.workspaceDetailSheet).toBeUndefined();
    expect(closed).toHaveLength(0);
    drag(-100);
    expect(aside.dataset.workspaceDetailSheet).toBe("full");
    drag(100, true);
    expect(aside.dataset.workspaceDetailSheet).toBe("full");
    grabber.click();
    drag(100);
    expect(closed).toHaveLength(1);
    expect(aside.style.getPropertyValue("--k2b-workspace-detail-sheet-height")).toBe("");
    expect(aside.hasAttribute("data-workspace-detail-dragging")).toBe(false);
    dispose();
    expect(grabber.getAttribute("aria-pressed")).toBe("false");
  });

  test("detail resize limits include the root column and reserve its end inset", () => {
    const { root, content, handle } = detailWorkspace();
    setRect(root, { width: 900, height: 700 });
    setRect(content, { width: 480, height: 700 });
    const second = document.createElement("aside");
    second.className = "k2b-app-workspace__detail";
    setRect(second, { width: 416, height: 684 });
    content.append(second);
    const dispose = installAppWorkspaceController({ root });
    flushFrames();
    expect(handle.getAttribute("aria-valuemax")).toBe("572");
    dispose();
  });
});

test("opening a floating detail keeps a wide persisted sidebar within its own budget", async () => {
  const { root, aside, sidebar } = detailWorkspace({ open: false });
  setRect(root, { height: 700, width: 1024 });
  setRect(sidebar, { height: 700, width: 500 });
  const sidebarHandle = root.querySelector<HTMLElement>("[data-app-workspace-resize='sidebar']")!;
  sidebarHandle.dataset.workspaceMaxSize = "960";
  const dispose = installAppWorkspaceController({ root, readState: () => ({ version: 2, sidebarWidth: 500 }) });
  flushFrames();
  expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("500px");
  aside.hidden = false;
  await window.happyDOM.whenAsyncComplete();
  flushFrames();
  expect(root.style.getPropertyValue("--k2b-workspace-sidebar-width")).toBe("500px");
  expect(sidebarHandle.getAttribute("aria-valuemax")).toBe("704");
  dispose();
});

test("a nested workspace's Main chooses its own open detail instead of the surrounding aside", () => {
  const outer = detailWorkspace();
  const inner = detailWorkspace();
  outer.aside.append(inner.root);
  const dispose = installAppWorkspaceController({ root: document });
  detailKey(inner.item, "Escape");
  expect(inner.closed).toHaveLength(1);
  expect(outer.closed).toHaveLength(0);
  dispose();
});

describe("waiting detail drawers", () => {
  const mainRow = (item: HTMLElement) => {
    const row = document.createElement("div");
    item.replaceWith(row);
    row.append(item);
    return row;
  };
  const waitingWorkspace = () => {
    const fixture = detailWorkspace();
    const toggle = document.createElement("button");
    toggle.dataset.appWorkspaceDetailToggle = "";
    toggle.setAttribute("aria-controls", fixture.aside.id);
    toggle.setAttribute("aria-expanded", "false");
    fixture.content.insertBefore(toggle, fixture.handle);
    fixture.aside.style.setProperty("--k2b-workspace-detail-waiting", "1");
    return { ...fixture, toggle };
  };

  for (const interaction of ["pointer", "Enter", " ", "assistive"] as const) {
    test(`a parked open Detail reopens after a marked ${interaction} choice settles`, async () => {
      const { root, aside, item, title, toggle } = waitingWorkspace();
      let reveals = 0;
      item.scrollIntoView = () => reveals++;
      const dispose = installAppWorkspaceController({ root });
      try {
        toggle.click();
        detailKey(toggle, "Escape");
        if (interaction === "pointer") {
          rememberPointer(item);
          item.focus(); // Native pointer focus follows pointerdown before the click updates content.
        } else if (interaction === "assistive") item.click();
        else {
          item.focus();
          detailKey(item, interaction);
        }
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
        // Selection may be on the item or its row, and may change in the click handler.
        if (interaction === "Enter") mainRow(item).setAttribute("aria-current", "page");
        else item.setAttribute("aria-selected", "true");
        title.textContent = "Another contact";
        if (interaction === "pointer") item.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
        // Space activates on release; a held key may span many frames first.
        if (interaction === " ") {
          flushFrames();
          flushFrames();
          expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
          item.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        }
        await window.happyDOM.whenAsyncComplete();
        flushFrames();
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
        flushFrames();
        flushFrames(); // Reveal follows the drawer opening.
        expect(aside.dataset.workspaceDetailDrawer).toBe("open");
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement === (interaction === "pointer" ? item : title)).toBe(true);
        expect(reveals).toBe(1);
        parkWorkspaceDetailDrawers(root);
        title.textContent = "Live update after the one-shot watch";
        await window.happyDOM.whenAsyncComplete();
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      } finally {
        dispose();
      }
    });
  }

  for (const gesture of [
    "click",
    "unmarked click",
    "false current",
    "secondary button",
    "cancelled",
    "cancelled after click",
    "roving row",
    "data-selected row",
    "modified click",
    "Main marked",
  ] as const) {
    test(`choosing the selected item again: ${gesture}`, async () => {
      const { root, main, aside, item, toggle } = waitingWorkspace();
      // A collection row with a roving tab index, as in FileGrid or DataTable.
      const row = document.createElement("div");
      row.tabIndex = -1;
      row.textContent = "Selected row";
      main.append(row);
      const target = gesture === "roving row" ? row : item;
      if (gesture === "false current") target.setAttribute("aria-current", "false");
      else if (gesture === "Main marked") main.setAttribute("aria-current", "page");
      // DataTable and Calendar mark their selected row or day with data-selected.
      else if (gesture === "data-selected row") mainRow(item).setAttribute("data-selected", "true");
      else if (gesture !== "unmarked click") target.setAttribute("aria-selected", "true");
      const dispose = installAppWorkspaceController({ root });
      try {
        toggle.click();
        detailKey(toggle, "Escape");
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: gesture === "secondary button" ? 2 : 0,
            ctrlKey: gesture === "modified click",
          }),
        );
        if (gesture === "cancelled") target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
        else target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: gesture === "secondary button" ? 2 : 0, detail: 1 }));
        if (gesture === "cancelled after click") target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
        flushFrames();
        flushFrames();
        const opens = gesture === "click" || gesture === "roving row" || gesture === "data-selected row";
        expect(aside.dataset.workspaceDetailDrawer).toBe(opens ? "open" : undefined);
      } finally {
        dispose();
      }
    });
  }

  for (const nested of ["disclosure button", "row link"] as const) {
    test(`a ${nested} inside a selected row ${nested === "row link" ? "reopens" : "leaves"} a parked Detail`, async () => {
      const { root, aside, item, toggle } = waitingWorkspace();
      const row = mainRow(item);
      row.setAttribute("aria-selected", "true");
      const control = document.createElement(nested === "row link" ? "a" : "button");
      if (nested === "row link") control.setAttribute("href", "#file");
      else control.setAttribute("aria-expanded", "false");
      row.append(control);
      const dispose = installAppWorkspaceController({ root });
      try {
        toggle.click();
        detailKey(toggle, "Escape");
        control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        control.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
        flushFrames();
        flushFrames();
        expect(aside.dataset.workspaceDetailDrawer).toBe(nested === "row link" ? "open" : undefined);
      } finally {
        dispose();
      }
    });
  }

  test("a keyboard reopen moves focus to the title that replaces the previous one", async () => {
    const { root, aside, item, title, toggle } = waitingWorkspace();
    const dispose = installAppWorkspaceController({ root });
    try {
      toggle.click();
      detailKey(toggle, "Escape");
      item.focus();
      detailKey(item, "Enter");
      item.setAttribute("aria-selected", "true");
      flushFrames();
      flushFrames();
      expect(aside.dataset.workspaceDetailDrawer).toBe("open");
      expect(document.activeElement === title).toBe(true);
      // The new selection's content arrives later and replaces the heading.
      const next = document.createElement("h2");
      next.textContent = "Loaded contact";
      title.replaceWith(next);
      await window.happyDOM.whenAsyncComplete();
      expect(document.activeElement === next).toBe(true);
    } finally {
      dispose();
    }
  });

  test("an unmarked toolbar click and a later live update keep an open Detail parked", async () => {
    const { root, main, aside, title } = waitingWorkspace();
    const toolbar = document.createElement("button");
    main.prepend(toolbar);
    const dispose = installAppWorkspaceController({ root });
    try {
      rememberPointer(toolbar);
      toolbar.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      flushFrames();
      flushFrames();
      title.textContent = "Live contact update";
      await window.happyDOM.whenAsyncComplete();
      flushFrames();
      flushFrames();
      expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
    } finally {
      dispose();
    }
  });

  for (const key of ["Enter", " "]) {
    test(`the native click after ${key} does not create a second choice`, async () => {
      const { root, aside, item } = waitingWorkspace();
      const dispose = installAppWorkspaceController({ root });
      try {
        detailKey(item, key);
        flushFrames();
        item.click();
        flushFrames(); // The key's unmarked check ends here; the click must not restart it.
        item.setAttribute("aria-current", "page");
        // A second native click must not have left another check behind.
        flushFrames();
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
        item.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
        flushFrames();
        item.click(); // A subsequent assistive click is its own activation.
        flushFrames();
        flushFrames();
        expect(aside.dataset.workspaceDetailDrawer).toBe("open");
      } finally {
        dispose();
      }
    });
  }

  test("a choice that another interaction replaced does not open a Detail that opens later", async () => {
    const { root, aside, item, title } = waitingWorkspace();
    // Focus leaves the workspace, for example to the host's search field.
    const other = document.createElement("button");
    other.textContent = "Elsewhere";
    document.body.append(other);
    aside.hidden = true;
    const dispose = installAppWorkspaceController({ root });
    try {
      item.focus();
      detailKey(item, "Enter");
      other.focus();
      aside.hidden = false;
      await window.happyDOM.whenAsyncComplete();
      expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      expect(document.activeElement === other).toBe(true);
      expect(document.activeElement === title).toBe(false);
    } finally {
      dispose();
      other.remove();
    }
  });

  for (const cancellation of [
    "pointer",
    "Detail pointer",
    "key",
    "focus",
    "assistive elsewhere",
    "hidden",
    "removed",
    "not waiting",
    "dispose",
  ] as const) {
    test(`a pending ARIA check is cancelled by ${cancellation}`, async () => {
      const { root, aside, item, title } = waitingWorkspace();
      const outside = document.createElement("button");
      document.body.append(outside);
      const dispose = installAppWorkspaceController({ root });
      try {
        item.setAttribute("aria-selected", "true");
        rememberPointer(item);
        item.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
        if (cancellation === "pointer") rememberPointer(outside);
        if (cancellation === "Detail pointer") rememberPointer(title);
        if (cancellation === "key") detailKey(outside, "Tab");
        if (cancellation === "focus") outside.focus();
        if (cancellation === "assistive elsewhere") outside.click();
        if (cancellation === "hidden") aside.hidden = true;
        if (cancellation === "removed") aside.remove();
        if (cancellation === "not waiting") {
          aside.style.removeProperty("--k2b-workspace-detail-waiting");
          resizeObservers.forEach((observer) => observer.trigger());
          flushFrames();
        }
        if (cancellation === "dispose") dispose();
        await window.happyDOM.whenAsyncComplete();
        // Reusing the same aside must not revive an abandoned interaction.
        aside.hidden = false;
        if (!aside.isConnected) root.append(aside);
        aside.style.setProperty("--k2b-workspace-detail-waiting", "1");
        title.textContent = "Live contact update";
        await window.happyDOM.whenAsyncComplete();
        flushFrames();
        flushFrames();
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      } finally {
        if (cancellation !== "dispose") dispose();
      }
    });
  }

  for (const source of ["Detail", "outside Main", "focus only", "editor Enter", "editor Space", "editor pointer"] as const) {
    test(`${source} does not choose an item`, async () => {
      const { root, main, aside, item, title } = waitingWorkspace();
      const input = document.createElement("input");
      main.append(input);
      const dispose = installAppWorkspaceController({ root });
      try {
        if (source === "Detail") rememberPointer(title);
        else if (source === "outside Main") rememberPointer(root);
        else if (source === "focus only") item.focus();
        else if (source === "editor pointer") rememberPointer(input);
        else detailKey(input, source === "editor Enter" ? "Enter" : " ");
        title.textContent = "Live contact update";
        await window.happyDOM.whenAsyncComplete();
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      } finally {
        dispose();
      }
    });
  }

  for (const interaction of ["pointer", "keyboard", "assistive", "none", "focus only"] as const) {
    test(`a waiting detail opened after ${interaction} interaction uses the drawer only for a fresh Main selection`, async () => {
      const { root, aside, item, title, toggle, content } = waitingWorkspace();
      aside.hidden = true;
      const dispose = installAppWorkspaceController({ root });
      try {
        const chosen = interaction === "pointer" || interaction === "keyboard" || interaction === "assistive";
        if (interaction !== "none") {
          item.focus();
          if (interaction === "pointer") rememberPointer(item);
          else if (interaction === "keyboard") detailKey(item, "Enter");
          else if (interaction === "assistive") item.click();
        }
        aside.hidden = false;
        await window.happyDOM.whenAsyncComplete();
        expect(aside.dataset.workspaceDetailDrawer).toBe(chosen ? "open" : undefined);
        expect(toggle.getAttribute("aria-expanded")).toBe(chosen ? "true" : "false");
        if (chosen) {
          expect(content.style.getPropertyValue("--k2b-detail-space")).toBe("416px");
          expect(document.activeElement === (interaction === "pointer" ? item : title)).toBe(true);
        }
      } finally {
        dispose();
      }
    });
  }

  test("parking affects only drawers under the requested root, and rescues only focus inside a drawer", () => {
    const first = waitingWorkspace();
    const second = waitingWorkspace();
    for (const fixture of [first, second]) {
      fixture.aside.dataset.workspaceDetailDrawer = "open";
      fixture.toggle.setAttribute("aria-expanded", "true");
    }
    first.close.focus();
    parkWorkspaceDetailDrawers(first.root);
    expect(first.aside.dataset.workspaceDetailDrawer).toBeUndefined();
    expect(first.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement === first.toggle).toBe(true);
    expect(second.aside.dataset.workspaceDetailDrawer).toBe("open");
    first.item.focus();
    parkWorkspaceDetailDrawers();
    expect(document.activeElement === first.item).toBe(true);
    expect(second.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(first.closed).toHaveLength(0);
    expect(second.closed).toHaveLength(0);
  });

  test("Escape parks from the drawer, toggle, Main, and body without asking the app to close", () => {
    const { root, aside, close, toggle, item, closed } = waitingWorkspace();
    const input = document.createElement("input");
    aside.append(input);
    const dispose = installAppWorkspaceController({ root });
    try {
      // Text entry keeps Escape for itself, as it does for every panel shortcut.
      aside.dataset.workspaceDetailDrawer = "open";
      input.focus();
      expect(detailKey(input, "Escape").defaultPrevented).toBe(false);
      expect(aside.dataset.workspaceDetailDrawer).toBe("open");
      for (const target of [close, toggle, item, document.body]) {
        aside.dataset.workspaceDetailDrawer = "open";
        toggle.setAttribute("aria-expanded", "true");
        target.focus();
        expect(detailKey(target, "Escape").defaultPrevented).toBe(true);
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement === toggle).toBe(true);
      }
      aside.style.display = "none";
      expect(detailKey(item, "Escape").defaultPrevented).toBe(false);
      expect(detailKey(item, "F6").defaultPrevented).toBe(false);
      expect(closed).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  test("the generic toggle keeps pointer focus, sends keyboard focus to the title, and supplies trail space", () => {
    const { root, aside, title, toggle, content, closed } = waitingWorkspace();
    const dispose = installAppWorkspaceController({ root });
    try {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(aside.dataset.workspaceDetailDrawer).toBe("open");
      expect(document.activeElement === toggle).toBe(true);
      expect(content.style.getPropertyValue("--k2b-detail-space")).toBe("416px");
      toggle.click();
      expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      expect(content.style.getPropertyValue("--k2b-detail-space")).toBe("");
      toggle.click();
      expect(document.activeElement === title).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(closed).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  for (const change of ["sidebar resize", "Main minimum"] as const) {
    test(`${change} refreshes waiting without a root resize`, async () => {
      const { root, aside, toggle } = waitingWorkspace();
      const dispose = installAppWorkspaceController({ root });
      try {
        flushFrames();
        flushFrames();
        toggle.click();
        expect(aside.dataset.workspaceDetailDrawer).toBe("open");
        aside.style.removeProperty("--k2b-workspace-detail-waiting");
        if (change === "sidebar resize") dispatchKey(root.querySelector('[data-app-workspace-resize="sidebar"]')!, "ArrowRight");
        else root.querySelector(".k2b-app-workspace__main")!.setAttribute("data-workspace-main-min", "760");
        await window.happyDOM.whenAsyncComplete();
        // A changed minimum is a DOM change and syncs at once; a drag syncs once per frame.
        if (change === "sidebar resize") {
          expect(aside.dataset.workspaceDetailDrawer).toBe("open");
          flushFrames();
        }
        expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
      } finally {
        dispose();
      }
    });
  }

  test("hidden details and a wider host clear drawer state", async () => {
    const { root, aside, toggle } = waitingWorkspace();
    const dispose = installAppWorkspaceController({ root });
    try {
      aside.dataset.workspaceDetailDrawer = "open";
      toggle.setAttribute("aria-expanded", "true");
      aside.hidden = true;
      await window.happyDOM.whenAsyncComplete();
      expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      aside.hidden = false;
      aside.dataset.workspaceDetailDrawer = "open";
      toggle.setAttribute("aria-expanded", "true");
      aside.style.removeProperty("--k2b-workspace-detail-waiting");
      resizeObservers.forEach((observer) => observer.trigger());
      flushFrames();
      expect(aside.dataset.workspaceDetailDrawer).toBeUndefined();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    } finally {
      dispose();
    }
  });
});
