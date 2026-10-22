import { expect, mock, test } from "bun:test";
import { createDomTestHarness } from "../../test/dom";
import { watchAppHostWidth } from "./app-host-width";

const layout = () => {
  const dom = createDomTestHarness();
  const root = document.documentElement;
  root.style.cssText = "width:1680px;font-size:16px;padding:0;border:0;box-sizing:content-box;container:k2b-app-area / inline-size";
  dom.root.style.cssText = "width:1023.75px;padding:0;border:0;box-sizing:content-box;container-name:other k2b-app-area";
  const workspace = document.createElement("div");
  workspace.className = "k2b-app-workspace";
  const element = document.createElement("div");
  workspace.append(element);
  dom.root.append(workspace);
  const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
  const Original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class extends Original {
    private targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {
      super(callback);
    }
    override observe(target: Element) {
      this.targets.add(target);
      observers.set(this, { callback: this.callback, targets: this.targets });
    }
    override disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  };
  return {
    dom,
    root,
    host: dom.root,
    workspace,
    element,
    observers,
    check: () => {
      for (const [observer, { callback }] of observers) callback([], observer);
    },
    cleanup: () => {
      globalThis.ResizeObserver = Original;
      dom.cleanup();
    },
  };
};

for (const boxSizing of ["border-box", "content-box"]) {
  test(`${boxSizing}: fractional content width uses root rem and emits only changes, until stopped`, () => {
    const view = layout();
    const inset = boxSizing === "border-box" ? 36 : 0;
    view.root.style.fontSize = "20px";
    view.host.style.cssText = `container-name:other k2b-app-area;width:${1280 + inset - 0.25}px;font-size:8px;padding:16px;border:2px solid;box-sizing:${boxSizing};transform:scale(.5)`;
    const update = mock((_matches: boolean) => {});
    const stop = watchAppHostWidth(view.element, 64, update);
    try {
      expect(update.mock.calls).toEqual([[false]]);
      view.check();
      view.host.style.width = `${1280 + inset}px`;
      view.check();
      view.check();
      expect(update.mock.calls).toEqual([[false], [true]]);
      view.host.style.width = `${1280 + inset - 0.25}px`;
      view.check();
      expect(update.mock.calls).toEqual([[false], [true], [false]]);
      stop();
      expect(view.observers.size).toBe(0);
      view.host.style.width = "1400px";
      view.check();
      expect(update.mock.calls).toHaveLength(3);
    } finally {
      stop();
      view.cleanup();
    }
  });
}

test("observes the root, workspace, and current nearest host, reselecting on the resize that comes with a name change", () => {
  const view = layout();
  // The element's own name cannot be the container for its chrome.
  view.element.style.containerName = "k2b-app-area";
  const update = mock((_matches: boolean) => {});
  const stop = watchAppHostWidth(view.element, 64, update);
  try {
    expect([...view.observers.values()][0]?.targets).toEqual(new Set([view.root, view.host, view.workspace]));
    expect(update.mock.calls).toEqual([[false]]);
    // Cloud changes the name together with the app area's width, so the workspace reports a resize.
    view.host.style.containerName = "other";
    view.check();
    expect(update.mock.calls).toEqual([[false], [true]]);
    expect([...view.observers.values()][0]?.targets).toEqual(new Set([view.root, view.workspace]));
    view.host.style.containerName = "other k2b-app-area";
    view.check();
    expect(update.mock.calls).toEqual([[false], [true], [false]]);
    expect([...view.observers.values()][0]?.targets).toEqual(new Set([view.root, view.host, view.workspace]));
    stop();
    view.host.style.containerName = "none";
    view.check();
    expect(update.mock.calls).toHaveLength(3);
  } finally {
    stop();
    view.cleanup();
  }
});

test("without ResizeObserver checks once and on window resize, and removes the listener on stop", () => {
  const view = layout();
  Reflect.deleteProperty(globalThis, "ResizeObserver");
  const update = mock((_matches: boolean) => {});
  const stop = watchAppHostWidth(view.element, 64, update);
  try {
    expect(update.mock.calls).toEqual([[false]]);
    view.host.style.width = "1024px";
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(update.mock.calls).toEqual([[false], [true]]);
    stop();
    view.host.style.width = "952px";
    window.dispatchEvent(new Event("resize"));
    expect(update.mock.calls).toEqual([[false], [true]]);
  } finally {
    stop();
    view.cleanup();
  }
});
