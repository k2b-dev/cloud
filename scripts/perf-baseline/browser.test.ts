import { expect, test } from "bun:test";
import type { Browser } from "playwright";
import { createDomTestHarness } from "../../packages/ui/test/dom";
import { Browsers, installProbe, trackHostScripts, transferType } from "./browser";
import { type BrowserResult, metricNames, metricsSchema } from "./model";

test("transfer types group script/stylesheet/document separately from fonts and XHR", () => {
  expect(["Script", "script", "Stylesheet", "Document", "Font", "Fetch", "Image"].map(transferType)).toEqual([
    "js",
    "js",
    "css",
    "document",
    "other",
    "other",
    "other",
  ]);
});

test("the mount probe counts initial empty clients as well as SSR islands, after synchronous render", async () => {
  const dom = createDomTestHarness();
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const observer = Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver");
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: class {
      static supportedEntryTypes: string[] = [];
    },
  });
  try {
    document.body.innerHTML = '<solid-island data-id="shared">SSR content</solid-island><solid-client data-id="shared"></solid-client>';
    installProbe(false);
    const elements = document.querySelectorAll("solid-island,solid-client");
    expect(window.__cloudPerf.mounted.size).toBe(0);
    for (const element of elements) {
      element.innerHTML = "";
      element.append(document.createElement("button"));
    }
    expect(window.__cloudPerf.mounted.size).toBe(0);
    await Promise.resolve();
    expect(window.__cloudPerf.initial?.length).toBe(2);
    expect(window.__cloudPerf.mounted.size).toBe(2);
    const first = elements[0];
    if (!first) throw new Error("Missing test island");
    first.dispatchEvent(new CustomEvent("ssr:island-error", { bubbles: true }));
    expect(window.__cloudPerf.errors).toEqual(["ssr:island-error during initial mount"]);
    expect(window.__cloudPerf.shifts).toBeNull();
    for (const time of window.__cloudPerf.mounted.values()) {
      expect(time).toBeGreaterThan(0);
      expect(time).toBeLessThanOrEqual(performance.now());
    }
    // Mount windows start at the clear-and-render setter and end after the synchronous render.
    expect(window.__cloudPerf.started.size).toBe(2);
    for (const [element, started] of window.__cloudPerf.started)
      expect(started).toBeLessThanOrEqual(window.__cloudPerf.mounted.get(element) ?? Number.NaN);
  } finally {
    if (innerHtml) Object.defineProperty(Element.prototype, "innerHTML", innerHtml);
    if (observer) Object.defineProperty(globalThis, "PerformanceObserver", observer);
    else Reflect.deleteProperty(globalThis, "PerformanceObserver");
    dom.cleanup();
  }
});

test("the probe buffers resource, paint, shift and long-task entries and flushes pending records", () => {
  const dom = createDomTestHarness();
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const observer = Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver");
  const entry = (name: string, type: string, start: number, duration = 0) => ({
    name,
    entryType: type,
    startTime: start,
    duration,
    toJSON: () => ({}),
  });
  const entries: Record<string, (PerformanceEntry & { responseEnd?: number; hadRecentInput?: boolean; value?: number })[]> = {
    resource: [{ ...entry("https://localhost:4100/entry.js", "resource", 20), responseEnd: 120 }],
    paint: [entry("first-contentful-paint", "paint", 150)],
    "largest-contentful-paint": [entry("", "largest-contentful-paint", 170)],
    "layout-shift": [
      { ...entry("", "layout-shift", 100), hadRecentInput: false, value: 0.1 },
      { ...entry("", "layout-shift", 110), hadRecentInput: true, value: 0.9 },
    ],
    longtask: [entry("", "longtask", 180, 70)],
  };
  const observed: PerformanceObserverInit[] = [];
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: class {
      static supportedEntryTypes = Object.keys(entries);
      pending: PerformanceEntry[] = [];
      observe(options: PerformanceObserverInit) {
        observed.push(options);
        this.pending = entries[options.type ?? ""] ?? [];
      }
      takeRecords() {
        const records = this.pending;
        this.pending = [];
        return records;
      }
    },
  });
  try {
    installProbe(true);
    const probe = window.__cloudPerf;
    expect(probe.resources).toEqual([]);
    expect(probe.shifts).toEqual([]);
    expect(probe.fcp).toBeNull();
    probe.flush();
    expect(probe.resources).toEqual([{ name: "https://localhost:4100/entry.js", responseEnd: 120 }]);
    expect(probe.shifts).toEqual([{ start: 100, value: 0.1 }]);
    expect(probe.fcp).toBe(150);
    expect(probe.lcp).toBe(170);
    expect(probe.longtasks).toEqual([{ start: 180, duration: 70 }]);
    expect(observed.every((options) => options.buffered)).toBe(true);
    probe.flush();
    expect(probe.resources).toHaveLength(1);
  } finally {
    if (innerHtml) Object.defineProperty(Element.prototype, "innerHTML", innerHtml);
    if (observer) Object.defineProperty(globalThis, "PerformanceObserver", observer);
    else Reflect.deleteProperty(globalThis, "PerformanceObserver");
    dom.cleanup();
  }
});

test("interruption keeps completed profiles and the active profile's samples in the caller's array", async () => {
  const controller = new AbortController();
  const browsers = new Browsers(controller.signal, "test-spki-no-browser-launched");
  const results: BrowserResult[] = [];
  const metrics = metricsSchema.parse(Object.fromEntries(metricNames.map((name) => [name, 100])));
  const interruption = new Error("test interruption");
  let loads = 0;
  // Stub the browser/sample boundary so only the measurement loop runs, without launching browsers.
  const browser: Partial<Browser> = {};
  Object.defineProperty(browsers.engines, "get", { value: () => browser });
  Object.defineProperty(browsers, "sample", {
    value: async () => {
      if (++loads === 4) {
        controller.abort(interruption);
        throw new Error("context closed");
      }
      return { metrics, encodings: { js: ["br"], css: ["br"] } };
    },
  });
  const error = await browsers.measure("https://localhost:4100/faq", "session", 2, results).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("test interruption");
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ profile: "desktop", status: "ok", samples: [metrics, metrics] });
  expect(results[0]?.metrics?.ttiMs).toEqual({ median: 100, min: 100, max: 100 });
  expect(results[1]).toMatchObject({ profile: "phone", status: "failed", reason: "test interruption", samples: [metrics], metrics: null });
});

test("host TTI tracks only main-frame scripts, while a new document resets its script window", () => {
  type Request = { frame(): object; resourceType(): string; url(): string };
  const listeners = new Map<string, Set<(request: Request) => void>>();
  const host = {},
    provider = {};
  const source = {
    mainFrame: () => host,
    on(event: string, listener: (request: Request) => void) {
      const entries = listeners.get(event) ?? new Set();
      entries.add(listener);
      listeners.set(event, entries);
    },
    off(event: string, listener: (request: Request) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const emit = (event: string, request: Request) => {
    for (const listener of listeners.get(event) ?? []) listener(request);
  };
  const request = (frame: object, type: string, name: string): Request => ({
    frame: () => frame,
    resourceType: () => type,
    url: () => `https://localhost/${name}`,
  });
  const scripts = trackHostScripts(source);
  const frameScript = request(provider, "script", "provider.js");
  const hostScript = request(host, "script", "host.js");
  emit("request", frameScript);
  emit("request", request(host, "stylesheet", "host.css"));
  expect(scripts.pending.size).toBe(0);
  expect(scripts.urls.size).toBe(0);
  const quietAt = scripts.last();
  emit("requestfinished", frameScript);
  expect(scripts.last()).toBe(quietAt);
  emit("request", hostScript);
  expect(scripts.pending.size).toBe(1);
  expect([...scripts.urls]).toEqual(["https://localhost/host.js"]);
  emit("requestfinished", hostScript);
  expect(scripts.pending.size).toBe(0);
  expect(scripts.urls.size).toBe(1);
  scripts.reset();
  expect(scripts.urls.size).toBe(0);
  emit("request", hostScript);
  emit("requestfailed", hostScript);
  expect(scripts.pending.size).toBe(0);
  scripts.stop();
  expect([...listeners.values()].every((entries) => entries.size === 0)).toBe(true);
});
