import { type Browser, type BrowserContext, chromium, type LaunchOptions, webkit } from "playwright";

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

/**
 * Starts the browser in the engine `TEST_BROWSER` selects, or connects to
 * `TEST_BROWSER_ENDPOINT`, the WebSocket address of a `playwright run-server`.
 * Bun's timeout cleanup kills the shared browser. Replace it on the next
 * newPage() or newContext() so one failing test fails only itself (#1254).
 * Pages or contexts kept across tests die with their browser; open them per
 * test, not in beforeAll.
 * Closing a page or context of a killed browser succeeds, so the late error of
 * a timed-out test names the step that hung, not its cleanup (#1355).
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
    tolerateKilledBrowserOnClose(page.context());
    return page;
  };
  const newContext: Browser["newContext"] = async (contextOptions) =>
    tolerateKilledBrowserOnClose(await open((browser) => browser.newContext(contextOptions)));

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
