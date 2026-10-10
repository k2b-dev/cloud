// Playwright is an existing @k2b/ui devDependency in this isolated-linker workspace.
import { createRequire } from "node:module";
import type { Browser, CDPSession, Request } from "playwright";
import { TIMEZONE_COOKIE } from "../../packages/cloud/src/shared/time";
import { aggregateMetrics, type BrowserResult, interactive, longTaskMetrics, type Metrics, metricsSchema, validatePage } from "./model";

const { chromium, webkit }: typeof import("playwright") = createRequire(new URL("../../packages/ui/package.json", import.meta.url))(
  "playwright",
);

export const profiles = ["desktop", "phone"] as const;
export const fast4g = { latencyMs: 150, downloadBytesPerSecond: 200_000, uploadBytesPerSecond: 93_750 };
export const measurementTimeoutMs = 45_000;
/** Fixed browser time zone, stored in Cloud's timezone cookie like on a returning user's device. */
export const measuredTimeZone = "Europe/Berlin";
type TransferType = "document" | "js" | "css" | "other";
/** Chromium's abort when a host network interface changes mid-load; the load measured nothing. */
export const isNetworkChange = (error: unknown) => error instanceof Error && error.message.includes("net::ERR_NETWORK_CHANGED");

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
  mounted: Set<Element>;
  errors: string[];
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
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
    mounted: new Set(),
    errors: [],
    fcp: null,
    lcp: null,
    cls: null,
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
      if (mount) collect();
      setter.call(this, value);
      // render() is synchronous and follows this setter in @k2b/ssr/src/mount.ts.
      // The microtask runs after that render stack; thrown/caught errors dispatch ssr:island-error.
      if (mount)
        queueMicrotask(() => {
          probe.mounted.add(this);
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
  if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) probe.cls = 0;
  observe("layout-shift", (entries) => {
    for (const entry of entries)
      if ("hadRecentInput" in entry && entry.hadRecentInput === false && "value" in entry && typeof entry.value === "number")
        probe.cls = (probe.cls ?? 0) + entry.value;
  });
  if (chromiumEngine)
    observe("longtask", (entries) => {
      for (const entry of entries) probe.longtasks.push({ start: entry.startTime, duration: entry.duration });
    });
  probe.flush = () => {
    for (const { observer, consume } of handlers) consume(observer.takeRecords());
  };
}

export class Browsers {
  readonly engines = new Map<"chromium" | "webkit", Browser>();
  webkitSkip: string | null = null;
  constructor(
    readonly tempDirectory: string,
    readonly signal: AbortSignal,
  ) {}

  async launch(startWebkit: () => Promise<string>) {
    this.signal.throwIfAborted();
    const options = { headless: true, timeout: 30_000, env: { ...Bun.env, TMPDIR: this.tempDirectory } };
    this.engines.set("chromium", await chromium.launch(options));
    try {
      const endpoint = await startWebkit();
      this.engines.set(
        "webkit",
        await webkit.connect(endpoint, { timeout: 30_000, headers: { "x-playwright-launch-options": JSON.stringify({ headless: true }) } }),
      );
    } catch (error) {
      this.signal.throwIfAborted();
      this.webkitSkip = error instanceof Error ? error.message : String(error);
      console.log(`WebKit unavailable: ${this.webkitSkip}`);
    }
  }

  versions() {
    return Object.fromEntries([...this.engines].map(([name, browser]) => [name, browser.version()]));
  }

  async measure(url: string, cookie: string, runs: number): Promise<BrowserResult[]> {
    const results: BrowserResult[] = [];
    for (const engine of ["chromium", "webkit"] as const)
      for (const profile of profiles) {
        const browser = this.engines.get(engine);
        const result: BrowserResult = {
          browser: engine,
          profile,
          status: browser ? "ok" : "skipped",
          reason: browser ? null : this.webkitSkip,
          cpuThrottle: engine === "chromium" ? (profile === "phone" ? 4 : 1) : null,
          network: engine === "chromium" && profile === "phone" ? fast4g : null,
          transferSource: engine === "chromium" ? "cdp.encodedDataLength" : "playwright.request.sizes",
          contentEncoding: { js: [], css: [] },
          samples: [],
          metrics: null,
        };
        results.push(result);
        if (!browser) continue;
        const failures: string[] = [];
        for (let run = 0; run < runs; run++) {
          this.signal.throwIfAborted();
          console.log(`  ${engine} ${profile} ${run + 1}/${runs}`);
          try {
            // Docker on a shared host adds and removes interfaces at any time; Chromium then aborts
            // the navigation with ERR_NETWORK_CHANGED. Such a load measured nothing, so it is repeated once.
            const sample = await this.sample(browser, engine, profile, url, cookie).catch((error: unknown) => {
              if (!isNetworkChange(error)) throw error;
              console.log(`  ${engine} ${profile} ${run + 1}/${runs}: network changed during load, repeating it`);
              return this.sample(browser, engine, profile, url, cookie);
            });
            result.samples.push(sample.metrics);
            for (const type of ["js", "css"] as const)
              result.contentEncoding[type] = [...new Set([...result.contentEncoding[type], ...sample.encodings[type]])].sort();
          } catch (error) {
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
    return results;
  }

  private async sample(browser: Browser, engine: "chromium" | "webkit", profile: "desktop" | "phone", url: string, cookie: string) {
    const context = await browser.newContext({
      viewport: profile === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: profile === "phone" ? 3 : 1,
      isMobile: profile === "phone",
      hasTouch: profile === "phone",
      locale: "en-US",
      timezoneId: measuredTimeZone,
      colorScheme: "light",
      serviceWorkers: "block",
      ignoreHTTPSErrors: true,
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
    }, measurementTimeoutMs);
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
      const pendingScripts = new Set<Request>();
      const requests = new Map<string, TransferType>();
      const sizeJobs: Promise<void>[] = [];
      const errors: string[] = [];
      let collecting = true;
      let lastScript = performance.now();
      const finishScript = (request: Request) => {
        if (pendingScripts.delete(request)) lastScript = performance.now();
      };
      page.on("request", (request) => {
        if (!collecting) return;
        counts[transferType(request.resourceType())]++;
        if (request.resourceType() === "script") {
          pendingScripts.add(request);
          lastScript = performance.now();
        }
      });
      page.on("requestfinished", (request) => {
        if (!collecting) return;
        finishScript(request);
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
        if (collecting && pendingScripts.has(request)) errors.push(`Script request failed: ${new URL(request.url()).pathname}`);
        finishScript(request);
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
            latency: fast4g.latencyMs,
            downloadThroughput: fast4g.downloadBytesPerSecond,
            uploadThroughput: fast4g.uploadBytesPerSecond,
            connectionType: "cellular4g",
          });
      }
      const start = performance.now();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: measurementTimeoutMs });
      if (!response) throw new Error("No document response");
      validatePage(response.status(), url, page.url(), await response.text());
      let tti: number | null = null;
      while (performance.now() - start < measurementTimeoutMs) {
        this.signal.throwIfAborted();
        const state = await page.evaluate(() => ({
          initial: window.__cloudPerf.initial?.length ?? null,
          mounted: window.__cloudPerf.initial?.filter((element) => window.__cloudPerf.mounted.has(element)).length ?? 0,
          errors: window.__cloudPerf.errors,
        }));
        if (state.errors.length || errors.length) throw new Error([...state.errors, ...errors].join("; "));
        if (
          state.initial !== null &&
          interactive({
            initial: state.initial,
            mounted: state.mounted,
            pendingScripts: pendingScripts.size,
            quietMs: performance.now() - lastScript,
          })
        ) {
          tti = await page.evaluate(() => performance.now());
          break;
        }
        await Bun.sleep(50);
      }
      if (tti === null)
        throw new Error(`TTI timed out after ${measurementTimeoutMs} ms (initial islands did not mount or scripts did not become quiet)`);
      collecting = false;
      await Promise.all(sizeJobs);
      const timing = await page.evaluate(() => {
        const p = window.__cloudPerf;
        p.flush();
        for (const observer of p.observers) observer.disconnect();
        return { fcp: p.fcp, lcp: p.lcp, cls: p.cls, longtasks: p.longtasks, errors: p.errors };
      });
      if (timing.errors.length || errors.length) throw new Error([...timing.errors, ...errors].join("; "));
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
        cls: timing.cls === null ? null : Number(timing.cls.toFixed(4)),
        ttiMs: Math.round(tti),
        ...longtasks,
      });
      await cdp?.detach();
      return { metrics, encodings: { js: [...encodings.js].sort(), css: [...encodings.css].sort() } };
    } catch (error) {
      if (timedOut) throw new Error(`Browser load timed out after ${measurementTimeoutMs} ms`);
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
