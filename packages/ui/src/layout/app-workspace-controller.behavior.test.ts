import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import {
  APP_WORKSPACE_DETAIL_CLOSE_EVENT,
  APP_WORKSPACE_DETAIL_STEP_EVENT,
  APP_WORKSPACE_SIDEBAR_HIDE_EVENT,
  installAppWorkspaceController,
} from "./app-workspace-controller";
import { APP_WORKSPACE_DETAIL_DEFAULT, APP_WORKSPACE_SIDEBAR_COLLAPSED } from "./app-workspace-state";

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
  root.dataset.workspaceResizable = options.resizable === false ? "false" : "true";
  setRect(root, { height: options.height ?? 700, width: options.width ?? 1000 });

  const sidebar = document.createElement("aside");
  sidebar.className = "k2b-app-workspace__sidebar";
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

    // A revealed row action pads the label's fading end: the text must clear it too.
    label.style.paddingRight = "40px";
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 60 });
    label.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true }) as unknown as Event);
    flushFrames();
    expect(label.dataset.overflow).toBe("true");
    expect(label.style.getPropertyValue("--k2b-sidebar-label-overflow")).toBe("20px");
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

const detailWorkspace = (options: { open?: boolean; closable?: boolean; steppable?: boolean; documentRoot?: boolean } = {}) => {
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
    if (event instanceof CustomEvent) steps.push(event.detail.direction);
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

  test("holds trailing space before measuring a closed board, then shrinks it as it scrolls out", async () => {
    const { root, main, aside } = detailWorkspace();
    const trail = document.createElement("div");
    trail.className = "k2b-detail-trail";
    trail.style.paddingInlineEnd = "432px";
    let left = 1032;
    Object.defineProperties(trail, {
      clientWidth: { get: () => 1000 },
      scrollWidth: {
        get: () => 1600 + (aside.hidden ? Number.parseFloat(trail.style.getPropertyValue("--k2b-detail-trail-hold")) || 0 : 432),
      },
      scrollLeft: {
        get: () => left,
        set: (value: number) => {
          left = value;
        },
      },
    });
    main.append(trail);
    const dispose = installAppWorkspaceController({ root });
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("432px");
    expect(trail.scrollLeft).toBe(1032);
    trail.scrollLeft = 800;
    trail.dispatchEvent(new Event("scroll"));
    expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("200px");
    trail.scrollLeft = 600;
    trail.dispatchEvent(new Event("scroll"));
    expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("");
    dispose();
  });

  for (const condition of ["no overflow", "at start"]) {
    test(`closing releases trailing space ${condition}`, async () => {
      const { root, main, aside } = detailWorkspace();
      const trail = document.createElement("div");
      trail.className = "k2b-detail-trail";
      trail.style.paddingInlineEnd = "432px";
      Object.defineProperties(trail, {
        clientWidth: { value: 1000 },
        scrollWidth: { value: condition === "no overflow" ? 1000 : 1200 },
        scrollLeft: { value: condition === "at start" ? 0 : 200 },
      });
      main.append(trail);
      const dispose = installAppWorkspaceController({ root });
      aside.hidden = true;
      await window.happyDOM.whenAsyncComplete();
      expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("");
      dispose();
    });
  }

  test("a resize reconciles held trailing space", async () => {
    const { root, main, aside } = detailWorkspace();
    const trail = document.createElement("div");
    trail.className = "k2b-detail-trail";
    trail.style.paddingInlineEnd = "432px";
    let width = 1000;
    Object.defineProperties(trail, {
      clientWidth: { get: () => width },
      scrollWidth: { value: 2032 },
      scrollLeft: { value: 1032 },
    });
    main.append(trail);
    const dispose = installAppWorkspaceController({ root });
    aside.hidden = true;
    await window.happyDOM.whenAsyncComplete();
    expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("432px");
    width = 2032;
    window.dispatchEvent(new window.Event("resize"));
    flushFrames();
    expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("");
    dispose();
  });

  for (const resize of ["keyboard", "pointer", "reset"]) {
    test(`a detail ${resize} resize refreshes padding held on close`, async () => {
      const { root, main, aside, handle } = detailWorkspace();
      const trail = document.createElement("div");
      trail.className = "k2b-detail-trail";
      trail.style.paddingInlineEnd = "432px";
      Object.defineProperties(trail, {
        clientWidth: { value: 1000 },
        scrollWidth: { value: 2200 },
        scrollLeft: { value: 1200 },
      });
      main.append(trail);
      const dispose = installAppWorkspaceController({ root });
      flushFrames();
      trail.style.paddingInlineEnd = "500px";
      if (resize === "keyboard") detailKey(handle, "ArrowLeft");
      else if (resize === "reset") handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      else {
        handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 4, clientX: 500 }));
        window.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 4, clientX: 480 }));
        window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 4 }));
      }
      aside.hidden = true;
      await window.happyDOM.whenAsyncComplete();
      expect(trail.style.getPropertyValue("--k2b-detail-trail-hold")).toBe("500px");
      dispose();
    });
  }

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
          matches: mode === "sheet" ? query === "(max-width: 47.999rem)" : query.endsWith("(pointer: coarse)"),
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
        plain.style.setProperty("touch-action", action);
        expect(swipe(plain).defaultPrevented).toBe(true);
      }
      expect(closed).toHaveLength(3);
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
      expect(scrolls).toEqual(bottom === 500 ? [{ top: 148, behavior: "smooth" }] : []);
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

  test("detail resize limits reserve both gaps instead of another floating panel", () => {
    const { root, content, handle } = detailWorkspace();
    setRect(content, { width: 900, height: 700 });
    const second = document.createElement("aside");
    second.className = "k2b-app-workspace__detail";
    setRect(second, { width: 416, height: 684 });
    content.append(second);
    const dispose = installAppWorkspaceController({ root });
    flushFrames();
    expect(handle.getAttribute("aria-valuemax")).toBe("564");
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
