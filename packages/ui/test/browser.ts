import {
  type Browser,
  type BrowserContext,
  chromium,
  errors,
  type Frame,
  type LaunchOptions,
  type Locator,
  type Page,
  type Request,
  type Response,
  webkit,
} from "playwright";

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

const explained = async <T>(page: Page, call: () => Promise<T>): Promise<T> => {
  const open = new Map<Request, string>();
  const failed: string[] = [];
  let committed: string | undefined;
  let status: number | undefined;
  let domcontentloaded = false;
  let load = false;
  const request = (request: Request) => open.set(request, `${request.method()} ${request.url()}`);
  const finished = (request: Request) => open.delete(request);
  const failure = (request: Request) => {
    failed.push(`${request.method()} ${request.url()}`);
    open.delete(request);
  };
  const response = (response: Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) status = response.status();
  };
  const navigated = (frame: Frame) => {
    if (frame === page.mainFrame()) committed = frame.url();
  };
  const domReady = () => {
    domcontentloaded = true;
  };
  const loaded = () => {
    load = true;
  };
  page.on("request", request);
  page.on("requestfinished", finished);
  page.on("requestfailed", failure);
  page.on("response", response);
  page.on("framenavigated", navigated);
  page.on("domcontentloaded", domReady);
  page.on("load", loaded);
  try {
    try {
      return await call();
    } finally {
      page.off("request", request);
      page.off("requestfinished", finished);
      page.off("requestfailed", failure);
      page.off("response", response);
      page.off("framenavigated", navigated);
      page.off("domcontentloaded", domReady);
      page.off("load", loaded);
    }
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      const pending = [...open.values()];
      const lines = [
        "Navigation diagnosis:",
        committed === undefined ? `No document committed; page still shows ${page.url()}` : `Document committed at ${committed}`,
        status === undefined ? "Navigation response: none" : `Navigation response status: ${status}`,
        `DOMContentLoaded: ${domcontentloaded ? "fired" : "did not fire"}`,
        `load: ${load ? "fired" : "did not fire"}`,
        pending.length === 0 ? "Requests still open: none" : "Requests still open:",
        ...pending.slice(0, 10),
        ...(pending.length > 10 ? [`and ${pending.length - 10} more`] : []),
        ...(failed.length > 0
          ? ["Requests failed:", ...failed.slice(0, 10), ...(failed.length > 10 ? [`and ${failed.length - 10} more`] : [])]
          : []),
        await probeMainThread(page),
      ];
      error.message += `\n\n${lines.join("\n")}`;
    }
    throw error;
  }
};

const explainedPages = new WeakSet<Page>();
const explainNavigations = (page: Page): Page => {
  if (explainedPages.has(page)) return page;
  explainedPages.add(page);
  const goto = page.goto.bind(page);
  page.goto = (url, options) => explained(page, () => goto(url, options));
  const reload = page.reload.bind(page);
  page.reload = (options) => explained(page, () => reload(options));
  const goBack = page.goBack.bind(page);
  page.goBack = (options) => explained(page, () => goBack(options));
  const goForward = page.goForward.bind(page);
  page.goForward = (options) => explained(page, () => goForward(options));
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
 * Navigation timeouts include document, request, load, and main-thread evidence (#1367).
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
