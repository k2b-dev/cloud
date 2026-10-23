// Playwright is an existing @k2b/ui devDependency in this isolated-linker workspace.
import { createRequire } from "node:module";
import type { Browser, BrowserContext, CDPSession, Locator, Page, Request } from "playwright";
import { TIMEZONE_COOKIE } from "../../packages/cloud/src/shared/time";
import {
  aggregateMetrics,
  assetCacheState,
  type BrowserResult,
  cumulativeLayoutShift,
  failedRequestError,
  interactive,
  longTaskMetrics,
  type Metrics,
  metricsSchema,
  type PwaAsset,
  type PwaDocument,
  type PwaProfileResult,
  type PwaStep,
  pwaProfileIds,
  pwaStepSchema,
  summarizePwa,
  timeToInteractive,
  validatePage,
} from "./model";

import { waitFor } from "./runtime";
import type { PhoneSession } from "./seed";

const { chromium, webkit, devices }: typeof import("playwright") = createRequire(
  new URL("../../packages/ui/package.json", import.meta.url),
)("playwright");

export const profiles = ["desktop", "phone"] as const;
export const phoneNetwork = { latencyMs: 150, downloadBytesPerSecond: 200_000, uploadBytesPerSecond: 93_750 };
export const measurementTimeoutMs = 45_000;
/** Fixed browser time zone, stored in Cloud's timezone cookie like on a returning user's device. */
export const measuredTimeZone = "Europe/Berlin";
export const measuredLocale = "en-US";
export type Engine = "chromium" | "webkit";
export type Profile = (typeof profiles)[number];
type TransferType = "document" | "js" | "css" | "other";

export function transferType(type: string): TransferType {
  return type.toLowerCase() === "script"
    ? "js"
    : type.toLowerCase() === "stylesheet"
      ? "css"
      : type.toLowerCase() === "document"
        ? "document"
        : "other";
}

type Probe = {
  initial: Element[] | null;
  /** performance.now() when an island's clear-and-render started; the matching mounted time ends it. */
  started: Map<Element, number>;
  mounted: Map<Element, number>;
  errors: string[];
  fcp: number | null;
  lcp: number | null;
  shifts: { start: number; value: number }[] | null;
  resources: { name: string; responseEnd: number }[];
  longtasks: { start: number; duration: number }[];
  observers: PerformanceObserver[];
  flush: () => void;
};
declare global {
  interface Window {
    __cloudPerf: Probe;
    __cloudPwaLaunch?: PwaProbeConfig;
    __cloudPwa: {
      read: () => PwaProbeRecord;
      reset: (config: PwaProbeConfig) => void;
      launch: (config: PwaProbeConfig) => void;
      stop: () => void;
      epoch: number;
      control: Element | null;
    };
  }
}

/** Runs before page scripts. Observes the existing synchronous clear-and-render mount contract. */
export function installProbe(chromiumEngine: boolean) {
  const probe: Probe = {
    initial: null,
    started: new Map(),
    mounted: new Map(),
    errors: [],
    fcp: null,
    lcp: null,
    shifts: null,
    resources: [],
    longtasks: [],
    observers: [],
    flush: () => {},
  };
  window.__cloudPerf = probe;
  const collect = () => {
    probe.initial ??= [...document.querySelectorAll("solid-island,solid-client")];
  };
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const setter = descriptor?.set;
  if (!setter) {
    probe.errors.push("Cannot observe island mount: Element.innerHTML setter missing");
    return;
  }
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...descriptor,
    set(this: Element, value: string) {
      const mount = value === "" && (this.localName === "solid-island" || this.localName === "solid-client");
      if (mount) {
        collect();
        if (!probe.started.has(this)) probe.started.set(this, performance.now());
      }
      setter.call(this, value);
      // render() is synchronous and follows this setter in @k2b/ssr/src/mount.ts.
      // The microtask runs after that render stack; thrown/caught errors dispatch ssr:island-error.
      if (mount)
        queueMicrotask(() => {
          if (!probe.mounted.has(this)) probe.mounted.set(this, performance.now());
        });
    },
  });
  document.addEventListener("DOMContentLoaded", collect, { once: true });
  document.addEventListener("ssr:island-error", () => {
    probe.errors.push("ssr:island-error during initial mount");
  });
  const handlers: { observer: PerformanceObserver; consume: (entries: PerformanceEntry[]) => void }[] = [];
  const observe = (type: string, consume: (entries: PerformanceEntry[]) => void) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => consume(list.getEntries()));
    observer.observe({ type, buffered: true });
    handlers.push({ observer, consume });
    probe.observers.push(observer);
  };
  observe("paint", (entries) => {
    for (const entry of entries) if (entry.name === "first-contentful-paint") probe.fcp = entry.startTime;
  });
  observe("largest-contentful-paint", (entries) => {
    for (const entry of entries) probe.lcp = entry.startTime;
  });
  if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) probe.shifts = [];
  observe("layout-shift", (entries) => {
    for (const entry of entries)
      if ("hadRecentInput" in entry && entry.hadRecentInput === false && "value" in entry && typeof entry.value === "number")
        probe.shifts?.push({ start: entry.startTime, value: entry.value });
  });
  observe("resource", (entries) => {
    for (const entry of entries)
      if ("responseEnd" in entry && typeof entry.responseEnd === "number")
        probe.resources.push({ name: entry.name, responseEnd: entry.responseEnd });
  });
  if (chromiumEngine)
    observe("longtask", (entries) => {
      for (const entry of entries) probe.longtasks.push({ start: entry.startTime, duration: entry.duration });
    });
  probe.flush = () => {
    for (const { observer, consume } of handlers) consume(observer.takeRecords());
  };
}

/** Timing of one load at its TTI, in page milliseconds (performance.now()). */
export type LoadTiming = {
  fcp: number | null;
  lcp: number | null;
  tti: number;
  /** Start and end of each initial island's clear-and-render, in initial-island order. */
  mountStarts: number[];
  mountTimes: number[];
  longtasks: { start: number; duration: number }[];
};
/**
 * Optional work around one measured load. beforeLoad runs after the context, probe and
 * throttling exist and before navigation; afterLoad runs at TTI, after this load's
 * transfers stopped counting, while the page is still open.
 */
export type LoadHooks<T> = {
  timeoutMs?: number;
  beforeLoad?: (page: Page, context: BrowserContext) => Promise<void>;
  /** `cdp` is the load's Chromium session (cache disabled, throttling); undefined in WebKit. */
  afterLoad?: (page: Page, timing: LoadTiming, cdp: CDPSession | undefined) => Promise<T>;
};

type ScriptRequest = { frame(): object; resourceType(): string; url(): string };
type ScriptEvent = "request" | "requestfinished" | "requestfailed";
type ScriptSource = {
  mainFrame(): object;
  on(event: ScriptEvent, listener: (request: ScriptRequest) => void): unknown;
  off(event: ScriptEvent, listener: (request: ScriptRequest) => void): unknown;
};

/** Main-frame scripts only: child-frame resources have no timing entry in the host timeline. */
export function trackHostScripts(page: ScriptSource) {
  const pending = new Set<ScriptRequest>();
  const urls = new Set<string>();
  let lastScript = performance.now();
  const begin = (request: ScriptRequest) => {
    if (request.frame() !== page.mainFrame() || request.resourceType() !== "script") return;
    pending.add(request);
    urls.add(request.url());
    lastScript = performance.now();
  };
  const finish = (request: ScriptRequest) => {
    if (pending.delete(request)) lastScript = performance.now();
  };
  page.on("request", begin);
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  return {
    pending,
    urls,
    last: () => lastScript,
    reset() {
      pending.clear();
      urls.clear();
      lastScript = performance.now();
    },
    stop() {
      page.off("request", begin);
      page.off("requestfinished", finish);
      page.off("requestfailed", finish);
    },
  };
}

/** Shared page-baseline TTI definition; waits on animation frames, never network idle. */
export async function observeTti(
  page: Page,
  scripts: ReturnType<typeof trackHostScripts>,
  signal: AbortSignal,
  errors: string[],
  start = performance.now(),
  domContentLoadedMs = 0,
  timeoutMs = measurementTimeoutMs,
) {
  let timing:
    | (Pick<Probe, "fcp" | "lcp" | "shifts" | "resources" | "longtasks" | "errors"> & { mountStarts: number[]; mountTimes: number[] })
    | null = null;
  // The last observed state, so a timeout names which TTI condition never held.
  let last = "no probe read";
  // The scripts that were finished and timed when the observation decided to stop. An idle-time
  // import can start more scripts while the final probe read is in flight; they are after the stop.
  let observedScripts: string[] = [];
  while (performance.now() - start < timeoutMs) {
    signal.throwIfAborted();
    const urls = [...scripts.urls];
    const state = await page.evaluate((urls) => {
      const p = window.__cloudPerf;
      // WebKit adds resource entries for runtime-injected modulepreload links well after the
      // request finished; the observation waits for them instead of stopping without timing.
      p.flush();
      const timed = new Set(p.resources.map((entry) => entry.name));
      return {
        initial: p.initial?.length ?? null,
        mounted: p.initial?.filter((element) => p.mounted.has(element)).length ?? 0,
        untimedScripts: urls.filter((url) => !timed.has(url)).length,
        timed: p.resources.length,
        errors: p.errors,
      };
    }, urls);
    if (state.errors.length || errors.length) throw new Error([...state.errors, ...errors].join("; "));
    last = `${state.initial === null ? "islands not collected" : `${state.mounted}/${state.initial} islands mounted`}, ${scripts.pending.size} scripts pending, ${state.untimedScripts}/${urls.length} scripts without timing, ${state.timed} resource entries, quiet ${Math.round(performance.now() - scripts.last())} ms`;
    if (
      state.initial !== null &&
      interactive({
        initial: state.initial,
        mounted: state.mounted,
        pendingScripts: scripts.pending.size,
        untimedScripts: state.untimedScripts,
        quietMs: performance.now() - scripts.last(),
      })
    ) {
      observedScripts = urls;
      timing = await page.evaluate(() => {
        const p = window.__cloudPerf;
        p.flush();
        for (const observer of p.observers) observer.disconnect();
        const mountTimes = (p.initial ?? []).map((element) => {
          const time = p.mounted.get(element);
          if (time === undefined) throw new Error("Initial island mount time missing at observation stop");
          return time;
        });
        const mountStarts = (p.initial ?? []).map((element) => {
          const time = p.started.get(element);
          if (time === undefined) throw new Error("Initial island mount start missing at observation stop");
          return time;
        });
        return {
          mountStarts,
          mountTimes,
          resources: p.resources,
          fcp: p.fcp,
          lcp: p.lcp,
          shifts: p.shifts,
          longtasks: p.longtasks,
          errors: p.errors,
        };
      });
      break;
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  if (timing === null)
    throw new Error(
      `TTI timed out after ${timeoutMs} ms (initial islands did not mount, scripts did not become quiet, or script resource timings did not arrive); DOMContentLoaded after ${domContentLoadedMs} ms; last state: ${last}`,
    );
  const tti = timeToInteractive({ ...timing, scriptUrls: observedScripts });
  return { ...timing, tti };
}

/** Resolve the manifest entry point without leaving the paired app's origin or scope. */
export function pwaStartUrl(manifest: unknown, origin: string) {
  if (!manifest || typeof manifest !== "object" || !("start_url" in manifest) || typeof manifest.start_url !== "string")
    throw new Error("PWA manifest has no start_url");
  const url = new URL(manifest.start_url, `${origin}/pwa/manifest.webmanifest`);
  if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith("/pwa/"))
    throw new Error("PWA manifest start_url leaves the paired app");
  return url.href;
}

type PwaProbeConfig = {
  token: string;
  title: string | null;
  action: "navigation" | "language" | "theme" | "rename" | "check-off";
  choice: string | null;
};
type PwaProbeRecord = PwaProbeConfig & {
  navigation: number;
  pointer: number | null;
  pressed: number | null;
  titleAt: number | null;
  titleFrame: boolean | null;
  selected: number | null;
  done: number | null;
  hide: number | null;
  show: number | null;
  restoredFrame: number | null;
  persisted: boolean | null;
};

/** Epoch clocks let observations made before and after a document navigation share one step origin. */
export function stepMilliseconds(epoch: number | null, start: number) {
  return epoch === null ? null : Math.round(epoch - start);
}

export function assetKind(initiator: string, path: string): PwaAsset["kind"] {
  const extension = new URL(path, "https://asset.invalid").pathname;
  if (initiator === "script" || /\.m?js$/i.test(extension)) return "script";
  if (initiator === "css" || /\.css$/i.test(extension)) {
    if (/\.(?:woff2?|ttf|otf)$/i.test(extension)) return "font";
    if (/\.(?:png|jpe?g|webp|avif|svg|gif|ico)$/i.test(extension)) return "image";
    return "css";
  }
  if (/\.(?:woff2?|ttf|otf)$/i.test(extension) || initiator === "font") return "font";
  if (/\.(?:png|jpe?g|webp|avif|svg|gif|ico)$/i.test(extension) || initiator === "img" || initiator === "image") return "image";
  return "other";
}

/** Runs in every app document. sessionStorage also survives ordinary history and the timezone reload. */
export function installPwaProbe() {
  const key = "cloud.perf.pwa";
  // Epoch of this document's performance.now() zero, read from the system clock. performance.timeOrigin is derived
  // per browser process, so the documents of one step, which may live in different processes, can disagree on it.
  const epoch = Date.now() - performance.now();
  const empty = (config: PwaProbeConfig): PwaProbeRecord => ({
    ...config,
    navigation: epoch,
    pointer: null,
    pressed: null,
    titleAt: null,
    titleFrame: null,
    selected: null,
    done: null,
    hide: null,
    show: null,
    restoredFrame: null,
    persisted: null,
  });
  const stored = (): PwaProbeRecord | null => {
    // Only this init script and the harness write this private measurement record.
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string") return null;
    // Read individual fields with the same shape as reset(), without evaluating stored code.
    const number = (name: string) => {
      const item: unknown = Reflect.get(value, name);
      return typeof item === "number" ? item : null;
    };
    const string = (name: string) => {
      const item: unknown = Reflect.get(value, name);
      return typeof item === "string" ? item : null;
    };
    const bool = (name: string) => {
      const item: unknown = Reflect.get(value, name);
      return typeof item === "boolean" ? item : null;
    };
    const action = string("action");
    if (action !== "navigation" && action !== "language" && action !== "theme" && action !== "rename" && action !== "check-off")
      return null;
    return {
      token: value.token,
      title: string("title"),
      action,
      choice: string("choice"),
      navigation: number("navigation") ?? epoch,
      pointer: number("pointer"),
      pressed: number("pressed"),
      titleAt: number("titleAt"),
      titleFrame: bool("titleFrame"),
      selected: number("selected"),
      done: number("done"),
      hide: number("hide"),
      show: number("show"),
      restoredFrame: number("restoredFrame"),
      persisted: bool("persisted"),
    };
  };
  let record = stored();
  const save = () => {
    if (record) sessionStorage.setItem(key, JSON.stringify(record));
  };
  const visible = (element: Element | null) => !!element?.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
  let frame = 0;
  const sample = () => {
    frame = 0;
    if (!record) return;
    const now = epoch + performance.now();
    const control = window.__cloudPwa.control;
    const selected =
      record.action === "language"
        ? [...document.querySelectorAll('[role="radio"][aria-checked="true"]')].some(
            (element) => element.textContent?.trim() === record?.choice && visible(element),
          )
        : record.action === "theme"
          ? visible(document.querySelector(`button[aria-label^="Appearance: ${record.choice}."]`))
          : record.action === "rename" && document.querySelector('button[type="submit"][aria-busy="true"]') !== null;
    if (
      record.pointer !== null &&
      record.pressed === null &&
      control &&
      (control.matches('[data-k2b-pending], :active, [aria-busy="true"], [aria-checked="true"]') || selected)
    )
      record.pressed = now;
    // A launch can arrive at Start or a restored place; the current tab names its title.
    const expectedTitle =
      record.title ??
      (record.action === "navigation" ? document.querySelector('a[data-tab][aria-current="page"]')?.getAttribute("data-k2b-title") : null);
    if (expectedTitle && record.titleAt === null) {
      const heading = document.querySelector(".k2b-mobile-shell__title");
      const shell = document.querySelector(".k2b-mobile-shell[data-k2b-switching]");
      if (
        shell &&
        heading?.getClientRects().length &&
        heading.getAttribute("data-k2b-next-title") === expectedTitle &&
        getComputedStyle(heading, "::after").visibility !== "hidden"
      ) {
        record.titleAt = now;
        record.titleFrame = true;
      } else if (visible(heading) && !shell && heading?.textContent?.trim() === expectedTitle) {
        record.titleAt = now;
        record.titleFrame = false;
      }
    }
    if (record.pointer !== null) {
      if (selected && record.selected === null) record.selected = now;
      window.__cloudPerf.flush();
      const painted = window.__cloudPerf.fcp !== null || !PerformanceObserver.supportedEntryTypes.includes("paint");
      const done =
        record.action === "language"
          ? epoch !== record.navigation && document.documentElement.lang === (record.choice === "Deutsch" ? "de" : "en") && painted
          : record.action === "theme"
            ? selected && document.documentElement.classList.contains(record.choice === "Dark" ? "dark" : "light")
            : record.action === "rename"
              ? [...document.querySelectorAll("[data-k2b-toast]:not([data-closing])")].some(
                  (element) => visible(element) && element.textContent?.includes("Name saved"),
                ) && document.querySelector('button[type="submit"]:disabled:not([aria-busy="true"])') !== null
              : record.action === "check-off" &&
                ![...document.querySelectorAll('ul[aria-label="Tasks"] button[aria-label]')].some(
                  (element) => element.getAttribute("aria-label") === record?.choice,
                );
      if (done && record.done === null) record.done = now;
    }
    if (record.persisted && record.show !== null && record.restoredFrame === null) record.restoredFrame = now;
    save();
    // Only active steps run a frame loop, bounded by the harness's step deadline.
    frame = requestAnimationFrame(sample);
  };
  const start = () => {
    if (!frame) frame = requestAnimationFrame(sample);
  };
  window.__cloudPwa = {
    epoch,
    control: null,
    read: () => {
      if (!record) throw new Error("PWA probe not armed");
      return record;
    },
    launch: (config) => {
      if (sessionStorage.getItem("cloud.perf.pwa.launch") === config.token) return;
      window.__cloudPwa.reset(config);
      sessionStorage.setItem("cloud.perf.pwa.launch", config.token);
    },
    stop: () => {
      cancelAnimationFrame(frame);
      frame = 0;
      record = null;
      sessionStorage.removeItem(key);
    },
    reset: (config) => {
      record = empty(config);
      window.__cloudPwa.control = null;
      save();
      start();
    },
  };
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!record || !event.isPrimary) return;
      record.pointer = epoch + event.timeStamp;
      window.__cloudPwa.control = event.target instanceof Element ? event.target.closest("a,button,input") : null;
      save();
      start();
    },
    true,
  );
  window.addEventListener("pagehide", () => {
    if (record) {
      record.hide ??= epoch + performance.now();
      save();
    }
    cancelAnimationFrame(frame);
    frame = 0;
  });
  window.addEventListener("pageshow", (event) => {
    record = stored();
    if (record) {
      record.show = epoch + performance.now();
      record.persisted = event.persisted;
      save();
      start();
    }
  });
  if (window.__cloudPwaLaunch) window.__cloudPwa.launch(window.__cloudPwaLaunch);
  document.addEventListener("DOMContentLoaded", start, { once: true });
  if (record) start();
}

type PwaOptions = { runs: number; deviceName: string; remote: boolean; results: PwaProfileResult[] };
type PwaCapture = { documents: PwaDocument[]; statuses: Map<string, number>; errors: string[] };
const startTab = 'a[data-tab="start"]';
const spacesTab = 'a[data-tab="spaces"]';
const settingsLink = '.k2b-mobile-shell__actions a[href="/pwa/settings"]';

export class Browsers {
  readonly engines = new Map<Engine, Browser>();
  webkitSkip: string | null = null;
  constructor(
    readonly signal: AbortSignal,
    readonly trustedSpki?: string,
  ) {}

  async launch(endpoint: string, engines: readonly Engine[] = ["chromium", "webkit"]) {
    this.signal.throwIfAborted();
    const options = { timeout: 30_000, headers: { "x-playwright-launch-options": JSON.stringify({ headless: true }) } };
    if (engines.includes("chromium")) {
      const launch = {
        headless: true,
        args: this.trustedSpki ? [`--ignore-certificate-errors-spki-list=${this.trustedSpki}`] : [],
      };
      this.engines.set(
        "chromium",
        await chromium.connect(endpoint, { ...options, headers: { "x-playwright-launch-options": JSON.stringify(launch) } }),
      );
    }
    if (!engines.includes("webkit")) return;
    try {
      this.engines.set("webkit", await webkit.connect(endpoint, options));
    } catch (error) {
      this.signal.throwIfAborted();
      this.webkitSkip = error instanceof Error ? error.message : String(error);
      console.log(`WebKit unavailable: ${this.webkitSkip}`);
    }
  }

  versions() {
    return Object.fromEntries([...this.engines].map(([name, browser]) => [name, browser.version()]));
  }

  async measure(url: string, cookie: string, runs: number, results: BrowserResult[]) {
    for (const engine of ["chromium", "webkit"] as const)
      for (const profile of profiles) {
        const browser = this.engines.get(engine);
        const result: BrowserResult = {
          browser: engine,
          profile,
          status: browser ? "ok" : "skipped",
          reason: browser ? null : this.webkitSkip,
          cpuThrottle: engine === "chromium" ? (profile === "phone" ? 4 : 1) : null,
          network: engine === "chromium" && profile === "phone" ? phoneNetwork : null,
          transferSource: engine === "chromium" ? "cdp.encodedDataLength" : "playwright.request.sizes",
          contentEncoding: { js: [], css: [] },
          samples: [],
          metrics: null,
        };
        results.push(result);
        if (!browser) continue;
        const failures: string[] = [];
        for (let run = 0; run < runs; run++) {
          try {
            this.signal.throwIfAborted();
            console.log(`  ${engine} ${profile} ${run + 1}/${runs}`);
            const sample = await this.sample(browser, engine, profile, url, cookie);
            result.samples.push(sample.metrics);
            for (const type of ["js", "css"] as const)
              result.contentEncoding[type] = [...new Set([...result.contentEncoding[type], ...sample.encodings[type]])].sort();
            this.signal.throwIfAborted();
          } catch (error) {
            if (this.signal.aborted) {
              result.status = "failed";
              result.reason = this.signal.reason instanceof Error ? this.signal.reason.message : String(this.signal.reason);
              this.signal.throwIfAborted();
            }
            failures.push(`Run ${run + 1}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (failures.length) {
          result.status = "failed";
          result.reason = failures.join("; ");
        }
        // Incomplete profiles retain their successful raw samples, but publish no aggregate.
        else {
          try {
            result.metrics = aggregateMetrics(result.samples);
          } catch (error) {
            result.status = "failed";
            result.reason = `Cannot aggregate complete metrics: ${String(error)}`;
          }
        }
      }
  }

  async measurePwa(origin: string, phone: PhoneSession, options: PwaOptions): Promise<PwaProfileResult[]> {
    for (const profile of pwaProfileIds) {
      const engine = profile === "phone" || profile === "monitor" ? "chromium" : "webkit";
      const browser = this.engines.get(engine);
      const viewport =
        profile === "ipad-portrait"
          ? { width: 1024, height: 1366 }
          : profile === "ipad-landscape"
            ? { width: 1366, height: 1024 }
            : profile === "ipad-split-view"
              ? { width: 678, height: 1024 }
              : profile === "monitor"
                ? { width: 2560, height: 1440 }
                : { width: 390, height: 844 };
      const result: PwaProfileResult = {
        profile,
        browser: engine,
        viewport,
        deviceScaleFactor: profile.startsWith("ipad") ? 2 : profile === "monitor" ? 1 : 3,
        cpuThrottle: engine === "chromium" ? (profile === "phone" ? 4 : 1) : null,
        network: profile === "phone" ? phoneNetwork : null,
        status: browser ? "ok" : "skipped",
        reason: browser ? null : this.webkitSkip,
        steps: [],
        summary: [],
      };
      options.results.push(result);
      if (!browser) continue;
      const failures: string[] = [];
      for (let run = 1; run <= options.runs; run++) {
        for (const serviceWorker of ["allowed", "blocked"] as const) {
          try {
            this.signal.throwIfAborted();
            console.log(`  ${engine} ${profile} ${run}/${options.runs}, worker ${serviceWorker}`);
            if (serviceWorker === "allowed") {
              // Keep the measured Save enabled, including --runs 1 and a skipped WebKit engine.
              const finalRename = profile === "phone" && run === options.runs;
              const prepared = await phone.response("/pwa/_auth/session", "PATCH", {
                name: finalRename ? `${options.deviceName} ${run}` : options.deviceName,
              });
              if (prepared.status !== 204) throw new Error(`Phone name setup returned HTTP ${prepared.status}`);
            }
            await this.pwaContext(browser, origin, phone, result, run, serviceWorker, options);
          } catch (error) {
            failures.push(`Run ${run}, worker ${serviceWorker}: ${error instanceof Error ? error.message : String(error)}`);
            result.status = "failed";
            result.reason = failures.join("; ");
            this.signal.throwIfAborted();
          } finally {
            result.summary = summarizePwa(result.steps);
          }
        }
      }
    }
    return options.results;
  }

  private async pwaContext(
    browser: Browser,
    origin: string,
    phone: PhoneSession,
    result: PwaProfileResult,
    run: number,
    serviceWorker: PwaStep["serviceWorker"],
    options: PwaOptions,
  ) {
    const engine = result.browser;
    const descriptor = devices[result.profile.startsWith("ipad") ? "iPad Pro 11" : engine === "webkit" ? "iPhone 13" : "Pixel 7"];
    if (!descriptor) throw new Error("Playwright mobile device descriptor missing");
    const context = await browser.newContext({
      viewport: result.viewport,
      deviceScaleFactor: result.deviceScaleFactor,
      hasTouch: result.profile !== "monitor",
      isMobile: result.profile !== "monitor",
      ...(result.profile === "monitor" ? {} : { userAgent: descriptor.userAgent }),
      locale: measuredLocale,
      timezoneId: measuredTimeZone,
      colorScheme: "light",
      ignoreHTTPSErrors: engine !== "chromium",
      serviceWorkers: serviceWorker === "allowed" ? "allow" : "block",
    });
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        // cookies() must run before close(); it contains both credentials rotated by launch/keepalive.
        try {
          phone.takeBrowserCookies(await context.cookies());
        } finally {
          await context.close();
        }
      })());
    const abort = () => {
      void close().catch(() => {});
    };
    this.signal.addEventListener("abort", abort, { once: true });
    try {
      this.signal.throwIfAborted();
      await context.addCookies([
        ...phone.browserCookies(origin),
        { name: TIMEZONE_COOKIE, value: encodeURIComponent(measuredTimeZone), url: origin, secure: true, sameSite: "Lax" },
      ]);
      await context.addInitScript({ content: `(${installProbe.toString()})(${engine === "chromium"});(${installPwaProbe.toString()})();` });
      const seen = new Set<string>();
      let scripts: ReturnType<typeof trackHostScripts> | undefined;
      const pendingNetwork = new Set<Request>();
      let lastNetwork = performance.now();
      let capture: PwaCapture | null = null;
      const newPage = async () => {
        const page = await context.newPage();
        page.setDefaultTimeout(measurementTimeoutMs);
        page.setDefaultNavigationTimeout(measurementTimeoutMs);
        const hostScripts = trackHostScripts(page);
        scripts = hostScripts;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) hostScripts.reset();
        });
        page.on("close", () => hostScripts.stop());
        page.on("request", (request) => {
          if (["script", "stylesheet", "document", "fetch", "xhr"].includes(request.resourceType())) {
            pendingNetwork.add(request);
            lastNetwork = performance.now();
          }
        });
        const finished = (request: Request) => {
          if (pendingNetwork.delete(request)) lastNetwork = performance.now();
        };
        page.on("requestfinished", finished);
        page.on("requestfailed", (request) => {
          finished(request);
          const error = failedRequestError(request.resourceType(), request.url(), request.failure()?.errorText);
          if (error) capture?.errors.push(error);
        });
        page.on("pageerror", (error) => capture?.errors.push(error.message));
        page.on("response", (response) => {
          if (!capture) return;
          const request = response.request();
          capture.statuses.set(response.url(), response.status());
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            const url = new URL(response.url());
            capture.documents.push({
              path: url.pathname + url.search,
              status: response.status(),
              requestStartMs: null,
              responseStartMs: null,
              responseEndMs: null,
              workerStartMs: null,
              transferSize: null,
              serverTiming: [],
            });
          }
          if (["document", "script", "stylesheet"].includes(request.resourceType()) && response.status() >= 400)
            capture.errors.push(`${request.resourceType()} returned HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
        });
        if (engine === "chromium") {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: result.cpuThrottle ?? 1 });
          if (result.network)
            await cdp.send("Network.emulateNetworkConditions", {
              offline: false,
              latency: phoneNetwork.latencyMs,
              downloadThroughput: phoneNetwork.downloadBytesPerSecond,
              uploadThroughput: phoneNetwork.uploadBytesPerSecond,
              connectionType: "cellular4g",
            });
        }
        return page;
      };
      let page = await newPage();
      const quiet = async (allNetwork = false) => {
        await waitFor(
          "PWA islands mounted and scripts quiet",
          async () => {
            if (capture?.errors.length) return true;
            if (!scripts) throw new Error("PWA page has no script tracker");
            const state = await page.evaluate(
              (urls) => {
                const p = window.__cloudPerf;
                p.flush();
                const timed = new Set(p.resources.map((entry) => entry.name));
                return {
                  untimedScripts: urls.filter((url) => !timed.has(url)).length,
                  initial: p.initial?.length ?? null,
                  mounted: p.initial?.filter((element) => p.mounted.has(element)).length ?? 0,
                  errors: p.errors,
                };
              },
              [...scripts.urls],
            );
            if (state.errors.length) {
              capture?.errors.push(...state.errors);
              return true;
            }
            return (
              state.initial !== null &&
              interactive({
                initial: state.initial,
                mounted: state.mounted,
                pendingScripts: allNetwork ? pendingNetwork.size : scripts.pending.size,
                untimedScripts: state.untimedScripts,
                quietMs: performance.now() - (allNetwork ? lastNetwork : scripts.last()),
              })
            );
          },
          this.signal,
          measurementTimeoutMs,
        );
        if (capture?.errors.length) throw new Error(capture.errors.join("; "));
      };
      const tap = async (locator: Locator) => {
        await locator.scrollIntoViewIfNeeded();
        await locator.waitFor({ state: "visible" });
        if (!(await locator.isEnabled())) throw new Error("Tapped control is disabled");
        const box = await locator.boundingBox();
        if (!box) throw new Error("Tapped control has no bounds");
        if (result.profile === "monitor") await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        else await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      };
      const assertApp = async () => {
        const url = new URL(page.url());
        if (url.origin !== origin || !url.pathname.startsWith("/pwa/") || url.searchParams.has("pwa"))
          throw new Error(`Mobile app did not arrive at a paired page: ${url.pathname}${url.search}`);
        if (!(await page.locator(startTab).isVisible()) || !(await page.locator(spacesTab).isVisible()))
          throw new Error("Mobile app did not render the paired tab bar with Start and Spaces");
      };
      const measure = async (
        id: PwaStep["id"],
        round: PwaStep["round"],
        mode: "launch" | "tap" | "history",
        action: () => Promise<unknown>,
        config: Pick<PwaProbeConfig, "title" | "action" | "choice">,
      ) => {
        let timedOut = false;
        // The wait a timeout interrupted; the report names it.
        let phase = "action";
        const timeout = setTimeout(() => {
          timedOut = true;
          if (phase === "quiet")
            phase += `, scripts pending: ${[...(scripts?.pending ?? [])].map((request) => new URL(request.url()).pathname).join(", ") || "none"}`;
          abort();
        }, measurementTimeoutMs);
        capture = { documents: [], statuses: new Map(), errors: [] };
        const current = capture;
        try {
          const probeConfig = { ...config, token: crypto.randomUUID() };
          let previousOrigin: number | null = null;
          if (mode !== "launch") {
            previousOrigin = await page.evaluate((config) => {
              window.__cloudPwa.reset(config);
              return performance.timeOrigin;
            }, probeConfig);
          }
          // New pages get one step record, retained through redirects and the timezone reload.
          if (mode === "launch")
            await page.addInitScript((config) => {
              // Either init script can run first; arm before product scripts, including timezone reloads.
              window.__cloudPwaLaunch = config;
              window.__cloudPwa?.launch(config);
            }, probeConfig);
          await action();
          phase = "arrival";
          await waitFor(
            `PWA ${id} arrival`,
            async () => {
              if (current.errors.length) return true;
              return page.evaluate(
                ({ mode, previousOrigin, action }) => {
                  const record = window.__cloudPwa.read();
                  if (mode === "history") return record.show !== null && record.hide !== null;
                  if (mode === "launch") return document.readyState !== "loading" && record.titleAt !== null;
                  if (action !== "navigation") return record.done !== null;
                  return performance.timeOrigin !== previousOrigin && document.readyState !== "loading";
                },
                { mode, previousOrigin, action: config.action },
              );
            },
            this.signal,
            measurementTimeoutMs,
          );
          phase = "reload";
          if (id === "launch-timezone")
            await waitFor("PWA timezone reload", async () => current.documents.length >= 2, this.signal, measurementTimeoutMs);
          phase = "quiet";
          await quiet();
          phase = "service worker";
          if (id === "launch-first" && serviceWorker === "allowed")
            await waitFor(
              "PWA service worker ready",
              () =>
                page.evaluate(async () => {
                  const registration = await Promise.race([
                    navigator.serviceWorker.ready,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
                  ]);
                  return registration !== null;
                }),
              this.signal,
              measurementTimeoutMs,
            );
          phase = "snapshot";
          await assertApp();
          const snapshot = await page.evaluate(() => {
            const p = window.__cloudPerf;
            p.flush();
            const record = window.__cloudPwa.read();
            const navigation = performance.getEntriesByType("navigation")[0];
            const status = (entry: PerformanceResourceTiming) =>
              "responseStatus" in entry && typeof entry.responseStatus === "number" && entry.responseStatus > 0
                ? entry.responseStatus
                : null;
            const nav =
              navigation instanceof PerformanceNavigationTiming
                ? {
                    path: location.pathname + location.search,
                    status: status(navigation),
                    epoch: window.__cloudPwa.epoch,
                    requestStart: navigation.requestStart,
                    responseStart: navigation.responseStart,
                    responseEnd: navigation.responseEnd,
                    workerStart: navigation.workerStart,
                    transferSize: navigation.transferSize,
                    serverTiming: navigation.serverTiming.map((entry) => ({ name: entry.name, durationMs: entry.duration })),
                  }
                : null;
            const resources = performance.getEntriesByType("resource").flatMap((entry) => {
              if (
                !(entry instanceof PerformanceResourceTiming) ||
                new URL(entry.name).origin !== location.origin ||
                ["fetch", "xmlhttprequest", "beacon"].includes(entry.initiatorType)
              )
                return [];
              return [
                {
                  url: entry.name,
                  initiator: entry.initiatorType,
                  transferSize: entry.transferSize,
                  encodedBodySize: entry.encodedBodySize,
                  status: status(entry),
                },
              ];
            });
            return {
              record,
              nav,
              resources,
              fcp: p.fcp === null ? null : window.__cloudPwa.epoch + p.fcp,
              mounted: p.initial?.length
                ? window.__cloudPwa.epoch + Math.max(...p.initial.map((element) => p.mounted.get(element) ?? 0))
                : null,
            };
          });
          const record = snapshot.record;
          const restored = mode === "history" && record.persisted === true;
          // A history step starts when the browser leaves the page: at pagehide for a cached page, otherwise at the
          // arrived document's navigation start, which precedes the old page's pagehide.
          const start =
            mode === "launch"
              ? record.navigation
              : mode === "history"
                ? restored
                  ? record.hide
                  : (snapshot.nav?.epoch ?? null)
                : record.pointer;
          if (start === null) throw new Error(`Missing ${mode} step origin`);
          const relative = (epoch: number | null) => stepMilliseconds(epoch, start);
          const hasDocument = current.documents.length > 0 && !restored;
          if (hasDocument && snapshot.nav) {
            const nav = snapshot.nav;
            const final = current.documents.at(-1);
            if (final)
              Object.assign(final, {
                status: nav.status ?? final.status,
                requestStartMs: relative(nav.epoch + nav.requestStart),
                responseStartMs: relative(nav.epoch + nav.responseStart),
                responseEndMs: relative(nav.epoch + nav.responseEnd),
                workerStartMs: nav.workerStart > 0 ? relative(nav.epoch + nav.workerStart) : null,
                transferSize: nav.transferSize ?? null,
                serverTiming: nav.serverTiming,
              });
          }
          const assets: PwaAsset[] = hasDocument
            ? snapshot.resources.map((entry) => {
                const url = new URL(entry.url);
                const path = url.pathname + url.search;
                const status = entry.status ?? current.statuses.get(entry.url) ?? null;
                return {
                  path,
                  kind: assetKind(entry.initiator, path),
                  status,
                  transferSize: entry.transferSize ?? null,
                  encodedBodySize: entry.encodedBodySize ?? null,
                  state: assetCacheState({ transferSize: entry.transferSize, status }),
                  // A file seen before under another cache-busting query is a repeat too: the browser loads it again.
                  repeat: seen.has(url.pathname),
                };
              })
            : [];
          for (const entry of snapshot.resources) seen.add(new URL(entry.url).pathname);
          const step: PwaStep = {
            id,
            finalPath: new URL(page.url()).pathname + new URL(page.url()).search,
            run,
            round,
            serviceWorker,
            pressedMs: mode === "tap" ? relative(record.pressed) : null,
            titleMs: relative(record.titleAt),
            titleFrame: record.titleFrame,
            contentMs: restored ? relative(record.restoredFrame) : hasDocument ? relative(snapshot.fcp) : null,
            mountedMs: hasDocument ? relative(snapshot.mounted) : null,
            selectedMs: relative(record.selected),
            doneMs: id === "relaunch-start-url" ? relative(record.titleAt) : relative(record.done),
            persisted: mode === "history" ? record.persisted : null,
            documents: restored ? [] : current.documents,
            assets,
          };
          if (current.errors.length) throw new Error(current.errors.join("; "));
          if (config.action === "navigation" && step.titleMs === null) throw new Error(`Target title was not observed: ${config.title}`);
          if (
            id === "launch-expired" &&
            !(
              step.documents.length === 3 &&
              step.documents[0]?.path === "/pwa/" &&
              step.documents[1]?.path.startsWith("/pwa/_auth/session/launch?") &&
              step.documents[2]?.path === "/pwa/?pwa_launch=1"
            )
          )
            throw new Error("Expired session launch did not take the three-document renewal bounce");
          if (id === "launch-timezone" && step.documents.length !== 2) throw new Error("Timezone launch did not reload exactly once");
          // Validate here, so an impossible sample fails its profile instead of the whole result file.
          result.steps.push(pwaStepSchema.parse(step));
          phone.takeBrowserCookies(await context.cookies());
        } catch (error) {
          throw new Error(
            `${id}: ${timedOut ? `step timed out after ${measurementTimeoutMs} ms waiting for ${phase}` : error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          capture = null;
          await page.evaluate(() => window.__cloudPwa.stop()).catch(() => {});
          clearTimeout(timeout);
        }
      };
      const navigation = (title: string | null) => ({ title, action: "navigation" as const, choice: null });
      const launch = async (id: "launch-first" | "launch-warm" | "launch-expired" | "launch-timezone", fresh = false) => {
        if (fresh) {
          await page.close();
          if (id === "launch-expired") await context.clearCookies({ name: "pwa_session" });
          if (id === "launch-timezone") await context.clearCookies({ name: TIMEZONE_COOKIE });
          page = await newPage();
        }
        await measure(
          id,
          id === "launch-first" ? 1 : 2,
          "launch",
          () => page.goto(`${origin}/pwa/`, { waitUntil: "domcontentloaded" }),
          navigation(null),
        );
      };
      await launch("launch-first");
      const startTitle = await page.locator(startTab).getAttribute("data-k2b-title");
      if (!startTitle) throw new Error("Start tab has no page title");
      // Settings is titled with its link's label; tabs name their page's title.
      const settingsTitle = await page.locator(settingsLink).getAttribute("aria-label");
      if (!settingsTitle) throw new Error("Settings link has no label");
      const tab = async (id: PwaStep["id"], round: PwaStep["round"], selector: string) => {
        const title = selector === settingsLink ? settingsTitle : await page.locator(selector).getAttribute("data-k2b-title");
        if (!title) throw new Error("Tab has no target title");
        await measure(id, round, "tap", () => tap(page.locator(selector)), navigation(title));
      };
      for (const round of [1, 2] as const) {
        await tab("tab-start-spaces", round, spacesTab);
        await tab("tab-spaces-start", round, startTab);
        await tab("tab-start-settings", round, settingsLink);
        await tab("tab-settings-start", round, startTab);
      }
      if (serviceWorker === "allowed") {
        await measure("history-back", 2, "history", () => page.goBack({ waitUntil: "domcontentloaded" }), navigation(settingsTitle));
        await measure("history-forward", 2, "history", () => page.goForward({ waitUntil: "domcontentloaded" }), navigation(startTitle));
      }
      const manifestResponse = await context.request.get(`${origin}/pwa/manifest.webmanifest`);
      if (!manifestResponse.ok()) throw new Error(`PWA manifest returned HTTP ${manifestResponse.status()}`);
      const startUrl = pwaStartUrl(await manifestResponse.json(), origin);
      await page.close();
      page = await newPage();
      await measure("relaunch-start-url", 2, "launch", () => page.goto(startUrl, { waitUntil: "domcontentloaded" }), navigation(null));
      if (serviceWorker === "blocked") return;
      if (new URL(page.url()).pathname !== "/pwa/") {
        await Promise.all([page.waitForURL(`${origin}/pwa/`), tap(page.locator(startTab))]);
        await quiet();
      }
      await Promise.all([page.waitForURL(`${origin}/pwa/settings`), tap(page.locator(settingsLink))]);
      await quiet();
      for (const [language, label] of [
        ["de", "Deutsch"],
        ["en", "English"],
      ] as const)
        await measure(`language-${language}`, 1, "tap", () => tap(page.getByRole("radio", { name: label, exact: true })), {
          title: null,
          action: "language",
          choice: label,
        });
      for (const [theme, label] of [
        ["light", "Light"],
        ["dark", "Dark"],
        ["system", "Automatic"],
      ] as const)
        await measure(`theme-${theme}`, 1, "tap", () => tap(page.getByRole("button", { name: /^Appearance:/ })), {
          title: null,
          action: "theme",
          choice: label,
        });
      const name = result.profile === "phone" && run === options.runs ? options.deviceName : `${options.deviceName} ${run}`;
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
      await measure("rename", 1, "tap", () => tap(page.getByRole("button", { name: "Save", exact: true })), {
        title: null,
        action: "rename",
        choice: null,
      });
      if (!options.remote) {
        await Promise.all([page.waitForURL(`${origin}/pwa/spaces`), tap(page.locator(spacesTab))]);
        await quiet();
        const list = page.getByRole("list", { name: "Tasks", exact: true });
        const check = list.getByRole("button", { name: /^Mark .+ as done$/ }).first();
        const label = await check.getAttribute("aria-label");
        if (!label) throw new Error("Task check button has no label");
        await measure("check-off", 1, "tap", () => tap(check), { title: null, action: "check-off", choice: label });
        await tap(page.getByRole("button", { name: "Undo", exact: true }));
        await list.getByRole("button", { name: label, exact: true }).waitFor({ state: "visible" });
        await quiet(true);
        if ((await list.getByRole("button", { name: /^Mark .+ as done$/ }).count()) !== 12)
          throw new Error("Undo did not restore the 12-task fixture");
      }
      await launch("launch-warm", true);
      await launch("launch-expired", true);
      await launch("launch-timezone", true);
    } finally {
      this.signal.removeEventListener("abort", abort);
      await close();
    }
  }

  /** One cold load in a fresh context; hooks may extend it while the page is still open. */
  async sample<T = undefined>(browser: Browser, engine: Engine, profile: Profile, url: string, cookie: string, hooks: LoadHooks<T> = {}) {
    const timeoutMs = hooks.timeoutMs ?? measurementTimeoutMs;
    const context = await browser.newContext({
      viewport: profile === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: profile === "phone" ? 3 : 1,
      isMobile: profile === "phone",
      hasTouch: profile === "phone",
      locale: measuredLocale,
      timezoneId: measuredTimeZone,
      colorScheme: "light",
      serviceWorkers: "block",
      ignoreHTTPSErrors: engine !== "chromium",
    });
    const abort = () => {
      void context.close().catch(() => {});
    };
    this.signal.addEventListener("abort", abort, { once: true });
    // Also bound evaluate()/CDP calls when a page's main thread hangs.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    try {
      await context.addCookies([
        { name: "session_token", value: cookie, url: new URL(url).origin, secure: true, httpOnly: true, sameSite: "Lax" },
        // A returning user already has this cookie; without it the first visit reloads once to render in the browser's zone.
        { name: TIMEZONE_COOKIE, value: encodeURIComponent(measuredTimeZone), url: new URL(url).origin, secure: true, sameSite: "Lax" },
      ]);
      const page = await context.newPage();
      await page.addInitScript(installProbe, engine === "chromium");
      const bytes = { document: 0, js: 0, css: 0, other: 0 };
      const counts = { document: 0, js: 0, css: 0, other: 0 };
      const encodings = { js: new Set<string>(), css: new Set<string>() };
      const scripts = trackHostScripts(page);
      const requests = new Map<string, TransferType>();
      const sizeJobs: Promise<void>[] = [];
      const errors: string[] = [];
      let collecting = true;
      page.on("request", (request) => {
        if (!collecting) return;
        counts[transferType(request.resourceType())]++;
      });
      page.on("requestfinished", (request) => {
        if (!collecting) return;
        if (engine === "webkit")
          sizeJobs.push(
            request
              .sizes()
              .then((size) => {
                bytes[transferType(request.resourceType())] += size.responseBodySize + size.responseHeadersSize;
              })
              .catch((error: unknown) => {
                errors.push(`Cannot read transfer size: ${String(error)}`);
              }),
          );
      });
      page.on("requestfailed", (request) => {
        if (!collecting) return;
        const error = failedRequestError(request.resourceType(), request.url(), request.failure()?.errorText);
        if (error) errors.push(error);
      });
      let documents = 0;
      page.on("framenavigated", (frame) => {
        if (collecting && frame === page.mainFrame() && ++documents > 1)
          errors.push(`Page navigated again during the measurement: ${frame.url()}`);
      });
      page.on("pageerror", (error) => {
        if (collecting) errors.push(error.message);
      });
      page.on("response", (response) => {
        if (!collecting) return;
        const type = transferType(response.request().resourceType());
        if (type === "js" || type === "css") {
          const encoding = response.headers()["content-encoding"] ?? "identity";
          encodings[type].add(encoding);
          if (!response.ok()) errors.push(`${type} returned ${response.status()}: ${new URL(response.url()).pathname}`);
          if (engine === "chromium" && !["br", "gzip"].includes(encoding))
            errors.push(`Gateway served uncompressed ${type}: ${new URL(response.url()).pathname}`);
        }
      });
      let cdp: CDPSession | undefined;
      if (engine === "chromium") {
        cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        cdp.on(
          "Network.requestWillBeSent",
          (event: { requestId: string; type?: string; redirectResponse?: { encodedDataLength: number } }) => {
            if (!collecting) return;
            const previous = requests.get(event.requestId);
            if (previous && event.redirectResponse) bytes[previous] += event.redirectResponse.encodedDataLength;
            requests.set(event.requestId, transferType(event.type ?? "other"));
          },
        );
        cdp.on("Network.loadingFinished", (event: { requestId: string; encodedDataLength: number }) => {
          if (collecting) bytes[requests.get(event.requestId) ?? "other"] += event.encodedDataLength;
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile === "phone" ? 4 : 1 });
        if (profile === "phone")
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: phoneNetwork.latencyMs,
            downloadThroughput: phoneNetwork.downloadBytesPerSecond,
            uploadThroughput: phoneNetwork.uploadBytesPerSecond,
            connectionType: "cellular4g",
          });
      }
      await hooks.beforeLoad?.(page, context);
      const start = performance.now();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: measurementTimeoutMs });
      if (!response) throw new Error("No document response");
      validatePage(response.status(), url, page.url(), await response.text());
      const domContentLoadedMs = Math.round(performance.now() - start);
      const timing = await observeTti(page, scripts, this.signal, errors, start, domContentLoadedMs);
      scripts.stop();
      collecting = false;
      await Promise.all(sizeJobs);
      if (timing.errors.length || errors.length) throw new Error([...timing.errors, ...errors].join("; "));
      const tti = timing.tti;
      const cls = cumulativeLayoutShift(timing.shifts);
      const longtasks =
        engine === "chromium" ? longTaskMetrics(timing.longtasks, timing.fcp, tti) : { lastLongTaskEndMs: null, totalBlockingTimeMs: null };
      const ms = (n: number | null) => (n === null ? null : Math.round(n));
      const metrics: Metrics = metricsSchema.parse({
        documentBytes: Math.round(bytes.document),
        jsBytes: Math.round(bytes.js),
        cssBytes: Math.round(bytes.css),
        otherBytes: Math.round(bytes.other),
        documentRequests: counts.document,
        jsRequests: counts.js,
        cssRequests: counts.css,
        otherRequests: counts.other,
        requests: Object.values(counts).reduce((a, b) => a + b, 0),
        fcpMs: ms(timing.fcp),
        lcpMs: ms(timing.lcp),
        cls: cls === null ? null : Number(cls.toFixed(4)),
        ttiMs: Math.round(tti),
        ...longtasks,
      });
      const after = await hooks.afterLoad?.(
        page,
        {
          fcp: timing.fcp,
          lcp: timing.lcp,
          tti,
          mountStarts: timing.mountStarts,
          mountTimes: timing.mountTimes,
          longtasks: timing.longtasks,
        },
        cdp,
      );
      await cdp?.detach();
      return { metrics, encodings: { js: [...encodings.js].sort(), css: [...encodings.css].sort() }, after };
    } catch (error) {
      if (timedOut) throw new Error(`Browser load timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener("abort", abort);
      await context.close();
    }
  }

  async close() {
    for (const browser of this.engines.values()) await browser.close();
  }
}
