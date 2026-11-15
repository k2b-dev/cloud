/**
 * Shared browser harness for an application's page swaps (see "Swap stability" in
 * docs-site/docs/en/frontend/url-state-and-navigation.md). It serves the application's real SSR pages through the
 * real Cloud Layout and ShellRuntime for one signed-in fixture person, builds the islands those pages use, and
 * runs the platform contract in Chromium or WebKit (`TEST_BROWSER`):
 *
 * - links inside the app swap without a document load; Back and Forward too;
 * - a direct visit renders the page on the server;
 * - a failing swap loads the document once and reports the fallback;
 * - a link to another application stays a document load;
 * - 50 swaps leave listeners, timers, sockets and the head at their size after the first round.
 *
 * Call `installSsrTransform()` before importing page modules, then `startPageSwapApp()` in `beforeAll` and
 * `pageSwapContract()` at the top level of the test file.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { buildIslands } from "../../ssr/src/build";
import { launchBrowser } from "../../ui/test/browser";
import type { RuntimeAppMeta } from "../src/contracts/app";
import type { User } from "../src/contracts/shared";
import type { AuthContext } from "../src/server/middleware/auth";
import type { RuntimeContext } from "../src/ssr/runtime";

const cloudRoot = resolve(import.meta.dir, "..");

/** Transforms island wrappers of pages imported afterwards, with the ids the harness build uses. */
export const installSsrTransform = (appRoot: string): void => {
  const { plugin } = createConfig({ dev: true, rootDir: appRoot, componentRoots: [] });
  Bun.plugin(plugin());
};

export type { Page };

export type PageSwapEnvironment = { Variables: AuthContext["Variables"] & { runtime: RuntimeContext } };

export type PageSwapAppOptions = {
  /** The application package, for example `packages/tools`. Island ids are relative to it. */
  appRoot: string;
  /** Directories that hold the islands of the served pages. */
  componentRoots: readonly string[];
  /** The application's stylesheet, compiled after Cloud's global styles. */
  stylesheet?: string;
  /** The application's registration; the harness adds an `other` application for cross-app links. */
  app: RuntimeAppMeta;
  /** The application's real page routes, mounted at the server root. */
  routes: Hono<PageSwapEnvironment>;
  /** A path inside the application's scope that the harness answers with 503 for swaps. */
  failurePath: string;
};

export type PageSwapApp = {
  origin: string;
  browser: Browser;
  /** Fallbacks the pages reported to Core, in order. */
  fallbacks: unknown[];
  /** Resolves with the next reported fallback. */
  nextFallback: () => Promise<unknown>;
  close: () => Promise<void>;
};

const otherApp: RuntimeAppMeta = {
  id: "other",
  name: "Other",
  icon: "ti ti-box",
  description: "Other application",
  routes: ["/app/other"],
  nav: { href: "/app/other", section: "primary" },
};

export async function startPageSwapApp(options: PageSwapAppOptions): Promise<PageSwapApp> {
  const rail = await import("../src/services/rail-snapshot");
  const settings = await import("../src/server/middleware/settings");
  const help = await import("../src/ssr/help");
  const consent = await import("../src/ssr/panel-consent");
  const { session } = await import("../src/services/session");
  const { person } = await import("../src/_internal/define-app.test-fixture");
  const { defaultRailPreferences } = await import("../src/contracts/rail-preferences");
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    spyOn(session, "getToken").mockReturnValue("fixture"),
    spyOn(session, "appSessionFallback").mockReturnValue(null),
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user: person,
      data: { userId: person.id, sid: "fixture", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
    }),
  ];
  const apps = [options.app, otherApp];
  const server = new Hono<PageSwapEnvironment>()
    .use(async (c, next) => {
      c.set("runtime", { apps });
      const user: User = { ...person };
      c.set("user", user);
      await next();
    })
    // Another application's document: only that the browser loaded it matters.
    .get("/app/other", (c) => c.html("<!doctype html><title>Other</title><h1>Other application</h1>"))
    .route("/", options.routes);
  const output = mkdtempSync(join(tmpdir(), "cloud-page-swap-app-"));
  const fallbacks: unknown[] = [];
  let arrived = Promise.withResolvers<unknown>();
  const nextFallback = () => arrived.promise;
  let served: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await served?.stop(true);
      } finally {
        for (const spy of spies) spy.mockRestore();
        rmSync(output, { recursive: true, force: true });
      }
    }
  };
  try {
    await buildIslands({
      pattern: "**/*.{island,client}.tsx",
      cwd: options.appRoot,
      componentRoots: [...options.componentRoots, resolve(cloudRoot, "src")],
      outdir: output,
      dev: false,
      verbose: false,
    });
    const entries = [resolve(cloudRoot, "../../styles.css"), ...(options.stylesheet ? [options.stylesheet] : [])];
    const css: string[] = [];
    for (const entry of entries) {
      const styles = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!styles.success) throw new AggregateError(styles.logs, `Could not compile ${entry}`);
      css.push(await styles.outputs[0]!.text());
    }
    served = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/me/page-swap-fallbacks") {
          const report = { ...(await request.json()), referer: request.headers.get("referer") };
          fallbacks.push(report);
          arrived.resolve(report);
          arrived = Promise.withResolvers<unknown>();
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/harness.css") return new Response(css.join("\n"), { headers: { "content-type": "text/css" } });
        // Apps with a basePath load islands below it, such as /tools/_ssr/<version>/<entry>.js.
        if (url.pathname.includes("/_ssr/")) {
          const file = Bun.file(join(output, url.pathname.split("/").at(-1)!));
          return (await file.exists())
            ? new Response(file, { headers: { "content-type": "text/javascript" } })
            : new Response("missing", { status: 404 });
        }
        if (url.pathname === options.failurePath && request.headers.get("sec-fetch-dest") !== "document")
          return new Response("unavailable", { status: 503 });
        const response = await server.fetch(request);
        if (!response.headers.get("content-type")?.includes("text/html")) return response;
        // Keep the shipped island loader; serve one compiled stylesheet instead of the versioned public ones.
        const html = (await response.text())
          .replace(/<script type="module"(?![^>]*data-ssr-assets)[^>]*>[\s\S]*?<\/script>/g, "")
          .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, "")
          .replace("</head>", '<link rel="stylesheet" href="/harness.css"></head>');
        return new Response(html, { status: response.status, headers: response.headers });
      },
    });
    browser = await launchBrowser();
    return { origin: `http://127.0.0.1:${served.port}`, browser, fallbacks, nextFallback, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Counts what islands must give back on disposal: listeners on the window, the document, `<html>`, `<body>`, media
 * queries and broadcast channels, intervals, open sockets and event sources, workers, object URLs, plus the head and
 * the swap's live region. Listeners on column elements leave with the column and are not counted.
 */
const footprintScript = () => {
  const ids = new WeakMap<object, number>();
  let next = 0;
  const id = (value: object) => {
    if (!ids.has(value)) ids.set(value, ++next);
    return ids.get(value);
  };
  const kept = (target: EventTarget) =>
    target === window ||
    target === document ||
    target === document.documentElement ||
    target === document.body ||
    target instanceof MediaQueryList ||
    target instanceof BroadcastChannel;
  const listeners = new Set<string>();
  const key = (target: EventTarget, type: string, listener: object, options?: boolean | EventListenerOptions) =>
    `${id(target)}:${type}:${id(listener)}:${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (kept(this) && listener && !(typeof options === "object" && options?.once)) listeners.add(key(this, type, listener, options));
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (listener) listeners.delete(key(this, type, listener, options));
    return remove.call(this, type, listener, options);
  };
  const intervals = new Set<unknown>();
  const setInterval = window.setInterval;
  const clearInterval = window.clearInterval;
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
    const handle = setInterval(...args);
    intervals.add(handle);
    return handle;
  }) as typeof window.setInterval;
  window.clearInterval = ((handle?: number) => {
    intervals.delete(handle);
    clearInterval(handle);
  }) as typeof window.clearInterval;
  const sockets = new Set<WebSocket | EventSource>();
  for (const Kind of [WebSocket, EventSource] as const) {
    const Tracked = new Proxy(Kind, {
      construct(target, args) {
        const instance = Reflect.construct(target, args) as WebSocket | EventSource;
        sockets.add(instance);
        const close = instance.close.bind(instance);
        instance.close = (...closeArgs: unknown[]) => {
          sockets.delete(instance);
          (close as (...rest: unknown[]) => void)(...closeArgs);
        };
        return instance;
      },
    });
    Object.defineProperty(window, Kind.name, { value: Tracked, configurable: true, writable: true });
  }
  const workers = new Set<Worker>();
  const TrackedWorker = new Proxy(Worker, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as Worker;
      workers.add(instance);
      const terminate = instance.terminate.bind(instance);
      instance.terminate = () => {
        workers.delete(instance);
        terminate();
      };
      return instance;
    },
  });
  Object.defineProperty(window, "Worker", { value: TrackedWorker, configurable: true, writable: true });
  const urls = new Set<string>();
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = createObjectURL(object);
    urls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    urls.delete(url);
    revokeObjectURL(url);
  };
  // Every history write, nav's own included: nav keeps the prototype methods it finds at install.
  const writes: number[] = [];
  for (const name of ["pushState", "replaceState"] as const) {
    const original = History.prototype[name];
    History.prototype[name] = function (...args: Parameters<History["pushState"]>) {
      writes.push(performance.now());
      return original.apply(this, args);
    };
  }
  Object.assign(window, {
    recentHistoryWrites: () => writes.filter((time) => performance.now() - time < 10_000).length,
    pageSwapFootprint: () => ({
      listeners: listeners.size,
      intervals: intervals.size,
      sockets: sockets.size,
      workers: workers.size,
      objectUrls: urls.size,
      head: document.head.children.length,
      announcers: document.querySelectorAll("[data-nav-announcer]").length,
    }),
  });
};
/** Every island of the column mounted, read from the framework's island registry (test-only knowledge). */
const columnMounted = (page: Page) =>
  page.waitForFunction(() => {
    const registry = (globalThis as Record<symbol, { mounted?: WeakMap<Element, unknown> } | undefined>)[Symbol.for("@k2b/ssr/islands")];
    const wrappers = document.querySelectorAll("[data-nav-root] solid-island, [data-nav-root] solid-client");
    return Array.from(wrappers).every((wrapper) => registry?.mounted?.has(wrapper));
  });
/** Boxes of the kept shell, the column's first two levels, every sidebar with its scroll and the app's regions. */
const geometry = (page: Page, regions: readonly string[]) =>
  page.evaluate(async (selectors) => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const root = document.querySelector("[data-nav-root]");
    const column = root ? [...root.children].flatMap((child) => [child, ...child.children]).slice(0, 40) : [];
    const shell = [".cloud-app-canvas", ".layout-rail", ".layout-shell-content", "main.layout-content-main", "#cloud-panel"].map(
      (selector) => document.querySelector(selector),
    );
    const named = [".k2b-app-workspace__sidebar-body", "[data-nav-root] [aria-current='page']", ...selectors].flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    return [...shell, ...column, ...named].map((element) => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return [
        element.tagName,
        element.checkVisibility(),
        Math.round(x),
        Math.round(y),
        Math.round(width),
        Math.round(height),
        Math.round(element.scrollTop),
      ];
    });
  }, regions);
/** Where focus and the sidebar's current item stand after a swap. */
const arrival = (page: Page) =>
  page.evaluate(() => {
    const focused = document.activeElement;
    const sidebars = Array.from(document.querySelectorAll<HTMLElement>("[data-nav-root] .k2b-app-workspace__sidebar-body"));
    return {
      // A person, and a screen reader, land on a heading they can see.
      focusOnVisibleHeading: !!focused && /^H[1-6]$/.test(focused.tagName) && focused.getClientRects().length > 0,
      currentItemsInView: sidebars.every((body) => {
        const current = body.querySelector<HTMLElement>("[aria-current='page']");
        if (!current || !body.checkVisibility()) return true;
        const box = body.getBoundingClientRect();
        const item = current.getBoundingClientRect();
        return item.top >= box.top - 1 && item.bottom <= box.bottom + 1;
      }),
    };
  });
const footprint = async (page: Page) => {
  // fixed wait: short-lived object URLs (a finished download) are revoked within a second, and nothing signals it.
  await page.waitForTimeout(1_500);
  return page.evaluate(() => (window as unknown as { pageSwapFootprint: () => Record<string, number> }).pageSwapFootprint());
};

export type PageSwapContract = {
  /** Two pages of the app that link to each other. */
  first: string;
  second: string;
  /** Selectors of the in-column links: on `first` to `second`, and on `second` to `first`. */
  toSecond: string;
  toFirst: string;
  /** Resolves once the page at `path` shows its content; the harness also waits for every column island. */
  ready: (page: Page, path: string) => Promise<void>;
  /** A page with URL state (such as `?q=`) that Back must restore; `ready` checks the state. */
  withState?: string;
  /** Pages with the heaviest islands, each linked from the one before, visited three rounds for their own footprint. */
  tour?: readonly string[];
  /** Extra regions whose boxes and scroll a swap must lay out as a reload does. */
  regions?: readonly string[];
};

/** Registers the platform contract's tests for an application. `app` is read lazily after `beforeAll`. */
export function pageSwapContract(name: string, app: () => PageSwapApp, contract: PageSwapContract, failurePath: string): void {
  const open = async (path: string, width = 1440) => {
    const context = await app().browser.newContext({
      viewport: { width, height: 900 },
      locale: "en",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    // Without it, the shell stores the browser's time zone and reloads the page once.
    await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: app().origin }]);
    await context.addInitScript(footprintScript);
    // The contract runs offline: a provider image or tile would make layout and timing depend on the network.
    await context.route(
      (url) => url.origin !== app().origin,
      (route) => route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${app().origin}${path}`);
    await contract.ready(page, path);
    await columnMounted(page);
    await page.waitForFunction(() => document.querySelector("[data-nav-announcer]") !== null);
    // A document load replaces window: the mark survives only swaps.
    await page.evaluate(() => Object.assign(window, { pageSwapMark: "kept" }));
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(new URL(request.url()).pathname);
    });
    const marked = () => page.evaluate(() => (window as unknown as { pageSwapMark?: string }).pageSwapMark === "kept");
    return {
      page,
      documents,
      marked,
      close: async () => {
        await context.close();
        expect(errors).toEqual([]);
      },
    };
  };
  /** Clicks the first visible match: a phone hides the workspace sidebar's copy of a link. */
  const click = (page: Page, selector: string) => page.locator(`${selector} >> visible=true`).first().click();
  const at = async (page: Page, path: string) => {
    await page.waitForFunction((target) => `${location.pathname}${location.search}` === target, path);
    await contract.ready(page, path);
    await columnMounted(page);
  };

  test(`${name}: a direct visit renders the page on the server`, async () => {
    const response = await fetch(`${app().origin}${contract.second}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data-nav-root");
    const tab = await open(contract.second);
    await tab.close();
  });

  for (const width of [390, 1440]) {
    test(`${name}: ${width}px: a page swapped in lays out as its reload`, async () => {
      const tab = await open(contract.first, width);
      try {
        await click(tab.page, contract.toSecond);
        await at(tab.page, contract.second);
        const swapped = await geometry(tab.page, contract.regions ?? []);
        const fresh = await open(contract.second, width);
        try {
          expect(swapped).toEqual(await geometry(fresh.page, contract.regions ?? []));
        } finally {
          await fresh.close();
        }
        expect(tab.documents).toEqual([]);
      } finally {
        await tab.close();
      }
    });
  }

  test(`${name}: links inside the app, Back and Forward change pages without a document load`, async () => {
    const tab = await open(contract.first);
    try {
      await click(tab.page, contract.toSecond);
      await at(tab.page, contract.second);
      expect(await arrival(tab.page)).toEqual({ focusOnVisibleHeading: true, currentItemsInView: true });
      await tab.page.goBack();
      await at(tab.page, contract.first);
      await tab.page.goForward();
      await at(tab.page, contract.second);
      await click(tab.page, contract.toFirst);
      await at(tab.page, contract.first);
      expect(await arrival(tab.page)).toEqual({ focusOnVisibleHeading: true, currentItemsInView: true });
      expect(tab.documents).toEqual([]);
      expect(await tab.marked()).toBe(true);
    } finally {
      await tab.close();
    }
  });

  if (contract.withState) {
    const withState = contract.withState;
    test(`${name}: Back returns to a page with its URL state`, async () => {
      const tab = await open(withState);
      try {
        await click(tab.page, contract.toSecond);
        await at(tab.page, contract.second);
        await tab.page.goBack();
        await at(tab.page, withState);
        expect(tab.documents).toEqual([]);
      } finally {
        await tab.close();
      }
    });
  }

  test(`${name}: a failing page loads the document once and reports the fallback`, async () => {
    const tab = await open(contract.first);
    app().fallbacks.length = 0;
    const reported = app().nextFallback();
    try {
      await tab.page.evaluate((href) => {
        const link = Object.assign(document.createElement("a"), { id: "page-swap-failure", href, textContent: "Failure" });
        document.querySelector("[data-nav-root]")?.append(link);
      }, failurePath);
      await tab.page.click("#page-swap-failure");
      await tab.page.waitForFunction((path) => location.pathname === path && document.readyState === "complete", failurePath);
      expect(tab.documents).toEqual([failurePath]);
      await reported;
      // Neither the body nor the Referer may carry the page's path or query.
      expect(app().fallbacks).toEqual([{ appId: expect.any(String), reason: "status", status: 503, referer: `${app().origin}/` }]);
    } finally {
      await tab.close();
    }
  });

  test(`${name}: a link to another application stays a document load`, async () => {
    const tab = await open(contract.first);
    try {
      await tab.page.evaluate(() => {
        const link = Object.assign(document.createElement("a"), { id: "page-swap-other", href: "/app/other", textContent: "Other" });
        document.querySelector("[data-nav-root]")?.append(link);
      });
      await tab.page.click("#page-swap-other");
      await tab.page.waitForFunction(
        () => location.pathname === "/app/other" && document.querySelector("h1")?.textContent === "Other application",
      );
      expect(tab.documents).toEqual(["/app/other"]);
    } finally {
      await tab.close();
    }
  });

  /** Swaps through `pages` in a loop: one warm-up round, then `swaps`, and compares the footprint before and after. */
  const footprintRun = (label: string, pages: readonly string[], swaps: number) =>
    test(`${name}: ${label}`, async () => {
      const tab = await open(pages[0]!);
      const step = async (index: number) => {
        const target = pages[(index + 1) % pages.length]!;
        // Measure leaks, not the browser's history budget (WebKit: 100 writes per 10 s): stay below it, paced by the
        // writes that really happened, islands' own URL updates included.
        await tab.page.waitForFunction(
          () => (window as unknown as { recentHistoryWrites: () => number }).recentHistoryWrites() < 40,
          undefined,
          { timeout: 15_000 },
        );
        // The link must be visible, but this run measures leaks: Playwright's actionability wait spans several animation
        // frames, which headless WebKit delivers at about 30 per second, so it cost about 0.7 s per click while the
        // link stood still from the first frame. The links test keeps the full click checks.
        await tab.page.locator(`[data-nav-root] a[href="${target}"] >> visible=true`).first().click({ force: true });
        await at(tab.page, target);
      };
      try {
        // The first round loads shared modules and shell state once.
        for (let index = 0; index < pages.length; index++) await step(index);
        const first = await footprint(tab.page);
        // Whole rounds end on the starting page, so both measurements see the same page.
        for (let index = 0; index < swaps; index++) await step(index);
        expect(await footprint(tab.page)).toEqual(first);
        expect(first.announcers).toBe(1);
        expect(tab.documents).toEqual([]);
      } finally {
        await tab.close();
      }
    });
  footprintRun("50 swaps give back every listener, timer, socket, worker and object URL", [contract.first, contract.second], 50);
  // A leak per visit adds up over the rounds; three keep the run short enough under the history budget.
  if (contract.tour)
    footprintRun("three rounds through every heavy page give back what they took", contract.tour, contract.tour.length * 3);
}
