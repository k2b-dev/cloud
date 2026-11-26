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
          body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div id="root" class="k2-ui" style="height:100vh;display:flex"></div><script src="/harness.js"></script></body></html>`,
        });
      });
      await tab.goto("http://tools-catalog.test/tools");
      const search = tab.getByRole("searchbox", { name: "Werkzeuge suchen" });
      await search.waitFor();
      expect(await tab.locator('[data-k2-part="Pane"] [data-k2-part="Section"] h3').allTextContents()).toEqual([
        "Oft gebraucht",
        "Bilder",
        "Dokumente",
        "Text und Codes",
        "Sicherheit",
        "Netzwerk",
      ]);
      expect(await tab.locator('[data-k2-part="Tiles"] a').count()).toBe(4);
      const before = await search.boundingBox();
      await search.fill("sha256");
      await tab.waitForURL((url) => url.searchParams.get("q") === "sha256");
      expect(new URL(tab.url()).searchParams.get("q")).toBe("sha256");
      expect(await tab.locator('[data-k2-part="List"] [data-k2-part="Row"]').allTextContents()).toHaveLength(1);
      expect(await tab.locator('[data-k2-part="List"] [data-k2-part="Row"]').textContent()).toContain("Prüfsumme");
      await tab.reload();
      await search.waitFor();
      expect(await search.inputValue()).toBe("sha256");
      expect(await tab.locator('[data-k2-part="List"] [data-k2-part="Row"]').textContent()).toContain("Prüfsumme");
      // Keep the saved search in the previous entry to exercise same-document popstate restoration.
      await tab.evaluate(() => window.history.pushState(window.history.state, "", "/tools"));
      await search.fill("qr");
      await tab.waitForURL((url) => url.searchParams.get("q") === "qr");
      await tab.goBack();
      await tab.waitForURL((url) => url.searchParams.get("q") === "sha256");
      await tab.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="search"]')?.value === "sha256");
      expect(await search.inputValue()).toBe("sha256");
      expect(await tab.locator('[data-k2-part="List"] [data-k2-part="Row"]').textContent()).toContain("Prüfsumme");
      await search.fill("zzzzzzzzzzzzzzzzzzzzzzzzzzzz");
      await tab.getByRole("button", { name: "Suche zurücksetzen" }).click();
      await tab.waitForURL((url) => !url.searchParams.has("q"));
      expect(await search.inputValue()).toBe("");
      expect(await search.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(new URL(tab.url()).searchParams.has("q")).toBe(false);
      expect(await tab.locator('[data-k2-part="Tiles"] a').count()).toBe(4);
      await settled(tab);
      // On the phone the head search is a symbol that opens over the head while it has the focus (it keeps it here).
      if (width > 768) expect(await search.boundingBox()).toEqual(before);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  }
}, 60_000);
