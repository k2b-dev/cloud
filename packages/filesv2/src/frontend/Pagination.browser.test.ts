import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { fixture } from "./Pagination.browser-fixture";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture });
  browser = await launchBrowser();
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

for (const width of [1440, 390])
  test(`load more appends, focuses, retries, reloads and goes back at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const tab = await context.newPage();
    const errors = pageErrors(tab);
    try {
      const start = new URL("app/filesv2?base=demo&sort=name&order=asc&type=all&groupFolders=true", server.url);
      await tab.goto(start.href);
      const more = tab.getByRole("button", { name: "Mehr laden", exact: true });
      await more.waitFor();
      const initialHistoryLength = await tab.evaluate(() => history.length);
      const gates = Array.from({ length: 2 }, () => ({ arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }));
      let attempt = 0;
      let fail = true;
      await tab.route("**/api/filesv2/bases/demo/entries?**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("after") !== "next") return route.continue();
        const gate = gates[attempt++]!;
        gate.arrived.resolve();
        await gate.release.promise;
        if (fail)
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ code: "unavailable", message: "Bitte erneut versuchen" }),
          });
        return route.fulfill({ response: await route.fetch() });
      });
      const before = await more.boundingBox();
      await more.focus();
      await tab.keyboard.press("Enter");
      await tab.waitForFunction(() => !!document.querySelector('.filesv2-browser__pagination button[aria-busy="true"]'));
      const during = await more.boundingBox();
      expect(during?.height).toBe(before?.height);
      expect(during?.y).toBe(before?.y);
      expect(await tab.locator(".filesv2-list__row:not(.filesv2-list__row--virtual)").count()).toBe(3);
      await tab.waitForFunction(() => document.querySelector(".filesv2-browser__pagination button")?.hasAttribute("disabled"));
      await gates[0]!.arrived.promise;
      gates[0]!.release.resolve();
      const retry = tab.getByRole("button", { name: "Erneut versuchen", exact: true }).last();
      await retry.waitFor();
      expect(await tab.locator(".filesv2-list__row:not(.filesv2-list__row--virtual)").count()).toBe(3);
      expect(new URL(tab.url()).searchParams.get("pages")).toBeNull();
      fail = false;
      await retry.focus();
      await tab.keyboard.press("Enter");
      await gates[1]!.arrived.promise;
      gates[1]!.release.resolve();
      await tab.waitForFunction(() => document.querySelectorAll(".filesv2-list__row:not(.filesv2-list__row--virtual)").length === 6);
      await tab.waitForFunction(() => document.activeElement?.textContent?.includes("Fotoliste.csv"));
      expect(await tab.locator(":focus-visible").evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
      expect(await tab.evaluate(() => history.length)).toBe(initialHistoryLength);
      expect(await more.count()).toBe(0);
      expect(new URL(tab.url()).searchParams.get("pages")).toBe("2");
      await tab.unrouteAll({ behavior: "wait" });
      await tab.reload();
      await tab.waitForFunction(() => document.querySelectorAll(".filesv2-list__row:not(.filesv2-list__row--virtual)").length === 6);
      // Leave the folder, then Back restores its cumulative window.
      await tab.goto(new URL("/app/filesv2?base=demo&path=another", server.url).href);
      await tab.goBack();
      await tab.waitForFunction(() => document.querySelectorAll(".filesv2-list__row:not(.filesv2-list__row--virtual)").length === 6);
      expect(new URL(tab.url()).searchParams.get("pages")).toBe("2");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30000);

test("a changed background refresh reads the cumulative window once", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const tab = await context.newPage();
  const errors = pageErrors(tab);
  try {
    await tab.clock.install({ time: new Date("2026-11-07T12:00:00Z") });
    let reads = 0;
    await tab.route("**/api/filesv2/bases/demo/entries?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("type") === "directories") return route.continue();
      reads++;
      const response = await route.fetch();
      const data = await response.json();
      if (!url.searchParams.has("after")) data.items[0].name = "Angebot neu.pdf";
      return route.fulfill({ response, json: data });
    });
    await tab.goto(new URL("/app/filesv2?base=demo&pages=2", server.url).href);
    await tab.waitForFunction(() => document.querySelectorAll(".filesv2-list__row:not(.filesv2-list__row--virtual)").length === 6);
    await tab.clock.runFor(20000);
    await tab.getByText("Angebot neu.pdf", { exact: true }).waitFor();
    expect(reads).toBe(2);
    expect(await tab.locator(".filesv2-list__row:not(.filesv2-list__row--virtual)").count()).toBe(6);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30000);
