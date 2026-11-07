import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import type {} from "./shared-text-authorized-offline.test-fixture";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./shared-text-authorized-offline.test-fixture.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build offline authorization fixture");
  const script = await build.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      return new URL(request.url).pathname === "/fixture.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<!doctype html><script src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
  }
});
for (const silent of [false, true]) {
  test(`logout fences an in-flight authorization, broadcasts suppressed: ${silent}`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(server.url.href);
      expect(await page.evaluate((silent) => window.offlineAuthorizationTest.duringAuthorization(silent), silent)).toEqual({
        rejected: true,
        empty: true,
      });
      expect(await page.evaluate(() => window.offlineAuthorizationTest.refused())).toEqual({ rejected: true, removed: true });
    } finally {
      await context.close();
    }
  });
}
