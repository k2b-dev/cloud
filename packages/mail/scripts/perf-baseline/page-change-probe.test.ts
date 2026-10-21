import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { installPageChangeProbe, pageChangeKey } from "./page-change-probe";

// Frame timing is the subject: control rAF without replacing the global clock.
test("main content, island readiness and a responding trusted input are separate observations", () => {
  const dom = createDomTestHarness();
  const names = ["sessionStorage", "innerWidth", "innerHeight", "HTMLInputElement", "HTMLScriptElement", "requestAnimationFrame"] as const;
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames: FrameRequestCallback[] = [];
  try {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(globalThis, "HTMLScriptElement", { configurable: true, value: dom.window.HTMLScriptElement });
    Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, value: dom.window.HTMLInputElement });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    history.replaceState(null, "", "/app/mail/Box001");
    document.body.innerHTML = '<solid-island><div data-main>Mail</div><input type="search"></solid-island>';
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      element.style.visibility = "visible";
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }),
      });
    }
    const island = document.querySelector("solid-island")!;
    window.__cloudPerf = {
      initial: [island],
      mounted: new Map(),
      started: new Map(),
      errors: [],
      fcp: null,
      lcp: null,
      shifts: null,
      resources: [],
      longtasks: [],
      observers: [],
      flush() {},
    };
    installPageChangeProbe({ key: pageChangeKey, panel: () => ({ holds: false, state: "not shown on phone" }) });
    document.head.innerHTML = '<script type="module" data-ssr-assets="/_ssr/version" data-ssr-preload="shared.js"></script>';
    island.setAttribute("data-id", "mail");
    expect(window.__mailPageChange.eagerScripts()).toEqual([
      new URL("/_ssr/version/mail.js", document.baseURI).href,
      new URL("/_ssr/version/shared.js", document.baseURI).href,
    ]);
    window.__mailPageChange.arm({
      targetPath: "/app/mail/Box001",
      mainSelector: "[data-main]",
      mainText: "Mail",
      actionSelector: "input",
      responseSelector: "[data-response]",
      expectedHelpTopic: "mail-work",
    });
    const rejected = new Event("unhandledrejection");
    Object.defineProperty(rejected, "reason", { value: "rejected initialization" });
    window.dispatchEvent(rejected);
    document.dispatchEvent(new Event("ssr:island-error"));
    expect(window.__mailPageChange.errors()).toEqual(["rejected initialization", "ssr:island-error during page change"]);
    const tick = () => frames.shift()!(0);
    tick();
    expect(window.__mailPageChange.read()?.mainAt).toBeNull();
    // Synthetic pointer events must never become the start of a measured interaction.
    window.dispatchEvent(new Event("pointerdown"));
    expect(window.__mailPageChange.read()?.actionAt).toBeNull();
    const state = window.__mailPageChange.read()!;
    sessionStorage.setItem(pageChangeKey, JSON.stringify({ ...state, actionAt: 0 }));
    tick();
    expect(window.__mailPageChange.read()?.mainAt).toBeNumber();
    expect(window.__mailPageChange.read()?.readyAt).toBeNull();
    window.__cloudPerf.mounted.set(island, 1);
    tick();
    expect(window.__mailPageChange.read()?.readyAt).toBeNumber();
    const input = document.querySelector("input")!;
    input.value = "x";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    tick();
    expect(window.__mailPageChange.read()?.firstActionAt).toBeNull();
    const ready = window.__mailPageChange.read()!;
    sessionStorage.setItem(pageChangeKey, JSON.stringify({ ...ready, trustedInput: true }));
    tick();
    // Native editing alone is insufficient even after trusted input; the app must produce a response.
    expect(window.__mailPageChange.read()?.firstActionAt).toBeNull();
    input.setAttribute("data-response", "");
    tick();
    expect(window.__mailPageChange.read()?.firstActionAt).toBeNumber();
    expect(frames).toHaveLength(0);
  } finally {
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    dom.cleanup();
  }
});

test("resource counters honor duplicate/capture, once, abort, removal, timer cancellation and closed transports", async () => {
  const dom = createDomTestHarness();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "EventTarget");
  const prototype = dom.window.EventTarget.prototype;
  const originalAdd = prototype.addEventListener;
  const originalRemove = prototype.removeEventListener;
  try {
    Object.defineProperty(globalThis, "EventTarget", { configurable: true, value: dom.window.EventTarget });
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: class {
        static CLOSED = 2;
        readyState = 0;
        close() {
          this.readyState = 2;
        }
      },
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: class {
        static CLOSED = 3;
        readyState = 0;
        close() {
          this.readyState = 3;
        }
      },
    });
    // happy-dom binds target methods when constructing them; call the instrumented prototype
    // directly here. Native browser EventTargets resolve these methods through the prototype.
    const { installResourceProbe } = await import("./page-change-probe");
    installResourceProbe();
    const baseline = window.__mailResources();
    const listener = () => {};
    EventTarget.prototype.addEventListener.call(window, "probe", listener);
    EventTarget.prototype.addEventListener.call(window, "probe", listener);
    EventTarget.prototype.addEventListener.call(window, "probe", listener, true);
    expect(window.__mailResources().windowListeners).toBe(baseline.windowListeners + 2);
    EventTarget.prototype.removeEventListener.call(window, "probe", listener);
    EventTarget.prototype.removeEventListener.call(window, "probe", listener, true);
    expect(window.__mailResources().windowListeners).toBe(baseline.windowListeners);
    EventTarget.prototype.addEventListener.call(document, "probe", listener, { once: true });
    document.dispatchEvent(new Event("probe"));
    expect(window.__mailResources().documentListeners).toBe(baseline.documentListeners);
    const abort = new window.AbortController();
    EventTarget.prototype.addEventListener.call(window, "probe", listener, { signal: abort.signal });
    abort.abort();
    expect(window.__mailResources().windowListeners).toBe(baseline.windowListeners);
    EventTarget.prototype.addEventListener.call(window, "probe", listener, { signal: abort.signal });
    expect(window.__mailResources().windowListeners).toBe(baseline.windowListeners);
    const timer = window.setTimeout(listener, 60_000);
    const interval = window.setInterval(listener, 60_000);
    expect(window.__mailResources()).toMatchObject({ timeouts: baseline.timeouts + 1, intervals: baseline.intervals + 1 });
    // Native clearTimeout/clearInterval share the timer ID pool.
    window.clearInterval(timer);
    window.clearTimeout(interval);
    expect(window.__mailResources()).toMatchObject({ timeouts: baseline.timeouts, intervals: baseline.intervals });
    const source = new window.EventSource("/live");
    const socket = new window.WebSocket("ws://localhost/live");
    expect(window.__mailResources()).toMatchObject({ eventSources: 1, webSockets: 1 });
    source.close();
    socket.close();
    expect(window.__mailResources()).toMatchObject({ eventSources: 0, webSockets: 0 });
  } finally {
    prototype.addEventListener = originalAdd;
    prototype.removeEventListener = originalRemove;
    if (descriptor) Object.defineProperty(globalThis, "EventTarget", descriptor);
    else Reflect.deleteProperty(globalThis, "EventTarget");
    dom.cleanup();
  }
});
