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

/** Every control of the composer, unrounded: the chip, the attachment and dictation buttons, the field, and Send. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height];
    };
    const composer = document.querySelector(".k2b-chat-composer");
    return {
      composer: composer ? rect(composer) : null,
      chip: rect(document.querySelector(".ai-model-chip")!),
      controls: [...(composer?.querySelectorAll("button, textarea") ?? [])]
        .filter((element) => !element.closest(".ai-model-chip"))
        .map(rect),
    };
  });

describe("model chooser in the composer", () => {
  for (const width of widths)
    test(`keeps every composer control in place at ${width} px`, async () => {
      const reference = await open(width, "");
      const expected = await boxes(reference);
      await reference.close();
      expect(expected.chip[2]).toBe(148);
      for (const query of cases.slice(1)) {
        const page = await open(width, query);
        expect({ query, ...(await boxes(page)) }).toEqual({ query, ...expected });
        await page.close();
      }
    });

  for (const layout of ["empty", "conversation"])
    test(`a used-up budget, the switch and a new class keep every control in place (${layout})`, async () => {
      const page = await open(1440, `?layout=${layout}`);
      const reference = await boxes(page);
      await page.close();
      const budget = await open(1440, `?layout=${layout}&state=budget&draft=Hallo`);
      expect(await boxes(budget)).toEqual(reference);
      await budget.click('.k2b-notice-card button:has-text("Ausgewogen")');
      await settled(budget);
      expect(await boxes(budget)).toEqual(reference);
      await budget.click(".ai-model-chip");
      await budget.keyboard.press("ArrowRight");
      await budget.keyboard.press("Escape");
      await settled(budget);
      expect(await boxes(budget)).toEqual(reference);
      await budget.close();
    });

  test("a class whose model is no longer allowed says so, holds the draft back and offers Balanced", async () => {
    const page = await open(1440, "?state=revoked&draft=Hallo");
    expect(await page.locator(".ai-model-chip").isDisabled()).toBe(false);
    expect(await page.locator(".ai-model-chip").getAttribute("data-tone")).toBe("warning");
    expect(await page.locator(".k2b-notice-card").textContent()).toContain("Maximal");
    expect(await page.locator(".k2b-chat-composer__send").isDisabled()).toBe(true);
    await page.click('.k2b-notice-card button:has-text("Ausgewogen")');
    expect(await page.locator(".k2b-chat-composer__send").isDisabled()).toBe(false);
    await page.close();
  });

  test("a short list takes the focus, follows the arrows and Escape returns to the card", async () => {
    const page = await open(1440, "?state=few");
    await page.click(".ai-model-chip");
    await page.click('.k2b-anchored-popover button[aria-label^="Alle Modelle"]');
    expect(await page.locator(".k2b-anchored-popover input[type=search]").count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("listbox");
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("aria-activedescendant"));
    const first = await active();
    await page.keyboard.press("ArrowDown");
    expect(await active()).not.toBe(first);
    await page.keyboard.press("Escape");
    expect(await page.locator(".k2b-anchored-popover [role=slider]").evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  test("the search carries the active option for screen readers", async () => {
    const page = await open(1440, "");
    await page.click(".ai-model-chip");
    await page.click('.k2b-anchored-popover button[aria-label^="Alle Modelle"]');
    const search = page.locator(".k2b-anchored-popover input[type=search]");
    expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
    for (let press = 0; press < 9; press++) await page.keyboard.press("ArrowDown");
    const id = await search.getAttribute("aria-activedescendant");
    expect(id).toBeTruthy();
    await settled(page);
    const visible = await page.evaluate((target) => {
      const option = document.getElementById(target!)!.getBoundingClientRect();
      const list = document.querySelector(".k2b-anchored-popover [role=listbox]")!.getBoundingClientRect();
      return option.top >= list.top && option.bottom <= list.bottom;
    }, id);
    expect(visible).toBe(true);
    await page.close();
  });

  test("opens the card on the slider, follows the keys and returns the focus to the chip", async () => {
    const page = await open(1440, "");
    await page.click(".ai-model-chip");
    const slider = page.locator(".k2b-anchored-popover [role=slider]");
    expect(await slider.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await slider.getAttribute("aria-valuetext")).toContain("Ausgewogen");
    await page.keyboard.press("ArrowRight");
    expect(await page.locator(".ai-model-chip").textContent()).toContain("Gründlich");
    expect(await page.locator(".k2b-choice-slider__line").textContent()).toBe("Für komplexe Aufgaben");
    await page.keyboard.press("Escape");
    expect(await page.locator(".k2b-anchored-popover").evaluate((element) => element.matches(":popover-open"))).toBe(false);
    expect(await page.locator(".ai-model-chip").evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  test("the model name opens the list in the same card; Escape goes back to the card", async () => {
    const page = await open(1440, "");
    await page.click(".ai-model-chip");
    await page.click('.k2b-anchored-popover button[aria-label^="Alle Modelle"]');
    const rows = page.locator(".k2b-anchored-popover [role=option]");
    expect(await rows.first().textContent()).toContain("Mistral Small");
    expect(await page.locator(".k2b-anchored-popover input[type=search]").count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.locator(".k2b-anchored-popover [role=slider]").count()).toBe(1);
    expect(await page.locator(".k2b-anchored-popover").evaluate((element) => element.matches(":popover-open"))).toBe(true);
    await page.close();
  });

  test("a used-up budget explains itself and holds the draft back until Balanced answers", async () => {
    const page = await open(1440, "?state=budget&draft=Hallo");
    expect(await page.locator(".ai-model-chip").getAttribute("data-tone")).toBe("warning");
    expect(await page.locator(".k2b-notice-card").textContent()).toContain("Budget");
    expect(await page.locator(".k2b-chat-composer__send").isDisabled()).toBe(true);
    await page.click('.k2b-notice-card button:has-text("Ausgewogen")');
    expect(await page.locator(".ai-model-chip").textContent()).toContain("Ausgewogen");
    expect(await page.locator(".k2b-chat-composer__send").isDisabled()).toBe(false);
    await page.close();
  });
});
