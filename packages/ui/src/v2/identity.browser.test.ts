import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-identity.client";
import { measureV2Layout } from "./testing";

// Things with a face, in the browser (design pass 26.11.): a mark's size comes from its place, a thumbnail lies over
// the symbol or leaves it when it fails, people stack with "+n", cards hold figures, people and a history, the card
// that makes a new thing keeps its choices pressable, and an activity is a sentence beside its person.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-identity.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    // the thumbnails are addresses of their own: they load or fail at once
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".k2-mk[data-image]")].every((mark) => mark.getAttribute("data-image") !== ""),
    );
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    });

test("a mark takes its size from its place: 20 in the sidebar and a sentence, 24 and 32 leading rows, 36 on a card", async () => {
  await withPage(async (page) => {
    expect(await box(page, ".k2-ni .k2-mk")).toBe("20x20");
    expect(await box(page, '.k2-row[data-lines="1"] > .k2-row-lead > .k2-mk')).toBe("24x24");
    expect(await box(page, '.k2-row[data-lines="2"][data-mark] > .k2-row-lead > .k2-mk')).toBe("32x32");
    expect(await box(page, ".k2-tiles[data-variant='card'] .k2-tile-top > .k2-mk")).toBe("36x36");
    expect(await box(page, ".k2-row[data-activity] .k2-row-l1 .k2-mk")).toBe("20x20");
    // a sidebar entry without a colour keeps its plain symbol
    expect(await page.locator(".k2-ni", { hasText: "Papierkorb" }).locator(".k2-mk").count()).toBe(0);
    // the mark is decoration beside its name, unless it carries one
    expect(await page.locator(".k2-mk[aria-hidden='true']").count()).toBeGreaterThan(4);
    expect(await page.getByRole("img", { name: "PDF", exact: true }).count()).toBe(1);
  });
});

test("a thumbnail lies over the symbol in the same place, and the symbol stays when the picture fails", async () => {
  await withPage(async (page) => {
    const look = (name: string) =>
      page
        .locator(".k2-row", { hasText: name })
        .locator(".k2-mk")
        .evaluate((mark) => {
          const outer = mark.getBoundingClientRect();
          const image = mark.querySelector("img")?.getBoundingClientRect();
          return {
            state: mark.getAttribute("data-image"),
            box: `${outer.width}x${outer.height}`,
            image: image ? `${image.left - outer.left},${image.top - outer.top} ${image.width}x${image.height}` : null,
            symbol: mark.querySelector(".k2-icon") !== null,
            alt: mark.querySelector("img")?.getAttribute("alt") ?? null,
          };
        });
    expect(await look("Ansicht Front Eiche.jpg")).toEqual({ state: "shown", box: "32x32", image: "0,0 32x32", symbol: true, alt: "" });
    expect(await look("Bestand Küche vorher.jpg")).toEqual({ state: "failed", box: "32x32", image: null, symbol: true, alt: null });
    // the type stands on the corner, inside the mark
    const kind = await page.locator(".k2-mk-kind").evaluate((element) => {
      const mark = element.parentElement!.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return { text: element.textContent, inside: rect.left >= mark.left && rect.bottom <= mark.bottom && rect.right <= mark.right };
    });
    expect(kind).toEqual({ text: "PDF", inside: true });
  });
});

test("people stack with a ring and '+n' for the rest, as one picture with every name", async () => {
  await withPage(async (page) => {
    const stack = page.locator(".k2-avs").first();
    expect(await stack.getAttribute("aria-label")).toBe("Felix Thal, Jonas Kern, Mira Solberg, Tom Oswald, Sami Yilmaz");
    expect(await stack.locator(".k2-av").count()).toBe(3);
    expect(await stack.locator(".k2-avs-rest").textContent()).toBe("+2");
    expect(await stack.locator(".k2-av[aria-hidden='true']").count()).toBe(3);
    const lefts = await stack.locator(".k2-av").evaluateAll((avatars) => avatars.map((avatar) => avatar.getBoundingClientRect().left));
    // each avatar lies 6 px over the one before it (20 px wide on a card)
    expect(lefts.slice(1).map((left, index) => Math.round(left - lefts[index]!))).toEqual([14, 14]);
  });
});

test("a spark draws its last value in full colour and names the drawing, not each bar", async () => {
  await withPage(async (page) => {
    const spark = await page.locator(".k2-tile .k2-spark").evaluate((element) => {
      const bars = [...element.querySelectorAll("i")];
      return {
        label: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        height: element.getBoundingClientRect().height,
        bars: bars.map((bar) => Math.round(bar.getBoundingClientRect().height)),
        last: getComputedStyle(bars.at(-1)!).backgroundColor,
        first: getComputedStyle(bars[0]!).backgroundColor,
      };
    });
    expect(spark.role).toBe("img");
    expect(spark.label).toBe("Änderungen der letzten 7 Tage");
    expect(spark.height).toBe(20);
    // the highest value fills the height; a value of 0 keeps a sliver, so the day still shows
    expect(spark.bars.at(-1)).toBe(20);
    expect(spark.bars[0]).toBeGreaterThan(0);
    // in the card's colour: the last bar full, the others lighter
    expect(spark.last).toBe("rgb(194, 65, 12)");
    expect(spark.first).not.toBe(spark.last);
  });
});

test("a card holds its mark, figures, people and history without a box inside, and opens as a whole", async () => {
  await withPage(async (page) => {
    const card = page.locator(".k2-tiles[data-variant='card'] > .k2-tile").first();
    const shape = await card.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width >= 240,
        radius: style.borderTopLeftRadius,
        shadow: style.boxShadow,
        stats: [...element.querySelectorAll(".k2-tile-stat")].map((stat) => stat.textContent),
        foot: element.querySelector(".k2-tile-foot-text")?.textContent,
      };
    });
    expect(shape).toEqual({
      width: true,
      radius: "8px",
      shadow: "none",
      stats: ["6 Tabellen", "8 knapp", "3 Anträge"],
      foot: "Felix · vor 2 Min",
    });
    // the whole card is the link of its name: a point on its empty foot meets the link
    const target = await card.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document
        .elementFromPoint(rect.left + rect.width / 2, rect.bottom - 6)
        ?.closest("a")
        ?.getAttribute("href");
    });
    expect(target).toBe("#werkstatt");
    // a long name is cut on one line and never widens its card
    const long = page.locator(".k2-tiles[data-variant='card'] > .k2-tile").nth(1);
    const cut = await long.locator(".k2-tile-title").evaluate((element) => ({
      lines: Math.round(element.getBoundingClientRect().height / 20),
      wider: element.scrollWidth > element.clientWidth,
    }));
    expect(cut).toEqual({ lines: 1, wider: true });
  });
});

test("the card that makes a new thing is dashed, and its quick choices stay pressable above its stretch", async () => {
  await withPage(async (page) => {
    const make = page.locator(".k2-tile[data-create]");
    expect(await make.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("dashed");
    await make.getByRole("button", { name: "Lager" }).click();
    await make.getByRole("button", { name: "Neue Base" }).click();
    expect(await page.evaluate(() => window.__k2Pressed)).toEqual(["Lager", "Neue Base"]);
  });
});

test("an activity is a sentence beside its person that may wrap, with place and time quiet under it", async () => {
  await withPage(async (page) => {
    const entry = page.locator(".k2-row[data-activity]").first();
    const found = await entry.evaluate((element) => {
      const sentence = element.querySelector(".k2-row-l1")!;
      const meta = element.querySelector(".k2-row-l2")!;
      const avatar = element.querySelector(".k2-row-lead > .k2-av")!;
      return {
        person: avatar.getAttribute("aria-label"),
        meta: meta.textContent,
        metaSize: getComputedStyle(meta).fontSize,
        link: sentence.querySelector("a")?.getAttribute("href"),
      };
    });
    expect(found).toEqual({ person: "Felix Thal", meta: "Werkstatt · 09:42", metaSize: "12px", link: "#auftraege" });
  });
  // in a narrow column the sentence wraps instead of being cut
  await withPage(async (page) => {
    const wraps = await page
      .locator(".k2-row[data-activity] .k2-row-l1")
      .first()
      .evaluate((element) => element.getBoundingClientRect().height > 20);
    expect(wraps).toBe(true);
  }, 390);
});

test("a key number shows its trend at the end of its value", async () => {
  await withPage(async (page) => {
    const found = await page
      .locator(".k2-cell")
      .first()
      .evaluate((cell) => {
        const value = cell.querySelector(".k2-cell-value")!.getBoundingClientRect();
        const spark = cell.querySelector(".k2-spark")!.getBoundingClientRect();
        return { atEnd: Math.abs(value.right - spark.right) < 1, label: cell.querySelector(".k2-spark")!.getAttribute("aria-label") };
      });
    expect(found).toEqual({ atEnd: true, label: "Offene Aufträge der letzten 7 Tage" });
  });
});

for (const width of [1440, 1024, 390])
  test(`the identity screen keeps the layout rules at ${width} px`, async () => {
    await withPage(async (page) => {
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    }, width);
  });
