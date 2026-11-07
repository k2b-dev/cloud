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

  /** The trigger, its level indicator and the indicator's thumb, unrounded. */
  const trigger = (page: Page) =>
    page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        chip: rect(".ai-model-chip"),
        level: rect(".ai-model-chip .ai-model-chip__level"),
        thumb: rect(".ai-model-chip .k2b-choice-slider__thumb"),
        lead: rect(".ai-model-chip > span > :first-child"),
      };
    });

  for (const width of [1440, 390])
    test(`the trigger keeps its box at every level and its indicator starts at the same x (${width} px)`, async () => {
      const seen = [];
      for (const choice of ["fast", "balanced", "thorough", "maximum"]) {
        const page = await open(width, `?choice=${choice}`);
        expect(await page.locator(".ai-model-chip").textContent()).not.toBe("");
        seen.push(await trigger(page));
        await page.close();
      }
      const [first] = seen;
      expect(first!.chip!.width).toBe(148);
      for (const entry of seen) {
        expect(entry.chip).toEqual(first!.chip);
        expect(entry.level).toEqual(first!.level);
        // The indicator stands flush left in the trigger, before the level's name.
        expect(entry.level!.x - entry.chip!.x).toBe(6);
      }
      // The thumb moves right with the level, inside the same indicator.
      const thumbs = seen.map((entry) => entry.thumb!.x);
      expect([...thumbs].sort((left, right) => left - right)).toEqual(thumbs);
      expect(new Set(thumbs).size).toBe(4);

      // A model without a level shows its icon and name in the same place.
      const own = await open(width, "?choice=gemini-flash");
      const ownBox = await trigger(own);
      expect(ownBox.chip).toEqual(first!.chip);
      expect(ownBox.level).toBeNull();
      expect(ownBox.lead!.x).toBe(first!.level!.x);
      expect(await own.locator(".ai-model-chip").textContent()).toContain("Gemini Flash");
      await own.close();
    });

  test("a failed load opens the card with Try again, and the models that arrive take its place", async () => {
    const page = await open(1440, "?state=error");
    const reference = await trigger(page);
    const chip = page.locator(".ai-model-chip");
    expect(await chip.isDisabled()).toBe(false);
    expect(await chip.textContent()).toContain("Nicht geladen");
    await chip.click();
    const card = page.locator('.k2b-anchored-popover [data-ai-model-card="error"]');
    expect(await card.textContent()).toContain("Modelle konnten nicht geladen werden.");
    const retry = card.locator("button");
    expect(await retry.textContent()).toContain("Erneut versuchen");
    expect(await retry.evaluate((element) => element === document.activeElement)).toBe(true);
    await retry.click();
    const slider = page.locator(".k2b-anchored-popover [role=slider]");
    await slider.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "slider");
    expect(await chip.textContent()).toContain("Ausgewogen");
    const after = await trigger(page);
    expect(after.chip).toEqual(reference.chip);
    expect(after.level!.x).toBe(reference.lead!.x);
    await page.keyboard.press("Escape");
    expect(await chip.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  });

  test("a retry that fails again gives the focus back to Try again", async () => {
    const page = await open(1440, "?state=error&retry=fail");
    await page.click(".ai-model-chip");
    await page.keyboard.press("Enter");
    await page.waitForSelector("body[data-retried=true]");
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("Erneut versuchen"));
    expect(await page.locator('.k2b-anchored-popover [data-ai-model-card="error"]').count()).toBe(1);
    await page.close();
  });

  test("without a host that reloads the models, Try again loads the page again", async () => {
    const page = await open(1440, "?state=error&retry=default");
    await page.click(".ai-model-chip");
    const reload = page.waitForEvent("load");
    await page.click('.k2b-anchored-popover [data-ai-model-card="error"] button');
    await reload;
    await page.waitForSelector("body[data-ready=true] .ai-model-chip");
    await page.close();
  });

  test("the screen reader hears the model, its level and a problem, never the indicator", async () => {
    const spoken = async (query: string) => {
      const page = await open(1440, query);
      const snapshot = await page.locator(".ai-model-chip").ariaSnapshot();
      await page.close();
      // One button and nothing inside it of its own: the indicator is decoration, the name says it all.
      expect(snapshot.split("\n")).toHaveLength(1);
      return snapshot.match(/^- button "(.*)"/)?.[1];
    };
    expect(await spoken("?choice=thorough")).toBe("Modell, Gründlich, GPT-OSS · Gründlich");
    expect(await spoken("?choice=gemini-flash")).toBe("Modell, Gemini Flash");
    expect(await spoken("?state=budget")).toMatch(/^Modell, Maximal, Claude · Maximal, Budget aufgebraucht · wieder .+$/);
    expect(await spoken("?state=error")).toBe("Modelle nicht geladen");
    const running = await open(1440, "?state=running&choice=thorough");
    const chip = running.locator(".ai-model-chip");
    expect(await chip.isDisabled()).toBe(true);
    expect(await chip.getAttribute("title")).toBe("Während eine Antwort läuft, bleibt das Modell gleich.");
    await running.close();
  });

  test("on a phone the card is a sheet with 44 px buttons and the large slider", async () => {
    const page = await open(390, "?choice=thorough");
    await page.click(".ai-model-chip");
    const popover = page.locator(".k2b-anchored-popover");
    expect(await popover.getAttribute("data-sheet")).toBe("");
    expect(await popover.locator(".k2b-choice-slider").getAttribute("data-size")).toBe("lg");
    const size = (selector: string) =>
      popover
        .locator(selector)
        .first()
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [box.width, box.height];
        });
    expect(await size('button[aria-label="Zurück zu „Ausgewogen“"]')).toEqual([44, 44]);
    expect((await size('button[aria-label^="Alle Modelle"]'))[1]).toBe(44);
    await page.click('.k2b-anchored-popover button[aria-label^="Alle Modelle"]');
    expect(await size('button[aria-label="Zurück"]')).toEqual([44, 44]);
    await page.close();
  });
});
