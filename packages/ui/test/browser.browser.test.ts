import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, errors } from "playwright";
import { browserName, launchBrowser } from "../test/browser";

if (process.env.UI_BROWSER_RECOVERY_CHILD === "1") {
  await import("./browser-recovery.browser-suite");
} else {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/hang" || path === "/never") return new Promise<Response>(() => {});
        return new Response(path === "/stalled" ? '<!doctype html><img src="/never">' : "<!doctype html><p>Start</p>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
    browser = await launchBrowser();
  });
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.stop(true);
    }
  });

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
