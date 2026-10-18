import { type Browser, type BrowserContext, chromium, type LaunchOptions, type Locator, type Page, type Request, webkit } from "playwright";

/**
 * The engine that Playwright tests run in, chosen with `TEST_BROWSER`:
 * `chromium` (the default) or `webkit`, the engine of Safari and of every
 * browser on iOS.
 */
export const browserName: "chromium" | "webkit" = (() => {
  const name = process.env.TEST_BROWSER?.trim() || "chromium";
  if (name !== "chromium" && name !== "webkit") throw new Error(`TEST_BROWSER must be "chromium" or "webkit", got "${name}".`);
  return name;
})();

const start = (options: LaunchOptions): Promise<Browser> => {
  const type = browserName === "webkit" ? webkit : chromium;
  const endpoint = process.env.TEST_BROWSER_ENDPOINT?.trim();
  if (!endpoint) return type.launch(options);
  return type.connect(endpoint, { timeout: options.timeout, headers: { "x-playwright-launch-options": JSON.stringify(options) } });
};

const tolerateKilledBrowserOnClose = (context: BrowserContext): BrowserContext => {
  const close = context.close.bind(context);
  context.close = async (options) => {
    try {
      await close(options);
    } catch (error) {
      if (context.browser()?.isConnected() === false) return;
      // A browser that Bun is killing can answer before it reports itself disconnected: Chromium then no longer
      // knows the context. A context that no longer exists is closed, so the test reports the step that hung (#1367).
      if (error instanceof Error && error.message.includes("Failed to find context")) return;
      throw error;
    }
  };
  return context;
};

const probeMainThread = async (page: Page): Promise<string> => {
  const closed = () => page.isClosed() || page.context().browser()?.isConnected() === false;
  if (closed()) return "Main thread: page or browser is closed";
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(() => document.readyState).then((state) => `Main thread: answered in ${Date.now() - started} ms, readyState ${state}`),
      new Promise<string>((resolve) => {
        // Before a commit, Chromium holds page.evaluate until the pending navigation ends, so silence alone does not prove a blocked page there.
        timer = setTimeout(
          () =>
            resolve(
              "Main thread: did not answer within 2 s (a blocked page, or a browser that holds scripts until the pending navigation commits)",
            ),
          2000,
        );
      }),
    ]);
  } catch (error) {
    return closed() ? "Main thread: page or browser is closed" : `Main thread: probe failed (${String(error)})`;
  } finally {
    clearTimeout(timer);
  }
};

type NavigationRecord = {
  open: Map<Request, string>;
  failed: string[];
  responses: string[];
  committed?: string;
  status?: number;
  domcontentloaded: boolean;
  load: boolean;
};

const explainedPages = new WeakSet<Page>();
const explainNavigations = (page: Page): Page => {
  if (explainedPages.has(page)) return page;
  explainedPages.add(page);
  const records = new Set<NavigationRecord>();
  // Keep listeners until the page dies: failing channel calls rewrite a shared closed error (#1367).
  page.on("request", (request) => {
    for (const record of records) record.open.set(request, `${request.method()} ${request.url()}`);
  });
  page.on("requestfinished", (request) => {
    for (const record of records) record.open.delete(request);
  });
  page.on("requestfailed", (request) => {
    for (const record of records) {
      record.failed.push(`${request.method()} ${request.url()}`);
      record.open.delete(request);
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    for (const record of records) {
      record.responses.push(`${response.status()} ${request.method()} ${response.url()}`);
      if (record.responses.length > 5) record.responses.shift();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) record.status = response.status();
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) for (const record of records) record.committed = frame.url();
  });
  page.on("domcontentloaded", () => {
    for (const record of records) record.domcontentloaded = true;
  });
  page.on("load", () => {
    for (const record of records) record.load = true;
  });

  const explained = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const before = page.url();
    const record: NavigationRecord = {
      open: new Map(),
      failed: [],
      responses: [],
      domcontentloaded: false,
      load: false,
    };
    records.add(record);
    try {
      try {
        return await call();
      } finally {
        records.delete(record);
      }
    } catch (error) {
      // Every failure carries the evidence. Bun's test timeout can kill the browser before Playwright's own timeout;
      // the navigation then fails as TargetClosedError, or in Chromium as net::ERR_ABORTED before the page reports closed.
      const shared = !(error instanceof Error) || error.name === "TargetClosedError";
      const closed = shared || page.isClosed() || page.context().browser()?.isConnected() === false;
      const message = error instanceof Error ? error.message : String(error);
      const { open, failed, responses, committed, status, domcontentloaded, load } = record;
      const pending = [...open.values()];
      const now = page.url();
      const lines = [
        "Navigation diagnosis:",
        `${name} waited ${Date.now() - started} ms`,
        `URL before: ${before}`,
        `URL now: ${now}`,
        committed === undefined ? `No document committed; page still shows ${now}` : `Document committed at ${committed}`,
        status === undefined ? "Navigation response: none" : `Navigation response status: ${status}`,
        `DOMContentLoaded: ${domcontentloaded ? "fired" : "did not fire"}`,
        `load: ${load ? "fired" : "did not fire"}`,
        responses.length === 0 ? "Responses: none" : "Responses:",
        ...responses,
        pending.length === 0 ? "Requests still open: none" : "Requests still open:",
        ...pending.slice(0, 10),
        ...(pending.length > 10 ? [`and ${pending.length - 10} more`] : []),
        ...(failed.length > 0
          ? ["Requests failed:", ...failed.slice(0, 10), ...(failed.length > 10 ? [`and ${failed.length - 10} more`] : [])]
          : []),
        closed ? "Main thread: page or browser is closed" : await probeMainThread(page),
      ];
      const diagnosis = lines.join("\n");
      // A closed connection rejects every call with one shared error, so that one is wrapped, never changed.
      if (shared || !(error instanceof Error)) throw new Error(`${message}\n\n${diagnosis}`, { cause: error });
      error.message += `\n\n${diagnosis}`;
      throw error;
    }
  };

  const goto = page.goto.bind(page);
  page.goto = (url, options) => explained("goto", () => goto(url, options));
  const reload = page.reload.bind(page);
  page.reload = (options) => explained("reload", () => reload(options));
  const goBack = page.goBack.bind(page);
  page.goBack = (options) => explained("goBack", () => goBack(options));
  const goForward = page.goForward.bind(page);
  page.goForward = (options) => explained("goForward", () => goForward(options));
  return page;
};

const wrapContext = (context: BrowserContext): BrowserContext => {
  tolerateKilledBrowserOnClose(context);
  context.on("page", explainNavigations);
  const newPage = context.newPage.bind(context);
  context.newPage = async () => explainNavigations(await newPage());
  return context;
};

/**
 * Starts the browser in the engine `TEST_BROWSER` selects, or connects to
 * `TEST_BROWSER_ENDPOINT`, the WebSocket address of a `playwright run-server`.
 * Bun's timeout cleanup kills the shared browser. Replace it on the next
 * newPage() or newContext() so one failing test fails only itself (#1254).
 * Pages or contexts kept across tests die with their browser; open them per
 * test, not in beforeAll.
 * Closing a page or context of a killed browser succeeds, so the late error of
 * a timed-out test names the step that hung, not its cleanup (#1355).
 * Navigation timeouts and navigations cut off by a closed browser carry document, request, load, and main-thread evidence (#1367).
 */
export const launchBrowser = async (options: LaunchOptions = {}): Promise<Browser> => {
  let current = await start(options);
  let closed = false;
  let replacement: Promise<Browser> | undefined;

  const replace = (old: Browser): Promise<Browser> => {
    if (closed || old !== current) return Promise.resolve(current);
    replacement ??= start(options)
      .then(async (browser) => {
        current = browser;
        void old.close().catch(() => {});
        // close() may have run while the replacement was starting.
        if (closed) await browser.close();
        return browser;
      })
      .finally(() => {
        replacement = undefined;
      });
    return replacement;
  };

  /**
   * Opens a page or a context in a running browser. A browser that Bun is
   * still killing can report itself connected and fail with a protocol error
   * first, so a failed call alone replaces it and tries once more.
   */
  const open = async <T>(call: (browser: Browser) => Promise<T>): Promise<T> => {
    let browser = current;
    if (!closed && !browser.isConnected()) browser = await replace(browser);
    try {
      return await call(browser);
    } catch (error) {
      if (closed) throw error;
      return call(await replace(browser));
    }
  };
  const newPage: Browser["newPage"] = async (pageOptions) => {
    const page = await open((browser) => browser.newPage(pageOptions));
    wrapContext(page.context());
    return explainNavigations(page);
  };
  const newContext: Browser["newContext"] = async (contextOptions) =>
    wrapContext(await open((browser) => browser.newContext(contextOptions)));

  const close: Browser["close"] = async (closeOptions) => {
    closed = true;
    await current.close(closeOptions);
  };

  return new Proxy(current, {
    get(_target, key) {
      if (key === "newPage") return newPage;
      if (key === "newContext") return newContext;
      if (key === "close") return close;
      const value: unknown = Reflect.get(current, key, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
};

/**
 * Runs `change` and reports whether `locator` keeps its element and how much its height changes.
 * A mutation's refresh must keep the elements of the items it keeps: replacement loses focus and hover,
 * flickers, and can leave a box read detached (#1391). Waits before and after; reads boxes in the page.
 */
export const keptThrough = async (
  locator: Locator,
  change: () => Promise<unknown>,
): Promise<{ replaced: boolean; heightChange: number }> => {
  const original = await locator.elementHandle();
  if (!original) throw new Error("The element to keep was not found.");
  try {
    const before = await original.evaluate((element) => element.getBoundingClientRect().height);
    await change();
    const after = await locator.evaluate(
      (element, original) => ({ same: element === original && original.isConnected, height: element.getBoundingClientRect().height }),
      original,
    );
    return { replaced: !after.same, heightChange: after.height - before };
  } finally {
    await original.dispose();
  }
};
