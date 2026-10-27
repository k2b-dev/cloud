import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { startModelChooserHarness } from "./model-chooser.browser-fixture";

// The chip has a fixed width, so a model, a note or a state never moves another control of the composer. This
// measures the boxes the approved concept measured, in a real browser at its three widths.
setDefaultTimeout(60_000);
let browser: Browser;
let harness: Awaited<ReturnType<typeof startModelChooserHarness>>;
beforeAll(async () => {
  harness = await startModelChooserHarness();
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  harness?.close();
});

const widths = [1440, 1024, 390];
const cases = [
  "",
  "?choice=fast",
  "?choice=thorough",
  "?choice=maximum",
  "?choice=gemini-flash",
  "?choice=long",
  "?state=loading",
  "?state=error",
  "?state=empty",
  "?state=single",
  "?state=running",
  "?state=budget",
  "?state=revoked",
  "?state=unassigned",
];

const open = async (width: number, query: string) => {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
  await page.goto(`${harness.url}${query}`);
  await page.waitForSelector("body[data-ready=true] .ai-model-chip");
  await settled(page);
  return page;
};

const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
    };
    return {
      chip: box(".ai-model-chip"),
      mic: box('[data-test="mic"]'),
      composer: box(".k2b-chat-composer"),
      send: box(".k2b-chat-composer__send"),
    };
  });

describe("model chooser in the composer", () => {
  for (const width of widths)
    test(`keeps every composer control in place at ${width} px`, async () => {
      const reference = await open(width, "");
      const expected = await boxes(reference);
      await reference.close();
      expect(expected.chip?.[2]).toBe(148);
      for (const query of cases.slice(1)) {
        const page = await open(width, query);
        expect({ query, ...(await boxes(page)) }).toEqual({ query, ...expected });
        await page.close();
      }
    });

  test("opens the card on the slider, follows the keys and returns the focus to the chip", async () => {
    const page = await open(1440, "");
    await page.click(".ai-model-chip");
    const slider = page.locator(".k2b-anchored-popover [role=slider]");
    await expect(slider.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await expect(slider.getAttribute("aria-valuetext")).resolves.toContain("Ausgewogen");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".ai-model-chip").textContent()).resolves.toContain("Gründlich");
    await expect(page.locator(".k2b-choice-slider__line").textContent()).resolves.toBe("Für komplexe Aufgaben");
    await page.keyboard.press("Escape");
    await expect(page.locator(".k2b-anchored-popover").evaluate((element) => element.matches(":popover-open"))).resolves.toBe(false);
    await expect(page.locator(".ai-model-chip").evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await page.close();
  });

  test("the model name opens the list in the same card; Escape goes back to the card", async () => {
    const page = await open(1440, "");
    await page.click(".ai-model-chip");
    await page.click('.k2b-anchored-popover button[aria-label^="Alle Modelle"]');
    const rows = page.locator(".k2b-anchored-popover [role=option]");
    await expect(rows.first().textContent()).resolves.toContain("Mistral Small");
    await expect(page.locator(".k2b-anchored-popover input[type=search]").count()).resolves.toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".k2b-anchored-popover [role=slider]").count()).resolves.toBe(1);
    await expect(page.locator(".k2b-anchored-popover").evaluate((element) => element.matches(":popover-open"))).resolves.toBe(true);
    await page.close();
  });

  test("a used-up budget explains itself and holds the draft back until Balanced answers", async () => {
    const page = await open(1440, "?state=budget&draft=Hallo");
    await expect(page.locator(".ai-model-chip").getAttribute("data-tone")).resolves.toBe("warning");
    await expect(page.locator(".k2b-notice-card").textContent()).resolves.toContain("Budget");
    await expect(page.locator(".k2b-chat-composer__send").isDisabled()).resolves.toBe(true);
    await page.click('.k2b-notice-card button:has-text("Ausgewogen")');
    await expect(page.locator(".ai-model-chip").textContent()).resolves.toContain("Ausgewogen");
    await expect(page.locator(".k2b-chat-composer__send").isDisabled()).resolves.toBe(false);
    await page.close();
  });
});
