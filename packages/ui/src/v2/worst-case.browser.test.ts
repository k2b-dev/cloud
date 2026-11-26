import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-worst.client";
import { measureV2Layout } from "./testing";

// Worst-case states that change after the page is live (break-ui 25.11., review of #4210): a note that grows past its
// lines, a hidden tab that becomes the open one, an address cut in the middle in a narrow row, an amount among marks.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-worst.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>, scenario = "") => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-case="${scenario}"><div id="root"></div></body></html>`,
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

test("a summary that grows past its four lines after the page is live offers 'Mehr anzeigen'", async () => {
  await withPage(1024, async (page) => {
    const more = page.getByRole("button", { name: "Mehr anzeigen" });
    expect(await more.count()).toBe(0);
    await page.evaluate(() => window.__k2GrowNote?.());
    await more.waitFor();
    await more.click();
    await page.getByText("Sechste Zeile").waitFor();
    expect(await page.getByRole("button", { name: "Weniger anzeigen" }).isVisible()).toBe(true);
  });
});

test("a hidden tab that becomes the open one shows, cut if it must, and is no entry of the menu", async () => {
  await withPage(420, async (page) => {
    const tab = page.locator(".k2-tab", { hasText: "Entwürfe" });
    expect(await tab.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
    await page.evaluate(() => window.__k2OpenTab?.("Entwürfe"));
    await settled(page);
    expect(await tab.getAttribute("aria-current")).toBe("page");
    expect(await tab.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
    const box = await tab.boundingBox();
    const line = await page.locator(".k2-tabs").boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((line?.y ?? 0) + (line?.height ?? 0) + 0.5);
  });
});

test("an address with a short start, cut in the middle, stays inside its row and ends in '…'", async () => {
  await withPage(240, async (page) => {
    const parts = await page.evaluate(() => {
      const cut = document.querySelector(".k2-midcut")!;
      const title = cut.closest(".k2-row-title")!.getBoundingClientRect();
      const end = cut.lastElementChild as HTMLElement;
      return {
        overflow: Math.max(0, cut.getBoundingClientRect().right - title.right, end.getBoundingClientRect().right - title.right),
        cut: end.scrollWidth > end.clientWidth,
        ellipsis: getComputedStyle(end).textOverflow,
      };
    });
    expect(parts.overflow).toBeLessThanOrEqual(0.5);
    expect(parts.cut).toBe(true);
    expect(parts.ellipsis).toBe("ellipsis");
  });
});

for (const width of [1024, 220])
  test(`an amount among a row's marks is never cut at ${width} px: it shows whole or leaves whole`, async () => {
    await withPage(width, async (page) => {
      const amount = await page.evaluate(() => {
        const chip = document.querySelector(".k2-row-marks > .k2-chip")!;
        const marks = chip.closest(".k2-row-marks")!.getBoundingClientRect();
        const words = chip.querySelector(".k2-chip-text")!;
        const box = chip.getBoundingClientRect();
        const inside =
          box.left >= marks.left - 0.5 && box.right <= marks.right + 0.5 && box.top >= marks.top - 0.5 && box.bottom <= marks.bottom + 0.5;
        const outside = box.top >= marks.bottom || box.bottom <= marks.top;
        return {
          whole: words.scrollWidth <= words.clientWidth + 0.5,
          inside,
          outside,
          box: [box.left, box.top, box.right, box.bottom].map(Math.round),
          marks: [marks.left, marks.top, marks.right, marks.bottom].map(Math.round),
        };
      });
      expect(amount).toEqual(expect.objectContaining({ whole: true }));
      expect(amount.inside || amount.outside).toBe(true);
      if (width === 1024) expect(amount.inside).toBe(true);
    });
  });

// W1b (Files #4206): the date of a large table's phone row stood past the right edge at 390 px, and the measure
// passed it. Every part of a row stays inside the row; the measure reports a part that does not.
test("a large table's phone rows keep their date inside the row at 390 px, and the measure says so", async () => {
  await withPage(
    390,
    async (page) => {
      const past = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".k2-table-phone .k2-row-time")).map((time) => {
          const row = time.closest(".k2-row")!.getBoundingClientRect();
          // how far the date stands past the row's text edge (16 px in from its border)
          return Math.round(time.getBoundingClientRect().right - (row.right - 16));
        }),
      );
      expect(past.length).toBe(3);
      for (const over of past) expect(Math.abs(over)).toBe(0);
      const layout = await measureV2Layout(page, { root: "#root" });
      expect(layout.past).toEqual([]);
    },
    "table",
  );
});

// DR (#4229): a table's phone rows lost the row's deeds, so a dialog's table could not be worked on the phone. A phone
// row carries them at its end, inside the row, and they open.
test("a large table's phone rows keep the row's deeds at 390 px", async () => {
  await withPage(
    390,
    async (page) => {
      const deeds = page.locator(".k2-table-phone .k2-row .k2-btn[aria-haspopup='menu']");
      expect(await deeds.count()).toBe(3);
      const inside = await deeds.evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          const row = button.closest(".k2-row")!.getBoundingClientRect();
          return box.width > 0 && box.left >= row.left && box.right <= row.right + 0.5;
        }),
      );
      expect(inside).toEqual([true, true, true]);
      await page.getByRole("button", { name: "Aktionen für Angebote" }).click();
      await page.getByRole("menuitem", { name: "Umbenennen" }).waitFor();
      await page.keyboard.press("Escape");
      expect((await measureV2Layout(page, { root: "#root" })).past).toEqual([]);
    },
    "table",
  );
});

// The coordinator's decision of 26.11.: on the phone the open view never gives way to deeds that keep their words;
// they fold into the head's menu, the open tab keeps its whole name.
test("on the phone a crowded head keeps the open tab whole; its kept deeds wait in the head's menu", async () => {
  await withPage(
    390,
    async (page) => {
      const tab = page.locator(".k2-tab", { hasText: "Alle" });
      const label = await tab.evaluate((element) => {
        const words = element.querySelector(".k2-tab-label") ?? element;
        const box = words.getBoundingClientRect();
        const row = element.closest(".k2-tabs")!.getBoundingClientRect();
        return { width: Math.round(box.width), whole: words.scrollWidth <= words.clientWidth + 0.5, inside: box.right <= row.right + 0.5 };
      });
      expect(label.width).toBeGreaterThan(10);
      expect(label).toEqual(expect.objectContaining({ whole: true, inside: true }));
      // the kept deeds still reach their person: in the head's menu
      await page.getByRole("button", { name: "Weitere Aktionen" }).click();
      await page.getByRole("menuitem", { name: "Suche fokussieren" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Gesperrt" }).isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      const layout = await measureV2Layout(page, { root: "#root" });
      expect(layout.squeezed).toEqual([]);
      expect(layout.cut).toEqual([]);
    },
    "head",
  );
});

// U2 (Tools #4235): a second line without a break (an address, JSON) ran under the marks and the deed and past the
// row. A second line stays one line, ends in "…" before what stands beside it, and says all of it on hover.
/** Where the visible text of each second line ends, and what of the row it lies under. */
const secondLines = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".k2-row > .k2-row-l2"))
      .filter((line) => line.getBoundingClientRect().width > 0)
      .map((line) => {
        const row = line.parentElement!;
        const box = line.getBoundingClientRect();
        const clips = getComputedStyle(line).overflowX !== "visible";
        const right = clips ? box.right : box.left + line.scrollWidth;
        const inner = row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight);
        const under = Array.from(row.querySelectorAll(":scope > :is(.k2-row-marks, .k2-row-end, .k2-row-time)"))
          .filter((part) => {
            const other = part.getBoundingClientRect();
            return (
              other.width > 0 &&
              right > other.left + 0.5 &&
              box.left < other.right &&
              box.bottom > other.top + 0.5 &&
              box.top < other.bottom - 0.5
            );
          })
          .map((part) => part.className);
        return {
          past: Math.max(0, Math.round(right - inner)),
          under,
          title: (line.getAttribute("title") ?? "").length > 200 || (line.textContent ?? "").length < 200,
        };
      }),
  );

for (const width of [1024, 390])
  test(`a second line of 300 signs without a break stays one line beside the deed and the marks at ${width} px`, async () => {
    await withPage(
      width,
      async (page) => {
        for (const line of await secondLines(page)) expect(line).toEqual({ past: 0, under: [], title: true });
        expect((await measureV2Layout(page, { root: "#root" })).past).toEqual([]);
      },
      "rows",
    );
  });

test("a phone row of a large table cuts its second line before its marks", async () => {
  await withPage(
    390,
    async (page) => {
      for (const line of await secondLines(page)) expect(line).toEqual({ past: 0, under: [], title: true });
      expect((await measureV2Layout(page, { root: "#root" })).past).toEqual([]);
    },
    "table",
  );
});

// Review r2 of #4210: a head with views, a kept deed with words and the app's own "…": one "…" only, which holds both
// the app's deeds and the folded one; a pressed deed says so in the menu.
test("on the phone a head with its own … folds its kept deeds into that one menu, a pressed deed checked", async () => {
  await withPage(
    390,
    async (page) => {
      const more = page.getByRole("button", { name: "Weitere Aktionen" });
      const shown = await more.evaluateAll((buttons) => buttons.filter((button) => (button as HTMLElement).offsetWidth > 0).length);
      expect(shown).toBe(1);
      await more.filter({ visible: true }).click();
      await page.getByRole("menuitem", { name: "Einstellungen" }).waitFor();
      const folded = page.getByRole("menuitemcheckbox", { name: "Markiert" });
      expect(await folded.getAttribute("aria-checked")).toBe("true");
      await folded.click();
      await settled(page);
      // a ticked entry keeps the menu open; open it again only if it closed
      if (!(await page.getByRole("menuitemcheckbox", { name: "Markiert" }).isVisible())) await more.filter({ visible: true }).click();
      expect(await page.getByRole("menuitemcheckbox", { name: "Markiert" }).getAttribute("aria-checked")).toBe("false");
    },
    "headmenu",
  );
});

/** The "…" buttons a person sees in the head. */
const shownMenus = (page: Page) =>
  page
    .locator("[data-slot='head'] .k2-btn[data-icon-only][aria-haspopup='menu']")
    .evaluateAll((buttons) =>
      buttons.filter((button) => (button as HTMLElement).offsetWidth > 0).map((button) => button.getAttribute("aria-label")),
    );

// Review r3 of #4210: a kept icon button is no "…": beside it the bar's own "…" still shows and holds the folded deed.
test("on the phone a kept icon button beside a folded deed leaves the bar's … to hold that deed", async () => {
  await withPage(
    390,
    async (page) => {
      expect(await shownMenus(page)).toEqual(["Weitere Aktionen"]);
      await page.getByRole("button", { name: "Weitere Aktionen" }).click();
      await page.getByRole("menuitem", { name: "Freigeben" }).waitFor();
    },
    "headicon",
  );
});

// Review r3 of #4210: with two "…" of its own the head lists a folded deed once, in the first, and shows no third "…".
test("on the phone a head with two … of its own folds its kept deed into the first only", async () => {
  await withPage(
    390,
    async (page) => {
      expect(await shownMenus(page)).toEqual(["Weitere Aktionen", "Ansicht"]);
      const entries = async (name: string) => {
        await page.getByRole("button", { name }).click();
        await page.getByRole("menu").waitFor();
        const labels = await page.getByRole("menu").getByRole("menuitem").allTextContents();
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
        return labels.map((label) => label.trim());
      };
      expect(await entries("Weitere Aktionen")).toEqual(["Einstellungen", "Freigeben"]);
      expect(await entries("Ansicht")).toEqual(["Kompakt"]);
    },
    "headtwo",
  );
});

// Review r3 of #4210: a second line is cut in its own box, so a link in it draws its ring inside that box.
test("a link in a cut second line shows its whole focus ring", async () => {
  await withPage(
    1024,
    async (page) => {
      const link = page.getByRole("link", { name: "Letzte Anfragen öffnen" });
      for (let step = 0; step < 20 && !(await link.evaluate((element) => element === document.activeElement)); step++)
        await page.keyboard.press("Tab");
      await settled(page);
      const ring = await link.evaluate((element) => {
        const style = getComputedStyle(element);
        const grow =
          style.outlineStyle === "none" ? 0 : Math.max(0, Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset));
        const box = element.getBoundingClientRect();
        const clip = element.closest(".k2-row-l2")!.getBoundingClientRect();
        return {
          focused: element.matches(":focus-visible"),
          drawn: style.outlineStyle !== "none" || style.boxShadow !== "none",
          inside:
            box.left - grow >= clip.left - 0.5 &&
            box.right + grow <= clip.right + 0.5 &&
            box.top - grow >= clip.top - 0.5 &&
            box.bottom + grow <= clip.bottom + 0.5 &&
            !style.boxShadow.split("),").some((shadow) => shadow !== "none" && !shadow.includes("inset")),
        };
      });
      expect(ring).toEqual({ focused: true, drawn: true, inside: true });
    },
    "rows",
  );
});

// Review of #4251: a tab that is open on one device only keeps the rules of the open tab there: without room it stays
// after the tabs that fit, and where even a short name has no room it stands alone, cut, and is no entry of the menu.
for (const [width, device] of [
  [390, "phone"],
  [1440, "desktop"],
] as const)
  test(`tabs open on the ${device} only keep the open tab's place and its tick in the menu at ${width} px`, async () => {
    await withPage(
      width,
      async (page) => {
        const state = (label: string) =>
          page.locator(`nav[aria-label="${label}"] .k2-tab`).evaluateAll((tabs) =>
            tabs.map((tab) => ({
              name: tab.querySelector(".k2-tab-label")?.textContent ?? tab.textContent?.trim(),
              shown: (tab as HTMLElement).offsetWidth > 0 && !tab.hasAttribute("data-overflow"),
              current: tab.getAttribute("aria-current"),
            })),
          );
        const open = (tabs: { name?: string | null; shown: boolean; current: string | null }[]) =>
          // a tab folded away is hidden (out of the accessibility tree too); the open ones a person sees and hears
          tabs.filter((tab) => tab.current === "page" && tab.shown).map((tab) => tab.name);
        const many = await state("Viele");
        const tight = await state("Eng");
        const tiny = await state("Winzig");
        if (device === "desktop") {
          expect(open(many)).toEqual(["Übersicht"]);
          expect(open(tight)).toEqual(["Übersicht"]);
          expect(open(tiny)).toEqual(["Übersicht"]);
          return;
        }
        // the last of six stays after the tabs that fit
        expect(open(many)).toEqual(["Notizen"]);
        expect(await page.locator(`nav[aria-label="Viele"] .k2-tab`, { hasText: "Notizen" }).getAttribute("data-kept")).toBe("");
        // too little room even for a short name (less than 96 px): it still stands, alone and cut, at least a symbol and
        // "…" wide; the menu holds the others only
        expect(open(tight)).toEqual(["Notizen der Woche"]);
        const cut = await page.locator(`nav[aria-label="Eng"] .k2-tab[aria-current]`).evaluate((tab) => ({
          kept: tab.hasAttribute("data-kept"),
          width: Math.round(tab.getBoundingClientRect().width),
        }));
        expect(cut.kept).toBe(true);
        expect(cut.width).toBeLessThan(96);
        expect(cut.width).toBeGreaterThanOrEqual(24);
        await page.locator(`nav[aria-label="Eng"] .k2-tab[data-menu]`).click();
        const entries = (await page.getByRole("menu").getByRole("menuitem").allTextContents()).map((entry) => entry.trim());
        expect(entries).toEqual(["Übersicht", "Verlauf"]);
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
        // not even a symbol and "…" fit: a cut would say nothing, so the open view is the menu's ticked entry, and the
        // menu tab is the open one
        expect(open(tiny)).toEqual(["Mehr"]);
        await page.locator(`nav[aria-label="Winzig"] .k2-tab[data-menu]`).click();
        expect(await page.getByRole("menuitemcheckbox", { name: "Notizen der Woche" }).getAttribute("aria-checked")).toBe("true");
      },
      "tabsfold",
    );
  });

// Spaces and Notebooks (26.11.): with five views and the last one open, the open view folded into "Mehr" at 1024 and
// 390 px. The open tab always stands in the line, whole or cut with "…", and the others fold first, also when the
// open one depends on the device.
for (const width of [1024, 390])
  test(`with five views the open one stays in sight at ${width} px, also as a device default`, async () => {
    await withPage(
      width,
      async (page) => {
        const seen = (label: string) =>
          page.locator(`nav[aria-label="${label}"] .k2-tab[aria-current="page"]`).evaluateAll((tabs) =>
            tabs.map((tab) => {
              const box = tab.getBoundingClientRect();
              const line = tab.closest(".k2-tabs-nav")!.getBoundingClientRect();
              const words = tab.querySelector(".k2-tab-label")?.getBoundingClientRect();
              return {
                name: tab.textContent?.trim(),
                visible:
                  getComputedStyle(tab).visibility === "visible" && box.width > 0 && box.top < line.bottom && box.right <= line.right + 0.5,
                words: Math.round(words?.width ?? box.width) >= 40,
                // it stands by the rule of the open tab: after the tabs that fit, the others folded
                kept: tab.hasAttribute("data-kept"),
              };
            }),
          );
        // the views do not all fit: some fold (else the test proves nothing)
        const folded = await page
          .locator(".k2-tab[data-overflow]")
          .evaluateAll((tabs) => tabs.map((tab) => tab.closest("nav")!.getAttribute("aria-label")));
        expect(new Set(folded)).toEqual(new Set(["Raum", "Notizbuch"]));
        expect(await seen("Raum")).toEqual([{ name: "Einstellungen des Raums", visible: true, words: true, kept: true }]);
        const device = width < 768 ? "Einstellungen des Raums" : "Dateien und Ordner";
        expect(await seen("Notizbuch")).toEqual([{ name: device, visible: true, words: true, kept: true }]);
        // the menu of further views does not name the open view again
        for (const label of ["Raum", "Notizbuch"]) {
          const more = page.locator(`nav[aria-label="${label}"] .k2-tab[data-menu]`);
          if ((await more.count()) === 0) continue;
          await more.click();
          const entries = (await page.getByRole("menu").getByRole("menuitem").allTextContents()).map((entry) => entry.trim());
          expect(entries).not.toContain(label === "Raum" ? "Einstellungen des Raums" : device);
          await page.keyboard.press("Escape");
          await page.getByRole("menu").waitFor({ state: "hidden" });
        }
      },
      "tabsfive",
    );
  });
