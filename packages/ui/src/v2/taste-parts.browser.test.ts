import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-taste-parts.client";

// Defaults that changed with the v2 look: a single choice whose options carry a hint stands as connected cards (a row
// on a wide screen, a column on the phone, the chosen one framed 2 px inside with a tick, the point kept for the
// keyboard); a state in a table cell is its dot and its word without a tinted round; an empty place stands in the
// middle with its sentence as a title. The fixture is test/v2-taste-parts.client.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-taste-parts.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>, { dark = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui${dark ? " dark" : ""}"><div id="root"></div></body></html>`,
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

const cards = (page: Page) =>
  page.evaluate(() => {
    const [withHints, plain] = [...document.querySelectorAll<HTMLElement>('[data-k2-part="Choice"]')];
    return {
      cards: withHints!.hasAttribute("data-cards"),
      plain: plain!.hasAttribute("data-cards"),
      boxes: [...withHints!.querySelectorAll<HTMLElement>(":scope > .k2-choice")].map((card) => {
        const box = card.getBoundingClientRect();
        return {
          top: Math.round(box.top),
          left: Math.round(box.left),
          on: card.hasAttribute("data-on"),
          tick: !!card.querySelector(".k2-choice-tick[data-on]"),
        };
      }),
      ring: getComputedStyle(withHints!.querySelector(".k2-choice[data-on]")!).boxShadow,
    };
  });

test("1440 px: options with a hint stand as one row of cards, the chosen one framed with a tick; plain options stay points", async () => {
  await withPage(1440, async (page) => {
    const found = await cards(page);
    expect([found.cards, found.plain]).toEqual([true, false]);
    expect(new Set(found.boxes.map((box) => box.top)).size).toBe(1);
    expect(found.boxes.map((box) => [box.on, box.tick])).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
    expect(found.ring).toContain("inset");
    // the keyboard still chooses: the radio input of the second card takes the choice
    await page.locator('input[name="link"][value="org"]').check();
    expect((await cards(page)).boxes.map((box) => box.on)).toEqual([false, true, false]);
  });
});

test("390 px: the cards stand one under the other", async () => {
  await withPage(390, async (page) => {
    const found = await cards(page);
    expect(new Set(found.boxes.map((box) => box.left)).size).toBe(1);
    expect(found.boxes[1]!.top).toBeGreaterThan(found.boxes[0]!.top);
  });
});

test("a state in a table cell is its dot and its word: no round, colour only for waiting and wrong", async () => {
  await withPage(1440, async (page) => {
    const states = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".k2-table td .k2-chip[data-status]")].map((chip) => {
        const style = getComputedStyle(chip);
        return { background: style.backgroundColor, weight: style.fontWeight, dot: !!chip.querySelector(".k2-dot") };
      }),
    );
    expect(states.map((state) => [state.background, state.dot])).toEqual([
      ["rgba(0, 0, 0, 0)", true],
      ["rgba(0, 0, 0, 0)", true],
      ["rgba(0, 0, 0, 0)", true],
    ]);
    expect(states.map((state) => state.weight)).toEqual(["400", "500", "500"]);
  });
});

test("an empty place stands in the middle of its pane, its sentence in 15/600 and a quieter sentence under it", async () => {
  for (const width of [1440, 390])
    await withPage(width, async (page) => {
      const found = await page.evaluate(() => {
        const empty = document.querySelector<HTMLElement>('[data-k2-part="Empty"]')!;
        const pane = empty.closest(".k2-pane")!.getBoundingClientRect();
        const box = empty.getBoundingClientRect();
        const text = getComputedStyle(empty.querySelector(".k2-state-text")!);
        return {
          centre: Math.abs(box.left + box.width / 2 - (pane.left + pane.width / 2)),
          font: `${text.fontSize}/${text.lineHeight} ${text.fontWeight}`,
          hint: !!empty.querySelector(".k2-state-hint"),
        };
      });
      expect(found.centre).toBeLessThanOrEqual(1);
      expect([found.font, found.hint]).toEqual(["15px/22px 600", true]);
    });
});

test("choosing a card never moves the layout: the tick keeps its room on every card, at 700 and 440 px", async () => {
  for (const width of [700, 440])
    await withPage(width, async (page) => {
      const height = () =>
        page.evaluate(() => Math.round(document.querySelector('[data-k2-part="Choice"]')!.getBoundingClientRect().height));
      const before = await height();
      for (const value of ["org", "public", "invited"]) {
        await page.locator(`input[name="link"][value="${value}"]`).check();
        expect([width, value, await height()]).toEqual([width, value, before]);
      }
    });
});

test("a narrow place stacks the cards by its own width, not the window's: a field of 440 px at a wide window", async () => {
  await withPage(1440, async (page) => {
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-k2-part="Choice"]')!.closest<HTMLElement>(".k2-field")!.style.width = "440px";
    });
    const lefts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-k2-part="Choice"]')[0]!.querySelectorAll(":scope > .k2-choice")].map((card) =>
        Math.round(card.getBoundingClientRect().left),
      ),
    );
    expect(new Set(lefts).size).toBe(1);
  });
});

test("the keyboard moves the choice and its ring; a card's name is its words, its hint describes it", async () => {
  await withPage(1440, async (page) => {
    await page.locator('input[name="link"][value="invited"]').focus();
    await page.keyboard.press("ArrowRight");
    const found = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-k2-part="Choice"]')[0]!.querySelectorAll<HTMLElement>(":scope > .k2-choice")];
      return { on: cards.map((card) => card.hasAttribute("data-on")), ring: getComputedStyle(cards[1]!).boxShadow };
    });
    expect(found.on).toEqual([false, true, false]);
    // the focus ring: the blue frame inside and the soft ring outside
    expect(found.ring.split("inset").length).toBeGreaterThan(1);
    expect(found.ring).toContain("0px 0px 0px 3px");
    const radio = page.locator('[data-k2-part="Choice"]').first().getByRole("radio", { name: "Alle in der Organisation", exact: true });
    expect(await radio.count()).toBe(1);
    expect(await radio.evaluate((input) => document.getElementById(input.getAttribute("aria-describedby")!)?.textContent)).toBe(
      "Nach Anmeldung, nur ansehen",
    );
  });
});

test("disabled cards are dimmed and take no choice; in dark the chosen card keeps its frame on its own tint", async () => {
  await withPage(1440, async (page) => {
    const locked = page.locator('[data-k2-part="Choice"]').nth(2);
    expect(await locked.locator("input").first().isDisabled()).toBe(true);
    expect(
      Number(
        await locked
          .locator(".k2-choice")
          .first()
          .evaluate((card) => getComputedStyle(card).opacity),
      ),
    ).toBeLessThan(1);
  });
  await withPage(
    1440,
    async (page) => {
      const card = await page.evaluate(() => {
        const chosen = document.querySelector<HTMLElement>(".k2-choices[data-cards] > .k2-choice[data-on]")!;
        const probe = document.createElement("div");
        probe.style.background = "var(--k2-surface)";
        document.body.append(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { background: getComputedStyle(chosen).backgroundColor, ring: getComputedStyle(chosen).boxShadow, surface };
      });
      expect(card.ring).toContain("inset");
      // the tint of the chosen card stands apart from the dark surface
      expect(card.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(card.background).not.toBe(card.surface);
    },
    { dark: true },
  );
});

test("cards without a label, straight in a pane or a group, stack at 390 px", async () => {
  await withPage(390, async (page) => {
    const lefts = await page.evaluate(() =>
      ["pane-cards", "group-cards"]
        .map((name) => document.querySelector(`input[name="${name}"]`)!.closest('[data-k2-part="Choice"]')!)
        .map(
          (choice) =>
            new Set([...choice.querySelectorAll(":scope > .k2-choice")].map((card) => Math.round(card.getBoundingClientRect().left))).size,
        ),
    );
    expect(lefts).toEqual([1, 1]);
  });
});
