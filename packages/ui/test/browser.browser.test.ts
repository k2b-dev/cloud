import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, errors } from "playwright";
import { browserName, launchBrowser, pageErrors, settled } from "../test/browser";

if (process.env.UI_BROWSER_RECOVERY_CHILD === "1") {
  await import("./browser-recovery.browser-suite");
} else {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  // Another origin for cross-origin requests: same address, another port.
  let other: ReturnType<typeof Bun.serve>;
  const serve = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/hang" || path === "/never") return new Promise<Response>(() => {});
        // The next document takes a moment, so the page that a navigation leaves keeps waiting for it.
        if (path === "/next") await Bun.sleep(500);
        return new Response(path === "/stalled" ? '<!doctype html><img src="/never">' : "<!doctype html><p>Start</p>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
  beforeAll(async () => {
    server = serve();
    other = serve();
    browser = await launchBrowser();
  });
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await Promise.all([server?.stop(true), other?.stop(true)]);
    }
  });

  // A stream that opens again once when it fails, as a live chat does: a navigation cancels the first request, and
  // WebKit refuses the second, which starts while the page waits for the next document (#1579).
  const reconnectingStream = (url: string) => {
    void fetch(url).catch(() => fetch(url).catch(() => {}));
  };

  test("pageErrors() ignores only WebKit's report of a same-origin load that a test's navigation refused", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = pageErrors(page);
      const reported: string[] = [];
      page.on("pageerror", (error) => reported.push(`${error.name}:/${error.message}`));
      const hang = new URL("/hang", server.url).href;
      const refused = `Fetch API cannot load ${hang} due to access control checks.`;
      await page.goto(new URL("/start", server.url).href);
      await page.evaluate(reconnectingStream, hang);
      await page.goto(new URL("/next", server.url).href);
      expect(errors).toEqual([]);
      // WebKit did report the refusal, so a plain pageerror listener fails here.
      expect(reported).toEqual(browserName === "webkit" ? [refused] : []);

      // The same refusal during a navigation the page starts itself is reported.
      await page.evaluate(reconnectingStream, hang);
      await page.evaluate(() => setTimeout(() => location.assign("/next?again")));
      await page.waitForURL(new URL("/next?again", server.url).href);
      expect(errors).toEqual(browserName === "webkit" ? [refused] : []);
    } finally {
      await context.close();
    }
  }, 20_000);

  test("pageErrors() reports an unhandled rejection of a failed fetch, also during a test's navigation", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = pageErrors(page);
      await page.route("**/fails", (route) => route.abort());
      await page.goto(new URL("/start", server.url).href);
      const first = page.waitForEvent("pageerror");
      await page.evaluate(() => {
        void fetch("/fails");
      });
      await first;
      const failed = browserName === "webkit" ? "Unhandled Promise Rejection: TypeError: Load failed" : "TypeError: Failed to fetch";
      expect(errors).toEqual([failed]);

      // WebKit rejects the refused second request unhandled; Chromium leaves both requests open until the page goes.
      const hang = new URL("/hang", server.url).href;
      await page.evaluate((url) => {
        void fetch(url).catch(() => fetch(url));
      }, hang);
      await page.goto(new URL("/next", server.url).href);
      expect(errors).toEqual(browserName === "webkit" ? [failed, failed] : [failed]);
    } finally {
      await context.close();
    }
  }, 20_000);

  test("pageErrors() reports an access-control failure without a navigation and one for another origin during it", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = pageErrors(page);
      await page.goto(new URL("/start", server.url).href);
      // The other origin answers without CORS headers.
      const blocked = new URL("/start", other.url).href;
      const reported = browserName === "webkit" ? page.waitForEvent("pageerror") : undefined;
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => "loaded",
            () => "blocked",
          ),
        blocked,
      );
      await reported;
      const otherHang = new URL("/hang", other.url).href;
      await page.evaluate(reconnectingStream, otherHang);
      await page.goto(new URL("/next", server.url).href);
      expect(errors).toEqual(
        browserName === "webkit"
          ? [
              `Fetch API cannot load ${blocked} due to access control checks.`,
              `Fetch API cannot load ${otherHang} due to access control checks.`,
            ]
          : [],
      );
    } finally {
      await context.close();
    }
  }, 20_000);

  test("settled() waits for transitions and animations to end", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html>
        <style>
          #sample { opacity: 0; width: 50px; transition: opacity 200ms linear; }
          @keyframes grow { from { width: 10px; } to { width: 100px; } }
        </style>
        <div id="sample">sample</div>`);
      // settled: the unsettled start values are the subject; start and read in the same browser task.
      const before = await page.evaluate(() => {
        const element = document.querySelector<HTMLDivElement>("#sample")!;
        void getComputedStyle(element).opacity;
        element.style.opacity = "1";
        element.style.animation = "grow 100ms linear";
        const style = getComputedStyle(element);
        return { opacity: style.opacity, width: style.width };
      });
      expect(before).toEqual({ opacity: "0", width: "10px" });
      await settled(page);
      const after = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector("#sample")!);
        return { opacity: style.opacity, width: style.width };
      });
      expect(after).toEqual({ opacity: "1", width: "50px" });
    } finally {
      await context.close();
    }
  }, 20_000);

  test("settled() returns on a page with a scroll-driven and an infinite animation", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html>
        <style>
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
          #infinite { animation: spin 100ms linear infinite; }
          #scroller { height: 100px; overflow: auto; }
          #scroll { height: 400px; animation: fade 1s linear; animation-timeline: scroll(); }
        </style>
        <div id="infinite">infinite</div>
        <div id="scroller"><div id="scroll">scroll</div></div>`);
      await settled(page);
      const animations = await page.evaluate(() =>
        document.getAnimations().map((animation) => ({
          documentTimeline: animation.timeline === document.timeline,
          running: animation.playState === "running",
          target: animation.effect instanceof KeyframeEffect ? animation.effect.target?.id : null,
        })),
      );
      expect(animations.some((animation) => animation.target === "infinite" && animation.running)).toBe(true);
      expect(animations.some((animation) => !animation.documentTimeline)).toBe(true);
    } finally {
      await context.close();
    }
  }, 20_000);

  test("settled() names the animations of a page that keeps animating", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><div id="pulse">pulse</div>
        <script>
          const el = document.querySelector("#pulse");
          const run = () => {
            const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
            a.id = "pulse";
            a.finished.then(run, () => {});
          };
          run();
        </script>`);
      let error: unknown;
      try {
        await settled(page);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected settled() to reject the page that keeps animating");
      expect(error.message).toContain("the page kept animating");
      expect(error.message).toContain('"name":"pulse"');
      expect(error.message).toContain("div#pulse");
    } finally {
      await context.close();
    }
  }, 20_000);

  test("settled() waits for a view transition that starts after a navigation committed", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><style>::view-transition-group(root) { animation-duration: 150ms; }</style>
        <p id="state">before</p>
        <script>
          // A short finite animation ends first; the view transition starts while settled() waits on it.
          document.querySelector("#state").animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 40 });
          setTimeout(() => {
            if (!document.startViewTransition) return void (document.querySelector("#state").textContent = "after");
            document.startViewTransition(() => { document.querySelector("#state").textContent = "after"; });
          }, 30);
        </script>`);
      await settled(page);
      const state = await page.evaluate(() => ({
        text: document.querySelector("#state")?.textContent,
        viewTransitionAnimations: document
          .getAnimations()
          .filter((animation) => animation.timeline === document.timeline)
          .filter((animation) => animation instanceof CSSAnimation && animation.animationName.startsWith("-ua-"))
          .filter((animation) => animation.playState === "running").length,
      }));
      expect(state).toEqual({ text: "after", viewTransitionAnimations: 0 });
    } finally {
      await context.close();
    }
  }, 20_000);

  test("a navigation whose document never answers says it did not commit", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const start = new URL("/start", server.url).href;
      const hang = new URL("/hang", server.url).href;
      expect((await page.goto(start))?.status()).toBe(200);
      const error = await page.goto(hang, { timeout: 1500 }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(errors.TimeoutError);
      if (!(error instanceof errors.TimeoutError)) throw new Error("Expected a navigation timeout");
      expect(error.message).toContain("Navigation diagnosis:");
      expect(error.message).toMatch(/goto waited \d+ ms/);
      expect(error.message).toContain(`URL before: ${start}`);
      expect(error.message).toContain(`URL now: ${start}`);
      expect(error.message).toContain("Responses:");
      expect(error.message).toContain(`No document committed; page still shows ${start}`);
      expect(error.message).toContain("Navigation response: none");
      expect(error.message).toContain("Requests still open:");
      expect(error.message).toContain(`GET ${hang}`);
      // Chromium holds page.evaluate until a pending navigation commits; WebKit answers from the old document.
      expect(error.message).toContain(browserName === "chromium" ? "Main thread: did not answer within 2 s" : "Main thread: answered in ");
    } finally {
      await context.close();
    }
  }, 20_000);

  test("a committed navigation whose load never fires names the open request", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const stalled = new URL("/stalled", server.url).href;
      const never = new URL("/never", server.url).href;
      const error = await page.goto(stalled, { timeout: 1500 }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(errors.TimeoutError);
      if (!(error instanceof errors.TimeoutError)) throw new Error("Expected a navigation timeout");
      expect(error.message).toContain("Navigation diagnosis:");
      expect(error.message).toMatch(/goto waited \d+ ms/);
      expect(error.message).toContain("URL before: about:blank");
      expect(error.message).toContain(`URL now: ${stalled}`);
      expect(error.message).toContain(`Responses:\n200 GET ${stalled}`);
      expect(error.message).toContain(`Document committed at ${stalled}`);
      expect(error.message).toContain("Navigation response status: 200");
      expect(error.message).toContain("DOMContentLoaded: fired");
      expect(error.message).toContain("load: did not fire");
      expect(error.message).toContain("Requests still open:");
      expect(error.message).toContain(`GET ${never}`);
      expect(error.message).toContain("Main thread: answered in ");
      expect(error.message).toContain("readyState interactive");
    } finally {
      await context.close();
    }
  }, 20_000);

  test("a failed navigation names each failed request with its error", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const start = new URL("/start", server.url).href;
      const offline = new URL("/offline", server.url).href;
      expect((await page.goto(start))?.status()).toBe(200);
      await context.setOffline(true);
      const error = await page.goto(offline).catch((error: unknown) => error);
      if (!(error instanceof Error)) throw new Error("Expected the offline navigation to fail");
      const reason = browserName === "webkit" ? "WebKit encountered an internal error" : "net::ERR_INTERNET_DISCONNECTED";
      expect(error.message).toContain(`Requests failed:\nGET ${offline}: ${reason}`);
      // Offline WebKit fails loads with the error that a crashed network process gives every open load (#1431).
      expect(error.message.includes("WebKit internal error: WebKit fails every open load this way")).toBe(browserName === "webkit");
    } finally {
      await context.close();
    }
  }, 20_000);

  test.skipIf(Boolean(process.env.TEST_BROWSER_ENDPOINT?.trim()))(
    "a browser that hangs on close is killed and gone within the hook budget, and the next launch starts at once",
    async () => {
      const childPids = () => {
        const result = Bun.spawnSync(["pgrep", "-P", String(process.pid)]);
        if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`pgrep failed: ${new TextDecoder().decode(result.stderr)}`);
        return new Set(new TextDecoder().decode(result.stdout).split(/\s+/).filter(Boolean).map(Number));
      };
      let hung: Browser | undefined;
      let next: Browser | undefined;
      let pid: number | undefined;
      try {
        const before = childPids();
        hung = await launchBrowser();
        const added = [...childPids()].filter((child) => !before.has(child));
        pid = added[0];
        const browserPid = pid;
        expect(added).toHaveLength(1);
        if (browserPid === undefined) throw new Error("The launched browser has no child pid");
        const page = await hung.newPage();
        await page.setContent("<p>ready to close</p>");
        expect(await page.locator("p").textContent()).toBe("ready to close");
        process.kill(-browserPid, "SIGSTOP");

        const lines: string[] = [];
        const originalError = console.error;
        const closing = performance.now();
        try {
          console.error = (...args: unknown[]) => {
            lines.push(args.map(String).join(" "));
          };
          await hung.close();
        } finally {
          console.error = originalError;
        }
        const closeMs = performance.now() - closing;
        // It waited the 2 s graceful budget, then killed, all inside Bun's 5 s hook timeout.
        expect(closeMs).toBeGreaterThanOrEqual(1990);
        expect(closeMs).toBeLessThan(5000);
        expect(() => process.kill(-browserPid, 0)).toThrow(/ESRCH/);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          new RegExp(
            `^launchBrowser: ${browserName} close did not finish within \\d+ ms; killed process group ${browserPid}, gone after \\d+ ms$`,
          ),
        );
        pid = undefined;

        const launching = performance.now();
        next = await launchBrowser();
        expect(performance.now() - launching).toBeLessThan(4000);
        const nextPage = await next.newPage();
        await nextPage.setContent("<p>ready after the kill</p>");
        expect(await nextPage.locator("p").textContent()).toBe("ready after the kill");
        await next.close();
      } finally {
        try {
          if (pid !== undefined) {
            try {
              process.kill(-pid, "SIGCONT");
              process.kill(-pid, "SIGKILL");
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
            }
          }
        } finally {
          await Promise.all([hung?.close(), next?.close()]);
        }
      }
    },
    20_000,
  );

  test(`the shared ${browserName} browser recovers after a test times out`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, UI_BROWSER_RECOVERY_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = `${stdout}\n${stderr}`;
    // A piped `bun test` lists only failing tests by name; the summary counts the passing ones.
    const failed = Array.from(output.matchAll(/^\(fail\) (.*?) \[[^\]\r\n]*\]\r?$/gm), (match) => match[1]);
    const passed = Number(/^ (\d+) pass\r?$/m.exec(output)?.[1] ?? 0);
    expect({ code, failed, passed }, output).toEqual({
      code: 1,
      failed: ["a test that hangs waiting on its page", "a test that hangs in a navigation"],
      passed: 3,
    });
    expect(output).toContain("Navigation diagnosis:");
    expect(output).toMatch(/goto waited \d+ ms/);
    // A killed browser can fail the open document request before the report, so it is open or failed.
    expect(output).toMatch(/Requests (still open|failed):\r?\nGET http:\/\/127\.0\.0\.1:\d+\/hang/);
    expect(output).toMatch(/URL before: http:\/\/127\.0\.0\.1:\d+\/start/);
    expect(output).not.toContain("removeListener");
    if (!process.env.TEST_BROWSER_ENDPOINT?.trim()) {
      // Prove Bun killed the local browser. If Bun stops killing subprocesses,
      // revisit the launcher comment about timeout cleanup.
      expect(output).toMatch(/killed \d+ dangling process/);
      // The hung step rejects after the timeout. Its error names what it waited for, not a failed close in the
      // test's cleanup (#1355).
      expect(output).toContain("waiting for locator('#never')");
      expect(output).not.toContain("close: Target page, context or browser has been closed");
    }
  }, 60_000);
}
