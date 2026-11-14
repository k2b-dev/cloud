import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { buildHarness } from "./tools/image-intake/browser-harness";

const harness = await buildHarness(new URL("./catalog.browser-harness.tsx", import.meta.url));
let browser: Awaited<ReturnType<typeof launchBrowser>>;
let css: string;
beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "../styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

test("catalog keeps one ordered grouping and search through reload and Back with no narrow-width overflow", async () => {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      const tab = await context.newPage();
      await tab.route("http://tools-catalog.test/**", (route) => {
        if (new URL(route.request().url()).pathname === "/harness.js") {
          return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
        }
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div id="root" style="height:100vh;display:flex"></div><script src="/harness.js"></script></body></html>`,
        });
      });
      await tab.goto("http://tools-catalog.test/tools");
      const search = tab.getByRole("searchbox", { name: "Werkzeuge suchen" });
      await search.waitFor();
      expect(await tab.locator('[id^="tool-group-"]').allTextContents()).toEqual([
        "Bilder",
        "Dokumente",
        "Text und Codes",
        "Sicherheit",
        "Netzwerk",
      ]);
      expect(await tab.locator(".k2b-link-card").count()).toBe(4);
      const before = await search.boundingBox();
      await search.fill("sha256");
      await tab.waitForURL((url) => url.searchParams.get("q") === "sha256");
      expect(new URL(tab.url()).searchParams.get("q")).toBe("sha256");
      expect(await tab.locator("a.group\\/tool").allTextContents()).toHaveLength(1);
      expect(await tab.locator("a.group\\/tool").textContent()).toContain("Prüfsumme");
      await tab.reload();
      await search.waitFor();
      expect(await search.inputValue()).toBe("sha256");
      expect(await tab.locator("a.group\\/tool").textContent()).toContain("Prüfsumme");
      // Keep the saved search in the previous entry to exercise same-document popstate restoration.
      await tab.evaluate(() => window.history.pushState(window.history.state, "", "/tools"));
      await search.fill("qr");
      await tab.waitForURL((url) => url.searchParams.get("q") === "qr");
      await tab.goBack();
      await tab.waitForURL((url) => url.searchParams.get("q") === "sha256");
      await tab.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="search"]')?.value === "sha256");
      expect(await search.inputValue()).toBe("sha256");
      expect(await tab.locator("a.group\\/tool").textContent()).toContain("Prüfsumme");
      await search.fill("zzzzzzzzzzzzzzzzzzzzzzzzzzzz");
      await tab.getByRole("button", { name: "Suche zurücksetzen" }).click();
      await tab.waitForURL((url) => !url.searchParams.has("q"));
      expect(await search.inputValue()).toBe("");
      expect(await search.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(new URL(tab.url()).searchParams.has("q")).toBe(false);
      expect(await tab.locator(".k2b-link-card").count()).toBe(4);
      await settled(tab);
      expect(await search.boundingBox()).toEqual(before);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  }
}, 60_000);

test("webhooks shares catalog navigation and retains endpoint counts and recovery", async () => {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      const tab = await context.newPage();
      await tab.route("http://tools-catalog.test/**", (route) =>
        route.fulfill({
          contentType: new URL(route.request().url()).pathname === "/harness.js" ? "text/javascript" : "text/html",
          body:
            new URL(route.request().url()).pathname === "/harness.js"
              ? harness
              : `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div id="root" style="height:100vh;display:flex"></div><script src="/harness.js"></script></body></html>`,
        }),
      );
      await tab.goto("http://tools-catalog.test/tools?view=webhooks");
      await tab.getByRole("heading", { name: "Webhook-Tester" }).waitFor();
      await tab.getByText("Bestellungen", { exact: true }).first().waitFor();
      expect(await tab.getByRole("cell", { name: "12", exact: true }).count()).toBe(1);
      expect(await tab.locator(".k2b-app-workspace").count()).toBe(1);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await tab.goto("http://tools-catalog.test/tools?view=webhooks&state=error");
      await tab.getByText("Testverbindung unterbrochen", { exact: true }).waitFor();
      expect(await tab.getByRole("button", { name: "Erneut versuchen" }).count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }
}, 60_000);
