import { expect, spyOn, test } from "bun:test";
import type { Browser } from "playwright";
import { createDomTestHarness } from "../../packages/ui/test/dom";
import {
  assetKind,
  Browsers,
  installProbe,
  installPwaProbe,
  pwaStartUrl,
  stepMilliseconds,
  trackHostScripts,
  transferType,
} from "./browser";
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

test("step clocks subtract the epoch origin and round without adding the quiet window", () => {
  expect(stepMilliseconds(1_800_000_000_123.6, 1_800_000_000_000)).toBe(124);
  expect(stepMilliseconds(100, 100)).toBe(0);
  expect(stepMilliseconds(null, 100)).toBeNull();
});

test("PWA resource kinds use initiators and URL extensions, including CSS-loaded fonts and images", () => {
  expect(
    [
      ["script", "/pwa/_ssr/123/entry.js"],
      ["link", "/public/styles.css?v=123"],
      ["css", "/public/font.woff2"],
      ["css", "/public/bg.webp"],
      ["img", "/branding/icon"],
      ["link", "/public/font.ttf"],
      ["other", "/manifest.webmanifest"],
    ].map(([initiator, path]) => assetKind(initiator ?? "", path ?? "/")),
  ).toEqual(["script", "css", "font", "image", "image", "font", "other"]);
});

test("the PWA probe records the visible pseudo-title frame even while the original heading is hidden", () => {
  const dom = createDomTestHarness();
  const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const observer = Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver");
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: class {
      static supportedEntryTypes: string[] = [];
    },
  });
  const frames: FrameRequestCallback[] = [];
  const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const rect = { x: 0, y: 0, width: 100, height: 44, top: 0, left: 0, right: 100, bottom: 44, toJSON: () => ({}) };
  const rects = spyOn(Element.prototype, "getClientRects").mockReturnValue({
    0: rect,
    length: 1,
    item: () => rect,
    [Symbol.iterator]: () => [rect][Symbol.iterator](),
  });
  const getStyle = globalThis.getComputedStyle;
  const pseudoStyle = document.createElement("span").style;
  pseudoStyle.visibility = "visible";
  const style = spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudo) =>
    pseudo === "::after" ? pseudoStyle : getStyle(element),
  );
  try {
    document.body.innerHTML =
      '<div class="k2b-mobile-shell" data-k2b-switching><h1 class="k2b-mobile-shell__title" style="visibility:hidden" data-k2b-next-title="Spaces">Cloud</h1><a href="/pwa/spaces" data-k2b-pending>Spaces</a></div>';
    installProbe(false);
    const launch = { token: "first-launch", title: null, action: "navigation" as const, choice: null };
    window.__cloudPwaLaunch = launch;
    installPwaProbe();
    expect(window.__cloudPwa.read().token).toBe("first-launch");
    window.__cloudPwa.reset({ token: "tab-step", title: "Spaces", action: "navigation", choice: null });
    window.__cloudPwa.launch(launch);
    expect(window.__cloudPwa.read().token).toBe("tab-step");
    const link = document.querySelector("a");
    if (!link) throw new Error("Missing test link");
    const press = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(press, "isPrimary", { value: true });
    link.dispatchEvent(press);
    frames.shift()?.(performance.now());
    expect(window.__cloudPwa.read()).toMatchObject({ pointer: window.__cloudPwa.epoch + press.timeStamp, titleFrame: true });
    expect(window.__cloudPwa.read().pressed).not.toBeNull();
    expect(window.__cloudPwa.read().titleAt).not.toBeNull();
    const stored: unknown = JSON.parse(sessionStorage.getItem("cloud.perf.pwa") ?? "null");
    expect(stored).toMatchObject({ token: "tab-step", titleFrame: true });
    window.dispatchEvent(new Event("pagehide"));
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    window.dispatchEvent(show);
    frames.shift()?.(performance.now());
    expect(window.__cloudPwa.read().hide).not.toBeNull();
    expect(window.__cloudPwa.read().persisted).toBe(true);
    expect(window.__cloudPwa.read().restoredFrame).not.toBeNull();
    for (const [tab, title] of [
      ["start", "Cloud"],
      ["spaces", "Spaces"],
    ]) {
      document.body.innerHTML = `<div class="k2b-mobile-shell"><h1 class="k2b-mobile-shell__title">${title}</h1><a data-tab="${tab}" aria-current="page" data-k2b-title="${title}">${title}</a></div>`;
      window.__cloudPwa.reset({ token: `relaunch-${tab}`, title: null, action: "navigation", choice: null });
      expect(window.__cloudPwa.read().titleAt).toBeNull();
      frames.shift()?.(performance.now());
      expect(window.__cloudPwa.read().titleAt).not.toBeNull();
      expect(window.__cloudPwa.read().titleFrame).toBe(false);
    }
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    style.mockRestore();
    rects.mockRestore();
    raf.mockRestore();
    if (storage) Object.defineProperty(globalThis, "sessionStorage", storage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (observer) Object.defineProperty(globalThis, "PerformanceObserver", observer);
    else Reflect.deleteProperty(globalThis, "PerformanceObserver");
    if (innerHtml) Object.defineProperty(Element.prototype, "innerHTML", innerHtml);
    dom.cleanup();
  }
});

test("PWA profiles keep phone throttling and use large WebKit tablets plus a desktop Chromium monitor", async () => {
  const { PhoneSession } = await import("./seed");
  const browsers = new Browsers(new AbortController().signal, "test-spki");
  const phone = new PhoneSession("https://localhost:4100", browsers.signal);
  const prepare = spyOn(phone, "response").mockResolvedValue(new Response(null, { status: 204 }));
  const contexts: { engine: string; options: Parameters<Browser["newContext"]>[0] }[] = [];
  // Stop at context creation: exercise the actual profile and context options without starting a browser.
  for (const engine of ["webkit", "chromium"] as const) {
    const browser: Partial<Browser> = {
      async newContext(options) {
        contexts.push({ engine, options });
        throw new Error("test stops before opening a page");
      },
    };
    Object.defineProperty(browsers.engines, "get", {
      configurable: true,
      value: (name: string) => (name === engine ? browser : undefined),
    });
    try {
      const results = await browsers.measurePwa(phone.origin, phone, {
        runs: 1,
        deviceName: "perf-2026-10-14",
        remote: false,
        results: [],
      });
      const measured = results.filter((profile) => profile.browser === engine);
      expect(
        measured.map(({ profile, viewport, deviceScaleFactor, cpuThrottle, network }) => ({
          profile,
          viewport,
          deviceScaleFactor,
          cpuThrottle,
          network,
        })),
      ).toEqual(
        engine === "webkit"
          ? [
              { profile: "iphone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, cpuThrottle: null, network: null },
              { profile: "ipad-portrait", viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, cpuThrottle: null, network: null },
              {
                profile: "ipad-landscape",
                viewport: { width: 1366, height: 1024 },
                deviceScaleFactor: 2,
                cpuThrottle: null,
                network: null,
              },
              {
                profile: "ipad-split-view",
                viewport: { width: 678, height: 1024 },
                deviceScaleFactor: 2,
                cpuThrottle: null,
                network: null,
              },
            ]
          : [
              { profile: "monitor", viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, cpuThrottle: 1, network: null },
              {
                profile: "phone",
                viewport: { width: 390, height: 844 },
                deviceScaleFactor: 3,
                cpuThrottle: 4,
                network: { latencyMs: 150, downloadBytesPerSecond: 200_000, uploadBytesPerSecond: 93_750 },
              },
            ],
      );
    } finally {
      if (engine === "chromium") prepare.mockRestore();
    }
  }
  expect(contexts).toHaveLength(12);
  const monitor = contexts.filter(({ options }) => options?.viewport?.width === 2560);
  expect(monitor.map(({ options }) => options?.serviceWorkers)).toEqual(["allow", "block"]);
  for (const { options } of monitor) {
    expect(options).toMatchObject({ isMobile: false, hasTouch: false, deviceScaleFactor: 1, ignoreHTTPSErrors: false });
    expect(options?.userAgent).toBeUndefined();
  }
  for (const { engine, options } of contexts.filter(({ options }) => options?.viewport?.width !== 2560)) {
    expect(options).toMatchObject({ isMobile: true, hasTouch: true, ignoreHTTPSErrors: engine === "webkit" });
  }
});

test("manifest start_url is resolved within the paired app", () => {
  const origin = "https://cloud.example.test";
  expect(pwaStartUrl({ start_url: "/pwa/" }, origin)).toBe(`${origin}/pwa/`);
  expect(pwaStartUrl({ start_url: "./?from=home" }, origin)).toBe(`${origin}/pwa/?from=home`);
  for (const manifest of [
    null,
    {},
    { start_url: 1 },
    { start_url: "/app/spaces" },
    { start_url: "https://elsewhere.test/pwa/" },
    { start_url: "https://user:pass@cloud.example.test/pwa/" },
  ])
    expect(() => pwaStartUrl(manifest, origin)).toThrow();
});
