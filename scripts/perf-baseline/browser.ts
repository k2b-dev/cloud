// Playwright is an existing @k2b/ui devDependency in this isolated-linker workspace.
import { createRequire } from "node:module";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { TIMEZONE_COOKIE } from "../../packages/cloud/src/shared/time";
import {
  aggregateMetrics,
  type BrowserResult,
  cumulativeLayoutShift,
  failedRequestError,
  interactive,
  longTaskMetrics,
  type Metrics,
  metricsSchema,
  timeToInteractive,
  validatePage,
} from "./model";

const { chromium, webkit }: typeof import("playwright") = createRequire(new URL("../../packages/ui/package.json", import.meta.url))(
  "playwright",
);

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

export class Browsers {
  readonly engines = new Map<Engine, Browser>();
  webkitSkip: string | null = null;
  constructor(
    readonly signal: AbortSignal,
    readonly trustedSpki: string,
  ) {}

  async launch(endpoint: string, engines: readonly Engine[] = ["chromium", "webkit"]) {
    this.signal.throwIfAborted();
    const options = { timeout: 30_000, headers: { "x-playwright-launch-options": JSON.stringify({ headless: true }) } };
    if (engines.includes("chromium")) {
      const launch = {
        headless: true,
        args: [`--ignore-certificate-errors-spki-list=${this.trustedSpki}`],
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
