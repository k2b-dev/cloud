import { expect, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../packages/ui/test/dom";
import { installPanelErrors } from "./panel";
import { installPanelProbe, panelEndState } from "./panel-probe";

function fixture() {
  const dom = createDomTestHarness();
  document.body.innerHTML =
    '<main class="cloud-app-canvas" data-panel="open" data-panel-sheet="open"></main><aside id="cloud-panel" data-state="ready" data-provider="core"><iframe src="about:blank" data-cloud-panel-frame="core" style="display:block;visibility:visible;opacity:1"></iframe></aside><button aria-controls="cloud-panel">Help</button>';
  const frame = document.querySelector<HTMLIFrameElement>("iframe");
  const slot = document.querySelector<HTMLElement>("#cloud-panel");
  if (!frame || !slot) throw new Error("Missing fixture");
  const doc = document.implementation.createHTMLDocument("provider");
  Object.defineProperty(doc, "defaultView", { configurable: true, value: window });
  Object.defineProperty(frame, "contentDocument", { configurable: true, value: doc });
  const rect = (width = 200, height = 100) => ({
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    toJSON: () => ({}),
  });
  frame.getBoundingClientRect = () => rect();
  const heading = (type: "view" | "start" | "tasks" = "view") => {
    doc.body.innerHTML =
      type === "view"
        ? '<div data-help-results><section data-help-view><h3 id="help-start-view-title">For this view</h3></section></div>'
        : type === "start"
          ? '<div data-help-results><section data-help-group="start"><h3 class="help-start-heading">Get started</h3></section></div>'
          : '<div data-help-results><section data-help-tasks><h3 class="help-start-heading">What do you want to do?</h3></section></div>';
    const title = doc.querySelector<HTMLElement>("h3");
    if (!title) throw new Error("Missing heading");
    title.style.cssText = "display:block;visibility:visible;opacity:1";
    title.getBoundingClientRect = () => rect();
    return title;
  };
  const frames: FrameRequestCallback[] = [];
  const previousRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  return {
    dom,
    frame,
    slot,
    doc,
    heading,
    rect,
    frames,
    tick(time: number) {
      now = time;
      const callback = frames.shift();
      if (!callback) throw new Error("No scheduled frame");
      callback(time);
    },
    cleanup() {
      clock.mockRestore();
      if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
      if (previousRaf) Object.defineProperty(globalThis, "requestAnimationFrame", previousRaf);
      dom.cleanup();
    },
  };
}

test("neither a ready mark nor a rendered heading alone is visible panel content", () => {
  const f = fixture();
  try {
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    expect(panelEndState("navigation", "view").holds).toBe(false);
    expect(panelEndState("navigation", "view").state).toContain("heading missing");
    f.heading();
    delete f.doc.documentElement.dataset.cloudPanelReady;
    expect(panelEndState("navigation", "view").state).toContain("ready mark missing");
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    expect(panelEndState("navigation", "view")).toEqual({ holds: true, state: "visible view heading" });
    expect(panelEndState("sheet", "view").holds).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("loading, hidden, zero-size and off-screen content do not count; the expected heading is asserted", () => {
  const f = fixture();
  try {
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    const title = f.heading();
    f.slot.dataset.state = "loading";
    f.frame.style.visibility = "hidden";
    expect(panelEndState("navigation", "view").state).toContain("slot loading");
    f.slot.dataset.state = "ready";
    expect(panelEndState("navigation", "view").holds).toBe(false);
    f.frame.style.visibility = "visible";
    f.frame.style.opacity = "0";
    expect(panelEndState("navigation", "view").holds).toBe(false);
    f.frame.style.opacity = "1";
    title.style.visibility = "hidden";
    expect(panelEndState("navigation", "view").holds).toBe(false);
    title.style.visibility = "visible";
    title.getBoundingClientRect = () => f.rect(0);
    expect(panelEndState("navigation", "view").holds).toBe(false);
    title.getBoundingClientRect = () => ({ ...f.rect(), top: 100_000 });
    expect(panelEndState("navigation", "view").holds).toBe(false);
    f.heading("start");
    expect(panelEndState("navigation", "view")).toEqual({
      holds: false,
      state: "expected view heading missing; only start heading exists",
    });
    expect(panelEndState("navigation", "start").holds).toBe(true);
    // An app whose Help has only task tiles (Notebooks) starts with "What do you want to do?", not a kind group.
    f.heading("tasks");
    expect(panelEndState("navigation", "start").holds).toBe(true);
    expect(panelEndState("navigation", "view").state).toBe("expected view heading missing; only start heading exists");
    f.heading("start");
    document.querySelector(".cloud-app-canvas")?.removeAttribute("data-panel-sheet");
    expect(panelEndState("sheet", "start").state).toContain("closed");
    f.slot.dataset.provider = "other";
    expect(panelEndState("navigation", "start").holds).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("an inaccessible provider document has a diagnostic instead of throwing", () => {
  const f = fixture();
  try {
    Object.defineProperty(f.frame, "contentDocument", {
      get: () => {
        throw new Error("cross-origin");
      },
    });
    expect(panelEndState("navigation", "view")).toEqual({ holds: false, state: "provider contentDocument inaccessible" });
  } finally {
    f.cleanup();
  }
});

test("the armed probe records the first rAF callback after the complete end state holds, then stops", () => {
  const f = fixture();
  try {
    f.heading();
    installPanelProbe(panelEndState);
    window.__cloudPanelPerf.arm({ mode: "navigation", heading: "view", timeoutMs: 100 });
    f.tick(5);
    expect(window.__cloudPanelPerf.hitAt).toBeNull();
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    expect(window.__cloudPanelPerf.hitAt).toBeNull();
    f.tick(12);
    expect(window.__cloudPanelPerf.hitAt).toBe(12);
    expect(f.frames).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test("a never-ready provider times out with the last state, slot, src, readiness and elapsed time, then stops", () => {
  const f = fixture();
  try {
    f.slot.dataset.state = "loading";
    installPanelProbe(panelEndState);
    window.__cloudPanelPerf.arm({ mode: "navigation", heading: "view", timeoutMs: 10 });
    f.tick(5);
    expect(window.__cloudPanelPerf.timedOut).toBeNull();
    f.tick(11);
    expect(window.__cloudPanelPerf.timedOut).toContain("slot loading; expected ready");
    expect(window.__cloudPanelPerf.timedOut).toContain("slot=loading; iframe=about:blank; providerReady=missing; elapsed=11 ms");
    expect(window.__cloudPanelPerf.hitAt).toBeNull();
    expect(f.frames).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test("untrusted pointerdown never anchors a sheet measurement", () => {
  const f = fixture();
  try {
    installPanelProbe(panelEndState);
    window.__cloudPanelPerf.arm({ mode: "sheet", heading: "view", timeoutMs: 100 });
    const button = document.querySelector("button");
    button?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(window.__cloudPanelPerf.anchor).toBeNull();
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    f.heading();
    f.tick(5);
    expect(window.__cloudPanelPerf.hitAt).toBeNull();
    f.tick(101);
    expect(window.__cloudPanelPerf.timedOut).toContain("elapsed=101 ms");
    expect(f.frames).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test("a new document automatically consumes the armed navigation record and keeps the assign gap", () => {
  const f = fixture();
  try {
    sessionStorage.setItem(
      "cloud-panel-perf-navigation",
      JSON.stringify({ heading: "start", assignEpoch: performance.timeOrigin - 25, timeoutMs: 100 }),
    );
    installPanelProbe(panelEndState);
    expect(window.__cloudPanelPerf.navigationGapMs).toBe(25);
    expect(window.__cloudPanelPerf.anchor).toBe(0);
    expect(window.__cloudPanelPerf.watch?.heading).toBe("start");
    expect(sessionStorage.getItem("cloud-panel-perf-navigation")).toBeNull();
    f.heading("start");
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    f.tick(10);
    expect(window.__cloudPanelPerf.hitAt).toBe(10);
  } finally {
    f.cleanup();
  }
});

test("island errors persist in session storage across documents and fail the sample", () => {
  const f = fixture();
  try {
    installPanelErrors();
    document.dispatchEvent(new CustomEvent("ssr:island-error"));
    expect(sessionStorage.getItem("cloud-panel-perf-errors")).toContain("host: ssr:island-error");
    installPanelErrors();
    expect(sessionStorage.getItem("cloud-panel-perf-errors")).toContain("ssr:island-error");
  } finally {
    f.cleanup();
  }
});

test("a replaced provider document cannot reuse the earlier frame's ready timestamp", () => {
  const f = fixture();
  try {
    f.slot.dataset.state = "loading";
    f.doc.documentElement.dataset.cloudPanelReady = "core";
    installPanelProbe(panelEndState);
    window.__cloudPanelPerf.arm({ mode: "navigation", heading: "view", timeoutMs: 100 });
    expect(window.__cloudPanelPerf.iframeSeenAt).toBe(0);
    f.tick(3);
    expect(window.__cloudPanelPerf.providerReadyMs).toBe(3);
    const replacement = document.implementation.createHTMLDocument("new provider");
    Object.defineProperty(replacement, "defaultView", { value: window });
    Object.defineProperty(f.frame, "contentDocument", { configurable: true, value: replacement });
    f.tick(5);
    expect(window.__cloudPanelPerf.providerReadyMs).toBeNull();
    replacement.documentElement.dataset.cloudPanelReady = "core";
    f.tick(9);
    expect(window.__cloudPanelPerf.providerReadyMs).toBe(9);
    expect(window.__cloudPanelPerf.iframeSeenAt).toBe(0);
    f.tick(101);
    expect(window.__cloudPanelPerf.timedOut).not.toBeNull();
    expect(f.frames).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
