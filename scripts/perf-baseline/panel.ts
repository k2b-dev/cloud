import type { Browser, BrowserContext, Page, Request } from "playwright";
import { TIMEZONE_COOKIE } from "../../packages/cloud/src/shared/time";
import { measureStatic } from "./assets";
import {
  type Browsers,
  type Engine,
  installProbe,
  measuredLocale,
  measuredTimeZone,
  measurementTimeoutMs,
  observeTti,
  phoneNetwork,
  trackHostScripts,
} from "./browser";
import {
  aggregatePanel,
  decodeAttribute,
  dominantPanelSegment,
  medianPanelSample,
  type PageResult,
  type PanelNavigation,
  type PanelProfile,
  type PanelResult,
  type PanelSample,
  panelLayouts,
  panelSampleSchema,
  panelSplit,
  panelVerdict,
  validatePage,
} from "./model";
import { installPanelProbe, type PanelHeading, panelEndState } from "./panel-probe";
import { buildRoot, localTls } from "./runtime";
import type { Api } from "./seed";

export const panelApps = ["core", "spaces", "mail", "notebooks", "gateway"];
export const panelViewports = {
  column: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  drawer: { width: 834, height: 1194, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  sheet: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function panelNavigations(pages: PageResult[]): PanelNavigation[] {
  const path = (id: PageResult["id"]) => pages.find((page) => page.id === id)?.path ?? "missing fixture";
  const spaces = path("spaces"),
    mail = path("mail-mailbox"),
    notebooks = path("notebooks-editor");
  // Spaces pages and the Mail mailbox pass Layout help ids; the Mail and Notebooks overviews and the editor do not.
  const routes: Pick<PanelNavigation, "id" | "from" | "to" | "crossApp" | "heading" | "fromHeading">[] = [
    { id: "spaces", from: "/app/spaces", to: spaces, crossApp: false, heading: "view", fromHeading: "view" },
    { id: "mail", from: "/app/mail", to: mail, crossApp: false, heading: "view", fromHeading: "start" },
    { id: "notebooks", from: "/app/notebooks", to: notebooks, crossApp: false, heading: "start", fromHeading: "start" },
    { id: "spaces-to-mail", from: spaces, to: mail, crossApp: true, heading: "view", fromHeading: "view" },
  ];
  return routes.map((nav) => {
    const errors = pages
      .filter((page) => page.status === "failed" && (page.path === nav.to || page.path === nav.from))
      .flatMap((page) => page.errors);
    if (nav.to === "missing fixture" || nav.from === "missing fixture") errors.push("Missing seeded navigation path");
    return { ...nav, status: errors.length ? "failed" : "ok", errors, providerStatic: null, profiles: [] };
  });
}

/** Parse the actual SSR iframe URL; provider routes belong to the provider, not this harness. */
export async function providerHref(html: string, hostUrl: string) {
  const sources: string[] = [];
  await new HTMLRewriter()
    .on('iframe[data-cloud-panel-frame="core"][src]', {
      element(element) {
        const src = element.getAttribute("src");
        if (src) sources.push(src);
      },
    })
    .transform(new Response(html))
    .text();
  if (sources.length !== 1 || !sources[0]) throw new Error(`Expected one SSR Help provider iframe, found ${sources.length}`);
  const url = new URL(decodeAttribute(sources[0]), hostUrl);
  if (url.origin !== new URL(hostUrl).origin) throw new Error("Help provider must be same-origin");
  return url.href;
}
async function providerStatic(api: Api, nav: PanelNavigation) {
  const headers = {
    cookie: `session_token=${api.cookie}; ${TIMEZONE_COOKIE}=${encodeURIComponent(measuredTimeZone)}; cloud_panel=1:core:`,
    "accept-language": measuredLocale,
  };
  const read = async (url: string) => {
    const response = await fetch(url, {
      ...localTls(url, api.origin),
      headers,
      redirect: "manual",
      signal: AbortSignal.any([api.signal, AbortSignal.timeout(30_000)]),
    });
    const html = await response.text();
    validatePage(response.status, url, response.url, html);
    return html;
  };
  const hostUrl = new URL(nav.to, api.origin).href;
  const url = await providerHref(await read(hostUrl), hostUrl);
  nav.providerStatic = await measureStatic(await read(url), url, buildRoot, panelApps);
}

/** Runs in the host and provider; persist errors across the full-document hop. */
export function installPanelErrors() {
  if (window !== window.top && window.frameElement?.getAttribute("data-cloud-panel-frame") !== "core") return;
  const fail = (error: string) => {
    const store = window.top?.sessionStorage;
    if (!store) return;
    store.setItem(
      "cloud-panel-perf-errors",
      `${store.getItem("cloud-panel-perf-errors") ?? ""}\n${window === window.top ? "host" : "provider"}: ${error}`,
    );
  };
  window.addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) fail(event.message);
  });
  window.addEventListener("unhandledrejection", (event) => fail(`Unhandled rejection: ${String(event.reason)}`));
  document.addEventListener("ssr:island-error", () => fail("ssr:island-error"));
}

async function withPanelPage<T>(
  browser: Browser,
  engine: Engine,
  layout: PanelProfile["layout"],
  api: Api,
  work: (page: Page) => Promise<T>,
) {
  const { width, height, ...device } = panelViewports[layout];
  const context = await browser.newContext({
    viewport: { width, height },
    ...device,
    locale: measuredLocale,
    timezoneId: measuredTimeZone,
    colorScheme: "light",
    serviceWorkers: "block",
    ignoreHTTPSErrors: engine !== "chromium",
  });
  return boundedContext(context, api.signal, async () => {
    await context.addCookies([
      { name: "session_token", value: api.cookie, url: api.origin, secure: true, httpOnly: true, sameSite: "Lax" },
      { name: TIMEZONE_COOKIE, value: encodeURIComponent(measuredTimeZone), url: api.origin, secure: true, sameSite: "Lax" },
      ...(layout === "sheet" ? [] : [{ name: "cloud_panel", value: "1:core:", url: api.origin, secure: true, sameSite: "Lax" as const }]),
    ]);
    await context.addInitScript(installProbe, engine === "chromium");
    await context.addInitScript({ content: `(${installPanelProbe.toString()})(${panelEndState.toString()});` });
    await context.addInitScript(installPanelErrors);
    const page = await context.newPage();
    page.setDefaultTimeout(measurementTimeoutMs);
    if (engine === "chromium") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: layout === "sheet" ? 4 : 1 });
      if (layout === "sheet")
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: phoneNetwork.latencyMs,
          downloadThroughput: phoneNetwork.downloadBytesPerSecond,
          uploadThroughput: phoneNetwork.uploadBytesPerSecond,
          connectionType: "cellular4g",
        });
    }
    return work(page);
  });
}

/** Only closes this sample's context; bounds a hung evaluate/CDP call as well as normal waits. */
async function boundedContext<T>(context: BrowserContext, signal: AbortSignal, work: () => Promise<T>) {
  const close = () => {
    void context.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    close();
  }, 5 * measurementTimeoutMs);
  try {
    signal.throwIfAborted();
    return await work();
  } catch (error) {
    signal.throwIfAborted();
    if (expired) throw new Error("Panel sample exceeded its five-stage deadline");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", close);
    await context.close();
  }
}

async function goto(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: measurementTimeoutMs });
  if (!response) throw new Error("No host document response");
  validatePage(response.status(), url, page.url(), await response.text());
}
async function waitForPanel(page: Page) {
  await page.waitForFunction(
    () =>
      window.__cloudPanelPerf.hitAt !== null ||
      window.__cloudPanelPerf.timedOut !== null ||
      !!sessionStorage.getItem("cloud-panel-perf-errors"),
    undefined,
    {
      timeout: measurementTimeoutMs + 5_000,
      polling: "raf",
    },
  );
  const p = await page.evaluate(() => {
    const { arm: _arm, ...state } = window.__cloudPanelPerf;
    return state;
  });
  const errors = await page.evaluate(() => sessionStorage.getItem("cloud-panel-perf-errors"));
  if (errors) throw new Error(errors);
  if (p.timedOut) throw new Error(`Panel content timed out: ${p.timedOut}`);
  return p;
}
async function warmPanel(page: Page, heading: PanelHeading) {
  await page.evaluate((heading) => window.__cloudPanelPerf.arm({ mode: "navigation", heading, timeoutMs: 45_000 }), heading);
  await waitForPanel(page);
}
async function assertErrors(page: Page, errors: string[]) {
  const recorded = await page.evaluate(() => sessionStorage.getItem("cloud-panel-perf-errors"));
  if (recorded || errors.length) throw new Error([...errors, recorded].filter(Boolean).join("; "));
}

export async function samplePanel(
  browser: Browser,
  engine: Engine,
  layout: PanelProfile["layout"],
  nav: PanelNavigation,
  api: Api,
): Promise<PanelSample> {
  return withPanelPage(browser, engine, layout, api, async (page) => {
    const scripts = trackHostScripts(page);
    const errors: string[] = [];
    const documents: Request[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() !== page.mainFrame())
        documents.push(request);
    });
    page.on("framenavigated", (frame) => {
      // Drop the old document's scripts at commit; its cancelled requests have no entry in the new host timeline.
      if (frame === page.mainFrame()) scripts.reset();
    });
    await goto(page, new URL(nav.from, api.origin).href);
    if (layout === "sheet") await observeTti(page, scripts, api.signal, errors);
    else await warmPanel(page, nav.fromHeading);
    await assertErrors(page, errors);
    scripts.reset();
    documents.length = 0;
    const url = new URL(nav.to, api.origin).href;
    // The navigation wait is registered before assign; commit selects the new document even in WebKit.
    const committed = page.waitForNavigation({ waitUntil: "commit", timeout: measurementTimeoutMs });
    await page.evaluate(
      ({ url, heading, desktop }) => {
        if (desktop)
          sessionStorage.setItem(
            "cloud-panel-perf-navigation",
            JSON.stringify({ heading, timeoutMs: 45_000, assignEpoch: performance.timeOrigin + performance.now() }),
          );
        location.assign(url);
      },
      { url, heading: nav.heading, desktop: layout !== "sheet" },
    );
    const response = await committed;
    if (!response) throw new Error("No navigation response");
    await page.waitForLoadState("domcontentloaded", { timeout: measurementTimeoutMs });
    validatePage(response.status(), url, page.url(), await response.text());
    const timing = await observeTti(page, scripts, api.signal, errors);
    scripts.stop();
    if (layout === "sheet") {
      const closed = await page.evaluate(
        () =>
          document.querySelector(".cloud-app-canvas")?.getAttribute("data-panel-sheet") !== "open" &&
          document.getElementById("cloud-panel")?.dataset.state === "closed",
      );
      let providerRequests = 0;
      for (const request of documents) {
        const element = await request.frame().frameElement();
        if ((await element.getAttribute("data-cloud-panel-frame")) === "core") providerRequests++;
      }
      if (!closed || providerRequests)
        throw new Error(
          `Phone sheet must start closed without a provider document request (closed=${closed}, requests=${providerRequests})`,
        );
      await page.evaluate((heading) => window.__cloudPanelPerf.arm({ mode: "sheet", heading, timeoutMs: 45_000 }), nav.heading);
      await page.locator('button[aria-controls="cloud-panel"]:visible').tap();
    }
    const p = await waitForPanel(page);
    const { anchor, hitAt, iframeSeenAt, frameNavigationMs, providerResponseStartMs, providerReadyMs, providerTtfbMs } = p;
    if (
      anchor === null ||
      hitAt === null ||
      iframeSeenAt === null ||
      frameNavigationMs === null ||
      providerResponseStartMs === null ||
      providerReadyMs === null ||
      providerTtfbMs === null
    )
      throw new Error(`Incomplete panel timings: ${JSON.stringify(p)}`);
    const frameHandle = await page.locator('iframe[data-cloud-panel-frame="core"]').elementHandle();
    const frame = await frameHandle?.contentFrame();
    if (!frame) throw new Error("Provider frame detached after content appeared");
    await frame.waitForFunction(
      () => {
        const p = window.__cloudPerf;
        return p?.initial !== null && p?.initial.every((element) => p.mounted.has(element));
      },
      undefined,
      { polling: "raf", timeout: measurementTimeoutMs },
    );
    const providerIslandRenderMs = await frame.evaluate(() => {
      const p = window.__cloudPerf;
      if (p.errors.length) throw new Error(p.errors.join("; "));
      return (p.initial ?? []).reduce((total, element) => {
        const start = p.started.get(element),
          end = p.mounted.get(element);
        if (start === undefined || end === undefined) throw new Error("Missing provider island mount window");
        return total + end - start;
      }, 0);
    });
    const request = documents.filter((request) => request.frame() === frame).at(-1);
    if (!request) throw new Error("Provider document request was not observed");
    const providerResponse = await request.response();
    if (!providerResponse?.ok()) throw new Error(`Provider document HTTP ${providerResponse?.status() ?? "missing"}`);
    const finished = await providerResponse.finished();
    if (finished) throw finished;
    const size = await request.sizes();
    await assertErrors(page, errors);
    const split = panelSplit(anchor, iframeSeenAt, frameNavigationMs, providerResponseStartMs, hitAt);
    const desktop = layout !== "sheet";
    const panelContentMs = desktop ? Math.round(hitAt) : null;
    return panelSampleSchema.parse({
      panelContentMs,
      openToContentMs: desktop ? null : Math.round(hitAt) - Math.round(anchor),
      navigationGapMs: desktop && p.navigationGapMs !== null ? Math.round(p.navigationGapMs) : null,
      assignToContentMs: desktop && p.navigationGapMs !== null ? Math.round(p.navigationGapMs + hitAt) : null,
      hostTtiMs: Math.round(timing.tti),
      hostLcpMs: timing.lcp === null ? null : Math.round(timing.lcp),
      panelLagMs: panelContentMs === null ? null : panelContentMs - Math.round(timing.tti),
      ...split,
      providerReadyMs: Math.round(providerReadyMs),
      providerTtfbMs: Math.round(providerTtfbMs),
      providerDocumentBytes: size.responseBodySize + size.responseHeadersSize,
      providerIslandRenderMs: Math.round(providerIslandRenderMs),
      contentHeading: nav.heading,
    });
  });
}

export async function measurePanel(browsers: Browsers, api: Api, runs: number, panel: PanelResult) {
  for (const nav of panel.navigations) {
    api.signal.throwIfAborted();
    if (nav.status === "failed") continue;
    try {
      await providerStatic(api, nav);
    } catch (error) {
      nav.status = "failed";
      nav.errors.push(message(error));
      continue;
    }
    for (const engine of ["chromium", "webkit"] as const)
      for (const layout of panelLayouts) {
        const browser = browsers.engines.get(engine);
        const row: PanelProfile = {
          browser: engine,
          layout,
          viewport: panelViewports[layout],
          cpuThrottle: engine === "chromium" ? (layout === "sheet" ? 4 : 1) : null,
          network: engine === "chromium" && layout === "sheet" ? phoneNetwork : null,
          status: browser ? "ok" : "skipped",
          reason: browser ? null : browsers.webkitSkip,
          samples: [],
          aggregates: null,
          dominantSegment: null,
        };
        nav.profiles.push(row);
        if (!browser) continue;
        const failures: string[] = [];
        for (let i = 0; i < runs; i++) {
          try {
            api.signal.throwIfAborted();
            console.log(`Panel ${nav.id} / ${engine} / ${layout} ${i + 1}/${runs}`);
            row.samples.push(await samplePanel(browser, engine, layout, nav, api));
          } catch (error) {
            failures.push(`Run ${i + 1}: ${message(error)}`);
            row.status = "failed";
            row.reason = failures.join("; ");
            api.signal.throwIfAborted();
          }
        }
        if (!failures.length) {
          row.aggregates = aggregatePanel(row.samples);
          row.dominantSegment = dominantPanelSegment([medianPanelSample(row.samples, layout)]);
        }
      }
    if (nav.profiles.some((row) => row.status === "failed")) nav.status = "failed";
    if (nav.id === "mail")
      for (const engine of ["chromium", "webkit"] as const) {
        const browser = browsers.engines.get(engine);
        if (browser) panel.observations.push(...(await observeMail(browser, engine, api, nav.to)));
      }
  }
  panel.verdict = panelVerdict(panel);
}

/** Diagnostic observations only: a failed observation is visible but never fails the scenario. */
async function observeMail(browser: Browser, engine: Engine, api: Api, mailbox: string): Promise<PanelResult["observations"]> {
  const observations: PanelResult["observations"] = [];
  for (const kind of ["view", "folder"] as const) {
    try {
      const observation = await withPanelPage(browser, engine, "column", api, async (page) => {
        await goto(page, new URL(kind === "view" ? "/app/mail" : mailbox, api.origin).href);
        await warmPanel(page, kind === "view" ? "start" : "view");
        // Wait for the host control's island as well as the provider's visible content.
        await page.waitForFunction(
          () => {
            const p = window.__cloudPerf;
            return p.initial !== null && p.initial.every((element) => p.mounted.has(element));
          },
          undefined,
          { polling: "raf" },
        );
        const control =
          kind === "view"
            ? page.locator('.mail-overview-views [role="radio"][aria-checked="false"]:visible').first()
            : page.locator('a[href*="?folder="]:visible').first();
        if (!(await control.count())) {
          if (kind === "view") throw new Error("Mail overview view control missing");
          return { engine, switch: kind, panelReloaded: null, note: "Folder switch is not observable on an unconnected mailbox." };
        }
        const targetText = (await control.textContent())?.trim() ?? "";
        const href = await control.getAttribute("href");
        const before = await page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-cloud-panel-frame="core"]');
          if (!iframe?.contentWindow) throw new Error("Missing Help frame before Mail switch");
          const token = "cloud-panel-perf-observation";
          Reflect.set(window, token, "host");
          Reflect.set(iframe.contentWindow, token, "provider");
          return { url: location.href, origin: iframe.contentWindow.performance.timeOrigin, src: iframe.src };
        });
        let providerRequests = 0;
        page.on("request", (request) => {
          if (
            request.isNavigationRequest() &&
            request.frame() !== page.mainFrame() &&
            new URL(request.url()).pathname === new URL(before.src).pathname
          )
            providerRequests++;
        });
        await control.click();
        await page.waitForFunction(
          ({ kind, beforeUrl, targetText, href }) => {
            if (location.href === beforeUrl) return false;
            if (kind === "view")
              return (
                new URL(location.href).searchParams.has("view") &&
                [...document.querySelectorAll('.mail-overview-views [role="radio"][aria-checked="true"]')].some(
                  (element) => element.textContent?.trim() === targetText,
                )
              );
            const folder = href ? new URL(href, location.href).searchParams.get("folder") : null;
            return (
              folder !== null &&
              new URL(location.href).searchParams.get("folder") === folder &&
              [...document.querySelectorAll('a[href*="?folder="]')].some(
                (element) =>
                  element.getAttribute("href") === href &&
                  (element.getAttribute("aria-current") === "page" ||
                    element.getAttribute("data-selected") === "true" ||
                    element.getAttribute("aria-selected") === "true"),
              )
            );
          },
          { kind, beforeUrl: before.url, targetText, href },
          { polling: "raf", timeout: measurementTimeoutMs },
        );
        const after = await page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>('iframe[data-cloud-panel-frame="core"]')?.contentWindow;
          return {
            host: Reflect.get(window, "cloud-panel-perf-observation") === "host",
            frame: !!frame && Reflect.get(frame, "cloud-panel-perf-observation") === "provider",
            origin: frame?.performance.timeOrigin,
          };
        });
        const panelReloaded = !after.host || !after.frame || after.origin !== before.origin || providerRequests > 0;
        return {
          engine,
          switch: kind,
          panelReloaded,
          note: `Mail ${kind} switch observed; host ${after.host ? "retained" : "reloaded"}, provider token ${after.frame ? "retained" : "lost"}, timeOrigin ${after.origin === before.origin ? "unchanged" : "changed"}, ${providerRequests} new provider document requests.`,
        };
      });
      observations.push(observation);
    } catch (error) {
      api.signal.throwIfAborted();
      observations.push({ engine, switch: kind, panelReloaded: null, note: `Observation failed: ${message(error)}` });
    }
  }
  return observations;
}
