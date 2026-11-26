import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-code.client";

// CodeBlock at its worst (test/v2-code.client.tsx): a secret key, a config with a long line and a switch, and a log of
// 2,000 lines with one of 10,000 signs. Long lines scroll inside the block, never the page; a long code shows its
// start and "Alles zeigen"; a secret is hidden in the shape of its signs; copy says "Kopiert".

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-code.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(4000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const block = (page: Page, label: string) => page.locator(`[data-k2-part="CodeBlock"]:has(.k2-code-label:text-is("${label}"))`);

for (const width of [1440, 390]) {
  test(`at ${width}: a line of 10,000 signs scrolls inside its block, never the page; the block takes the focus for it`, async () => {
    await withPage(width, async (page) => {
      const log = page.getByRole("region", { name: "gateway.log" });
      const found = await log.evaluate((body) => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        pane: [...document.querySelectorAll(".k2-scroll")].map((scroll) => scroll.scrollWidth - scroll.clientWidth),
        scrolls: body.scrollWidth > body.clientWidth + 1000,
        focusable: (body as HTMLElement).tabIndex,
        blockRight: Math.round(body.getBoundingClientRect().right),
      }));
      expect(found.page).toBe(0);
      expect(found.pane.every((overflow) => overflow === 0)).toBe(true);
      expect(found.scrolls).toBe(true);
      expect(found.focusable).toBe(0);
      expect(found.blockRight).toBeLessThanOrEqual(width);
      // the keyboard reaches the long line: focus, then the arrow keys scroll it
      await log.focus();
      await page.keyboard.press("ArrowRight");
      // the browser may scroll smoothly: wait for the line to move
      await log.evaluate(
        (body) =>
          new Promise<void>((done, fail) => {
            const until = performance.now() + 1500;
            const look = () =>
              body.scrollLeft > 0 ? done() : performance.now() > until ? fail(new Error("did not scroll")) : requestAnimationFrame(look);
            look();
          }),
      );
    });
  });

  test(`at ${width}: a log of 2,000 lines shows 200 and "Alles zeigen", then every line, numbered in one column`, async () => {
    await withPage(width, async (page) => {
      const log = block(page, "gateway.log");
      expect(await log.locator(".k2-code-line").count()).toBe(200);
      const more = log.getByRole("button", { name: "Alles zeigen (2.000 Zeilen)" });
      const gutter = await log
        .locator(".k2-code-number")
        .first()
        .evaluate((number) => number.getBoundingClientRect().width);
      await more.click();
      await settled(page);
      expect(await log.locator(".k2-code-line").count()).toBe(2000);
      expect(await more.count()).toBe(0);
      expect(await log.locator(".k2-code-number").last().textContent()).toBe("2000");
      // the number column had the width of four digits from the start, so the code did not move
      expect(
        await log
          .locator(".k2-code-number")
          .first()
          .evaluate((number) => number.getBoundingClientRect().width),
      ).toBe(gutter);
    });
  });

  test(`at ${width}: the switch wraps long lines inside the block and says it is on`, async () => {
    await withPage(width, async (page) => {
      const config = block(page, "cloud.env");
      const body = page.getByRole("region", { name: "cloud.env" });
      expect(await body.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      const toggle = config.getByRole("button", { name: "Lange Zeilen umbrechen" });
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      await toggle.click();
      await settled(page);
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      expect(await config.locator(".k2-code-line").count()).toBe(2);
    });
  });

  test(`at ${width}: a secret stays hidden in the shape of its signs until "Zeigen", and copy takes it while hidden`, async () => {
    await withPage(width, async (page) => {
      const key = block(page, "gateway_ed25519");
      const body = page.getByRole("region", { name: "gateway_ed25519" });
      const before = await key.evaluate((element) => ({
        text: element.textContent ?? "",
        height: element.getBoundingClientRect().height,
        width: element.querySelector(".k2-code-lines")!.getBoundingClientRect().width,
      }));
      expect(before.text).not.toContain("BEGIN");
      expect(before.text).not.toContain("b3BlbnNz");
      expect(await body.getAttribute("aria-description")).toBe("Verborgen, bis du „Zeigen“ drückst");
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => Reflect.set(window, "__copied", text) },
        });
      });
      await key.getByRole("button", { name: "Kopieren: gateway_ed25519" }).click();
      await page.getByText("Kopiert", { exact: true }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, "__copied"))).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
      await key.getByRole("button", { name: "Zeigen" }).click();
      await settled(page);
      const after = await key.evaluate((element) => ({
        text: element.textContent ?? "",
        height: element.getBoundingClientRect().height,
        width: element.querySelector(".k2-code-lines")!.getBoundingClientRect().width,
      }));
      expect(after.text).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
      expect(after.height).toBe(before.height);
      // as wide as the code it hid, to the subpixel a font rounds to
      expect(Math.abs(after.width - before.width)).toBeLessThan(0.5);
      expect(await key.getByRole("button", { name: "Verbergen" }).count()).toBe(1);
    });
  });

  test(`at ${width}: a copy that fails says so in one sentence`, async () => {
    await withPage(width, async (page) => {
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => Promise.reject(new Error("denied")) },
        });
      });
      await block(page, "cloud.env").getByRole("button", { name: "Kopieren: cloud.env" }).click();
      await page.getByText("Kopieren hat nicht geklappt; markiere den Code und kopiere ihn mit der Tastatur.").waitFor();
    });
  });
}
