import {
  type Browser,
  type BrowserContext,
  type Cookie,
  chromium,
  errors,
  type LaunchOptions,
  type Locator,
  type Page,
  type Request,
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

// Bun's default hook timeout is 5 s, and most afterAll hooks keep it. Graceful close and kill each get 2 s,
// which leaves 1 s for the rest of the hook; a launch still pending after 4 s reports before the hook fails (#1473).
const gracefulCloseMs = 2000;
const killWaitMs = 2000;
const slowLaunchMs = 4000;
const processPollMs = 25;

/** The process of a browser that this test process launched: the leader of its own process group. */
type BrowserProcess = { pid: number; kill: () => Promise<unknown> };

type StartedBrowser = {
  browser: Browser;
  process?: BrowserProcess;
  closing?: Promise<void>;
};

const field = (value: unknown, key: string): unknown =>
  (typeof value === "object" || typeof value === "function") && value !== null ? Reflect.get(value, key) : undefined;

/**
 * Playwright offers no public handle on the process of a launched browser. Reach it the way Playwright's own
 * ElectronApplication.process() does, through the in-process connection. A Playwright upgrade that changes this
 * fails every local launch here, never a close later (#1473).
 */
const browserProcessOf = (browser: Browser): BrowserProcess => {
  const connection = field(browser, "_connection");
  const toImpl = field(connection, "toImpl");
  const implementation = typeof toImpl === "function" ? toImpl.call(connection, browser) : undefined;
  const browserProcess = field(field(implementation, "options"), "browserProcess");
  const pid = field(field(browserProcess, "process"), "pid");
  const kill = field(browserProcess, "kill");
  if (typeof pid !== "number" || typeof kill !== "function") {
    throw new Error("launchBrowser: Playwright no longer exposes the process of a launched browser; bounded close needs it (#1473).");
  }
  return { pid, kill: async () => kill.call(browserProcess) };
};

let lastClose: { durationMs: number; killed: boolean } | undefined;
const previousCloseSummary = () =>
  lastClose
    ? `previous close took ${lastClose.durationMs} ms, ${lastClose.killed ? "needed a kill" : "no kill needed"}`
    : "no earlier browser";

/** Bounds a wait while keeping a handler on any late rejection (#1473). */
const within = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const processGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

/** Kills the browser's process group and waits until no process of it is left; its leader exiting alone is not enough (#1473). */
const killProcessGroup = async (browserProcess: BrowserProcess, gracefulMs: number): Promise<number> => {
  const { pid } = browserProcess;
  const started = Date.now();
  // Playwright's kill() also removes the profile, but it signals nothing once the leader has exited, so signal the
  // group directly too. A live group keeps its id from being reused, so the signal reaches only this browser.
  const killing = browserProcess.kill().catch(() => {});
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  while (processGroupAlive(pid) && Date.now() - started < killWaitMs) await Bun.sleep(processPollMs);
  if (processGroupAlive(pid)) {
    throw new Error(
      `launchBrowser: ${browserName} process group ${pid} still alive after the kill; graceful wait ${gracefulMs} ms, kill wait ${Date.now() - started} ms`,
    );
  }
  await within(killing, Math.max(0, killWaitMs - (Date.now() - started)));
  return Date.now() - started;
};

/** Closes one started browser within the hook budget; concurrent callers share one close (#1473). */
const closeStarted = (started: StartedBrowser, options: Parameters<Browser["close"]>[0] | undefined, gracefulMs: number): Promise<void> => {
  started.closing ??= (async () => {
    const began = Date.now();
    let killed = false;
    let failure: { error: unknown } | undefined;
    try {
      const finished = await within(started.browser.close(options), gracefulMs).catch((error: unknown) => {
        failure = { error };
        return false;
      });
      const waitedMs = Date.now() - began;
      const browserProcess = started.process;
      if (browserProcess && (!finished || processGroupAlive(browserProcess.pid))) {
        killed = true;
        const killMs = await killProcessGroup(browserProcess, waitedMs);
        // Children that outlive a finished close by a few milliseconds are routine; only a hung or failed close is news.
        if (!finished) {
          const reason = failure ? `failed after ${waitedMs} ms` : `did not finish within ${gracefulMs} ms`;
          console.error(
            `launchBrowser: ${browserName} close ${reason}; killed process group ${browserProcess.pid}, gone after ${killMs} ms`,
          );
        }
      } else if (!finished && !failure) {
        console.error(`launchBrowser: ${browserName} remote close did not finish within ${gracefulMs} ms`);
      }
      if (failure) throw failure.error;
    } finally {
      lastClose = { durationMs: Date.now() - began, killed };
    }
  })();
  return started.closing;
};

const start = async (options: LaunchOptions): Promise<StartedBrowser> => {
  const type = browserName === "webkit" ? webkit : chromium;
  const endpoint = process.env.TEST_BROWSER_ENDPOINT?.trim();
  const began = Date.now();
  const previous = previousCloseSummary();
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    console.error(`launchBrowser: ${browserName} launch still pending after ${slowLaunchMs} ms; ${previous}`);
  }, slowLaunchMs);
  try {
    let started: StartedBrowser;
    if (endpoint) {
      started = {
        browser: await type.connect(endpoint, {
          timeout: options.timeout,
          headers: { "x-playwright-launch-options": JSON.stringify(options) },
        }),
      };
    } else {
      const browser = await type.launch(options);
      try {
        started = { browser, process: browserProcessOf(browser) };
      } catch (error) {
        await browser.close().catch(() => {});
        throw error;
      }
    }
    if (slow) console.error(`launchBrowser: ${browserName} launch completed after ${Date.now() - began} ms; ${previous}`);
    return started;
  } catch (error) {
    const diagnosis = `launchBrowser: ${browserName} launch failed after ${Date.now() - began} ms; ${previous}`;
    if (!(error instanceof Error)) throw new Error(`${String(error)}\n\n${diagnosis}`, { cause: error });
    error.message += `\n\n${diagnosis}`;
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

const webkitInternalError = "WebKit encountered an internal error";
const webkitInternalErrorHint =
  "WebKit internal error: WebKit fails every open load this way when its network process ends, for example in a crash, " +
  "or when the context is offline. In CI, the webkit job lists crashed processes at its end.";

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
/** Per page, the URL it showed when each of its running goto, reload, goBack, and goForward calls started. */
const testNavigations = new WeakMap<Page, Set<{ from: string }>>();
const explainNavigations = (page: Page): Page => {
  if (explainedPages.has(page)) return page;
  explainedPages.add(page);
  const records = new Set<NavigationRecord>();
  const navigations = new Set<{ from: string }>();
  testNavigations.set(page, navigations);
  // Keep listeners until the page dies: failing channel calls rewrite a shared closed error (#1367).
  page.on("request", (request) => {
    for (const record of records) record.open.set(request, `${request.method()} ${request.url()}`);
  });
  page.on("requestfinished", (request) => {
    for (const record of records) record.open.delete(request);
  });
  page.on("requestfailed", (request) => {
    for (const record of records) {
      record.failed.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "no error text"}`);
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
    const navigation = { from: before };
    navigations.add(navigation);
    try {
      try {
        return await call();
      } finally {
        records.delete(record);
        navigations.delete(navigation);
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
        ...(failed.some((line) => line.endsWith(`: ${webkitInternalError}`)) ? [webkitInternalErrorHint] : []),
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
 * Failed requests carry their error, and WebKit's internal error names a crashed network process as one cause (#1431).
 * Close waits at most 2 s gracefully and 2 s for a killed local process group; a surviving group fails cleanup.
 * A forced close, a launch pending after 4 s, and a failed launch carry timing evidence (#1473).
 */
export const launchBrowser = async (options: LaunchOptions = {}): Promise<Browser> => {
  let current = await start(options);
  let closed = false;
  let replacement: Promise<StartedBrowser> | undefined;
  // Closes of replaced browsers run beside the tests; close() waits for them, so no browser outlives the file (#1473).
  const closes = new Set<Promise<void>>();
  // From close() on, waiting for a replacement and every graceful close share one budget.
  let gracefulDeadline: number | undefined;
  const retire = (started: StartedBrowser, closeOptions?: Parameters<Browser["close"]>[0]): void => {
    const gracefulMs = gracefulDeadline === undefined ? gracefulCloseMs : Math.max(0, gracefulDeadline - Date.now());
    const closing = closeStarted(started, closeOptions, gracefulMs);
    if (closes.has(closing)) return;
    closes.add(closing);
    closing.catch(() => {});
  };

  const replace = (old: StartedBrowser): Promise<StartedBrowser> => {
    if (closed || old !== current) return Promise.resolve(current);
    replacement ??= start(options)
      .then((started) => {
        current = started;
        // The next page never waits for the old browser's teardown.
        retire(old);
        // close() may have run while the replacement was starting.
        if (closed) retire(started);
        return started;
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
    let started = current;
    if (!closed && !started.browser.isConnected()) started = await replace(started);
    try {
      return await call(started.browser);
    } catch (error) {
      if (closed) throw error;
      return call((await replace(started)).browser);
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
    gracefulDeadline ??= Date.now() + gracefulCloseMs;
    // A replacement still starting retires itself once it is up, with what is left of the budget.
    if (replacement) await within(replacement, gracefulDeadline - Date.now()).catch(() => false);
    retire(current, closeOptions);
    await Promise.all(closes);
  };

  return new Proxy(current.browser, {
    get(_target, key) {
      if (key === "newPage") return newPage;
      if (key === "newContext") return newContext;
      if (key === "close") return close;
      const value: unknown = Reflect.get(current.browser, key, current.browser);
      return typeof value === "function" ? value.bind(current.browser) : value;
    },
  });
};

/**
 * Guards against state sampled before it settled (#1476, #1499).
 * Waits for fonts, running finite document-timeline animations, then two frames.
 * Infinite, scroll-driven, and paused animations are not waited for. A page that
 * keeps starting finite animations is not settled: this throws with their names,
 * and the test must wait for its own condition instead. Suites not about motion
 * pass `reducedMotion: "reduce"` to newPage/newContext themselves.
 */
export const settled = async (page: Page): Promise<void> => {
  const remaining = await page.evaluate(async () => {
    await document.fonts.ready;
    const running = () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.timeline === document.timeline &&
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
    await Promise.allSettled(running().map((animation) => animation.finished));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return running().map((animation) => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return {
        target:
          target instanceof Element
            ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${Array.from(target.classList, (name) => `.${name}`).join("")}`
            : null,
        name:
          animation instanceof CSSTransition
            ? animation.transitionProperty
            : animation instanceof CSSAnimation
              ? animation.animationName
              : animation.id,
        currentTime: animation.currentTime,
      };
    });
  });
  if (remaining.length) {
    throw new Error(
      `settled: the page kept animating; finite animations started while it settled: ${JSON.stringify(remaining)}. Wait for the test's own condition instead.`,
    );
  }
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

/**
 * WebKit stores document.cookie writes asynchronously (#1496); wait until its store agrees with the document.
 * For cookies page scripts write: HttpOnly cookies are invisible to the document.
 */
export const storedCookie = async (page: Page, name: string): Promise<Cookie | undefined> => {
  const deadline = Date.now() + 10_000;
  while (true) {
    const documentValue = await page.evaluate((name) => {
      const prefix = `${name}=`;
      return document.cookie
        .split(";")
        .map((entry) => entry.trimStart())
        .find((entry) => entry.startsWith(prefix))
        ?.slice(prefix.length);
    }, name);
    const cookie = (await page.context().cookies(page.url())).find((entry) => entry.name === name);
    if (cookie?.value === documentValue) return cookie;
    if (Date.now() >= deadline) {
      throw new Error(
        `storedCookie timed out waiting for '${name}'; document.cookie: ${JSON.stringify(documentValue)}; browser store: ${JSON.stringify(cookie?.value)}.`,
      );
    }
  }
};

declare global {
  interface Window {
    [key: `__k2bMostAtOnce${number}`]: { most: number; observer: MutationObserver } | undefined;
  }
}

let mostAtOnceId = 0;

/**
 * Counts the most elements matching `selector` during `change`, which must end with exactly one.
 * Guards against a leaving entity showing beside its restored copy after Undo or a refresh (#1450).
 */
export const mostAtOnce = async (page: Page, selector: string, change: () => Promise<unknown>): Promise<number> => {
  const key = `__k2bMostAtOnce${mostAtOnceId++}` as const;
  try {
    await page.evaluate(
      ({ key, selector }) => {
        const state = {
          most: document.querySelectorAll(selector).length,
          // A duplicate inserted and removed within one task is never painted and is not the subject of this guard.
          observer: new MutationObserver(() => {
            state.most = Math.max(state.most, document.querySelectorAll(selector).length);
          }),
        };
        window[key] = state;
        state.observer.observe(document, { subtree: true, childList: true, attributes: true });
      },
      { key, selector },
    );
    await change();
    try {
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 1, selector, { timeout: 10_000 });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      const count = await page.evaluate((selector) => document.querySelectorAll(selector).length, selector);
      throw new Error(`mostAtOnce timed out waiting for exactly one element matching '${selector}'; current count: ${count}.`);
    }
    return await page.evaluate(
      async ({ key, selector }) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const state = window[key]!;
        state.most = Math.max(state.most, document.querySelectorAll(selector).length);
        return state.most;
      },
      { key, selector },
    );
  } finally {
    // A page that closed took its observer along, and the step that closed it reports why.
    await page
      .evaluate((key) => {
        window[key]?.observer.disconnect();
        delete window[key];
      }, key)
      .catch(() => {});
  }
};

// WebKit refuses a load that a page starts while its main frame waits for the next document, and logs the refusal as
// "Fetch API cannot load <url> due to access control checks." even for a same-origin request whose promise is
// handled. Playwright's WebKit reports that log as a pageerror and splits it at the URL's colon
// (https://github.com/microsoft/playwright/issues/43120).
const refusedLoad = /^(?:Fetch API|XMLHttpRequest) cannot load (\S+) due to access control checks\.$/;

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * Collects the page's errors as `name: message` lines, for `expect(errors).toEqual([])`.
 * Ignores exactly one report: in WebKit, the refused load of a URL with the page's own origin while a goto, reload,
 * goBack, or goForward that the test started is running. A real CORS failure names another origin; it is reported,
 * as are unhandled rejections, refusals during navigations the page starts itself, and every other error.
 * The page must come from `launchBrowser()`, whose navigation calls this tracks.
 */
export const pageErrors = (page: Page): string[] => {
  const navigations = testNavigations.get(page);
  if (!navigations) throw new Error("pageErrors: open the page with launchBrowser(), whose goto, reload, goBack, and goForward it tracks.");
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    // The split leaves the scheme in the name and drops one slash of the URL; joined again, it is WebKit's text.
    const joined = `${error.name}:/${error.message}`;
    const url = browserName === "webkit" ? refusedLoad.exec(joined)?.[1] : undefined;
    if (url === undefined) {
      errors.push(`${error.name}: ${error.message}`);
      return;
    }
    const origin = originOf(url);
    if (origin !== undefined && [...navigations].some((navigation) => originOf(navigation.from) === origin)) return;
    errors.push(joined);
  });
  return errors;
};
