import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "./browser";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/hang") return new Promise<Response>(() => {});
      return new Response("<!doctype html><p>Start</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop(true);
  }
});

test("a test that hangs waiting on its page", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent("<p>waiting</p>");
    await page.locator("#never").waitFor();
  } finally {
    await page.context().close();
  }
}, 1_000);

test("a test that hangs in a navigation", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL("/start", server.url).href);
    await page.goto(new URL("/hang", server.url).href);
  } finally {
    await context.close();
  }
}, 1_000);

for (let n = 1; n <= 3; n++) {
  test(`a later test ${n} still opens a page`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<p>ready</p>");
      expect(await page.locator("p").textContent()).toBe("ready");
    } finally {
      await page.close();
    }
  });
}
