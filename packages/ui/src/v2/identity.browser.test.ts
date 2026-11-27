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

test("leading a row or a cell a mark is 24, and 32 where the list or table shows pictures of its things; the row is 44 either way", async () => {
  await withPage(async (page) => {
    const sizes = (selector: string) =>
      page.locator(selector).evaluateAll((marks) =>
        marks.map((mark) => {
          const rect = mark.getBoundingClientRect();
          const row = mark.closest(".k2-row, tr")!.getBoundingClientRect();
          return `${Math.round(rect.width)}x${Math.round(rect.height)} in ${Math.round(row.height)}`;
        }),
      );
    // who or what a thing is (a base, a table, a form): 24 in a row or cell of 44
    // (a row of two lines keeps its 52)
    expect(await sizes("[aria-label='Bases'] > .k2-row > .k2-row-lead > .k2-mk")).toEqual(["24x24 in 44", "24x24 in 52"]);
    expect(await sizes("[aria-label='Tabellen'] td > .k2-cell-lead > .k2-mk")).toEqual(["24x24 in 44", "24x24 in 44"]);
    // a list with thumbnails or types (files): 32 for every mark in it, the folder without a picture too
    expect(await sizes("[aria-label='Dateien'] > .k2-row[data-lines='1'] > .k2-row-lead > .k2-mk")).toEqual(["32x32 in 44", "32x32 in 44"]);
  });
});

// the text edge of a list: a row that leads with a thing's mark, one with its thumbnail and one with a person start
// their names on one edge, 12 px after a lead of one size (W1b #4206 r5)
for (const width of [1440, 390])
  test(`at ${width} px a person, a mark and a thumbnail in one list start their names on one edge`, async () => {
    await withPage(async (page) => {
      const edges = await page.locator("[aria-label='Dateien'] > .k2-row").evaluateAll((rows) =>
        rows.map((row) => {
          const lead = row.querySelector(":scope > .k2-row-lead")!.getBoundingClientRect();
          const title = row.querySelector(".k2-row-title")!.getBoundingClientRect();
          return { lead: Math.round(lead.width), gap: Math.round(title.left - lead.right), edge: Math.round(title.left) };
        }),
      );
      expect(edges.length).toBe(6);
      expect(new Set(edges.map((row) => row.edge)).size).toBe(1);
      expect(new Set(edges.map((row) => row.gap))).toEqual(new Set([12]));
      expect(new Set(edges.map((row) => row.lead))).toEqual(new Set([width < 768 ? 40 : 32]));
    }, width);
  });

test("a mark takes its size from its place: 20 in the sidebar and a sentence, 32 leading rows of files of 44 px, 36 on a card", async () => {
  await withPage(async (page) => {
    expect(await box(page, ".k2-ni .k2-mk")).toBe("20x20");
    // as the mockup's lists of files and folders: a row of one line that leads with a mark is 44 px, its mark 32
    expect(await box(page, '.k2-row[data-lines="1"] > .k2-row-lead > .k2-mk')).toBe("32x32");
    expect(
      await page
        .locator('.k2-row[data-lines="1"][data-mark]')
        .first()
        .evaluate((row) => Math.round(row.getBoundingClientRect().height)),
    ).toBe(44);
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
    const kind = await page
      .locator(".k2-row", { hasText: "Angebot" })
      .locator(".k2-mk-kind")
      .evaluate((element) => {
        const mark = element.parentElement!.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return { text: element.textContent, inside: rect.left >= mark.left && rect.bottom <= mark.bottom && rect.right <= mark.right };
      });
    expect(kind).toEqual({ text: "PDF", inside: true });
  });
});

test("marks and sparks stay readable whatever the data colour is, light and dark", async () => {
  for (const theme of ["light", "dark"] as const)
    await withPage(async (page) => {
      if (theme === "dark") await page.evaluate(() => document.body.setAttribute("data-theme", "dark"));
      const found = await page.evaluate(() => {
        const rgb = (value: string) =>
          value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const lum = (value: string) => {
          const [r, g, b] = rgb(value).map((channel) => {
            const c = channel / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          }) as [number, number, number];
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a: string, b: string) => {
          const [light, dark] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
          return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
        };
        // the surface of the theme, read from its token in the scope
        const probe = document.createElement("span");
        probe.style.background = "var(--k2-surface)";
        document.body.append(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const pale = [...document.querySelectorAll(".k2-row")].find((row) => row.textContent?.includes("Sommerfest"))!;
        const mark = pale.querySelector<HTMLElement>(".k2-mk")!;
        const kind = mark.querySelector<HTMLElement>(".k2-mk-kind")!;
        const bars = [...document.querySelectorAll<HTMLElement>(".k2-tile .k2-spark > i")];
        return {
          symbol: ratio(getComputedStyle(mark).color, getComputedStyle(mark).backgroundColor),
          type: ratio(getComputedStyle(kind).color, getComputedStyle(kind).backgroundColor),
          bars: Math.min(...bars.map((bar) => ratio(getComputedStyle(bar).backgroundColor, surface))),
          surface,
        };
      });
      // a symbol and the bars of a history 3:1 (information in a drawing), the type on a mark 4.5:1
      expect(found.symbol).toBeGreaterThanOrEqual(3);
      expect(found.bars).toBeGreaterThanOrEqual(3);
      expect(found.type).toBeGreaterThanOrEqual(4.5);
    });
});

test("people stack with a ring and '+n' for the rest, as one picture with every name", async () => {
  await withPage(async (page) => {
    const stack = page.locator(".k2-avs").first();
    expect(await stack.getAttribute("aria-label")).toBe("Felix Thal, Jonas Kern, Mira Solberg, Tom Oswald, Sami Yilmaz");
    expect(await stack.locator(".k2-av").count()).toBe(3);
    expect(await stack.locator(".k2-avs-rest:visible").textContent()).toBe("+2");
    expect(await stack.locator(".k2-av[aria-hidden='true']").count()).toBe(3);
    const lefts = await stack.locator(".k2-av").evaluateAll((avatars) => avatars.map((avatar) => avatar.getBoundingClientRect().left));
    // each avatar lies 2 px over the one before it (20 px wide on a card)
    expect(lefts.slice(1).map((left, index) => Math.round(left - lefts[index]!))).toEqual([18, 18]);
    // and its ring never reaches the initials of the one before: every letter stays whole (review: "LI", "AI")
    const cut = await stack.locator(".k2-av").evaluateAll(
      (avatars) =>
        avatars.slice(0, -1).filter((avatar, index) => {
          const range = document.createRange();
          range.selectNodeContents(avatar.firstChild!);
          const letters = range.getBoundingClientRect();
          const next = avatars[index + 1]!.getBoundingClientRect();
          return letters.right > next.left - 2;
        }).length,
    );
    expect(cut).toBe(0);
  });
});

test("a stack in a narrow column shows the faces it holds whole and counts the rest, never cutting the count", async () => {
  for (const width of [1440, 390])
    await withPage(async (page) => {
      const found = await page.locator(".k2-table td .k2-avs").evaluateAll((stacks) =>
        stacks.map((stack) => {
          const cell = stack.closest("td")!;
          const style = getComputedStyle(cell);
          const right = cell.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
          const faces = [...stack.querySelectorAll(".k2-av")].filter((face) => getComputedStyle(face).display !== "none");
          const counts = [...stack.querySelectorAll(".k2-avs-rest")].filter((count) => getComputedStyle(count).display !== "none");
          const count = counts[0];
          return {
            faces: faces.length,
            counts: counts.length,
            text: count?.textContent,
            whole: count ? count.getBoundingClientRect().right <= right + 0.5 && count.scrollWidth <= count.clientWidth + 1 : true,
            inside: faces.every((face) => face.getBoundingClientRect().right <= right + 0.5),
          };
        }),
      );
      // 4, 8 and 30 people: the count belongs to the faces that stand, one count each, whole and inside the cell; 2 and
      // 3 people all show, without a count
      expect(found.map((stack) => stack.counts)).toEqual([1, 1, 1, 0, 0]);
      expect(found.slice(0, 3).map((stack) => Number(stack.text?.slice(1)) + stack.faces)).toEqual([4, 8, 30]);
      expect(found.slice(3).map((stack) => stack.faces)).toEqual([2, 3]);
      for (const stack of found) {
        expect(stack.faces).toBeGreaterThanOrEqual(1);
        expect(stack.whole).toBe(true);
        expect(stack.inside).toBe(true);
      }
    }, width);
});

test("a stack whose people all show ends at its last face, faces overlap at most a quarter with a ring, initials from first and last name (W3, review A)", async () => {
  for (const width of [390, 1024, 1440])
    await withPage(async (page) => {
      const found = await page.locator(".k2-table td .k2-avs[data-all]").evaluateAll((stacks) =>
        stacks.map((stack) => {
          const faces = [...stack.querySelectorAll<HTMLElement>(".k2-av")];
          const boxes = faces.map((face) => face.getBoundingClientRect());
          return {
            // no room after the last face (a count it does not need)
            gap: Math.round(stack.getBoundingClientRect().right - boxes.at(-1)!.right),
            // each face lies over the one before by at most a quarter of its width
            overlap: Math.max(0, ...boxes.slice(1).map((box, index) => (boxes[index]!.right - box.left) / box.width)),
            ring: getComputedStyle(faces[0]!).boxShadow.includes("2px"),
            initials: faces.map((face) => face.textContent),
          };
        }),
      );
      expect(found.map(({ gap }) => gap)).toEqual([0, 0]);
      for (const stack of found) {
        expect(stack.overlap).toBeLessThanOrEqual(0.25);
        expect(stack.ring).toBe(true);
      }
      expect(found[0]!.initials).toEqual(["CM", "🦊B"]);
    }, width);
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
    expect(spark.label).toBe("Werkstatt: in 7 Tagen von 0 auf 10 Änderungen gestiegen");
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

test("an activity opens its thing in place: a plain click reaches onNavigate and the page stays", async () => {
  await withPage(async (page) => {
    const before = await page.evaluate(() => location.href);
    await page.locator(".k2-row[data-activity] .k2-row-l1 a").first().click();
    await settled(page);
    expect(await page.evaluate(() => window.__k2Pressed)).toEqual(["open #auftraege"]);
    expect(await page.evaluate(() => location.href)).toBe(before);
  });
});

test("cards fill the tracks of their grid, however wide: no cap of a small tile holds them narrower", async () => {
  // the cap of a plain tile (a long file name is cut, never as wide as the row) must not reach a card
  for (const width of [1440, 1024])
    await withPage(async (page) => {
      const found = await page.locator(".k2-tiles[data-variant='card']").evaluate((grid) => {
        const tracks = getComputedStyle(grid)
          .gridTemplateColumns.split(" ")
          .map((track) => Number.parseFloat(track));
        const cards = [...grid.querySelectorAll(":scope > .k2-tile")].map((card) => card.getBoundingClientRect().width);
        return {
          maxWidth: getComputedStyle(grid.querySelector(":scope > .k2-tile")!).maxWidth,
          fill: cards.every((card) => Math.abs(card - tracks[0]!) < 1),
        };
      });
      expect(found).toEqual({ maxWidth: "none", fill: true });
    }, width);
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
    expect(found).toEqual({ atEnd: true, label: "Offene Aufträge: in 7 Tagen von 22 auf 41 gestiegen" });
  });
});

for (const width of [1440, 1024, 390])
  test(`the identity screen keeps the layout rules at ${width} px`, async () => {
    await withPage(async (page) => {
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    }, width);
  });
