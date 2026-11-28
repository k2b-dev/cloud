import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-section-more.client";
import { measureV2Layout } from "./testing";

// Valentin (26.11., list-detail recipe): a section's way to all of it ("Alle Ereignisse ›") stood at the right of its
// section. It stands under the rows, its words on their text edge, also after a symbol and on the phone.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-section-more.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>, dir: "ltr" | "rtl" = "ltr") => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de" dir="${dir}"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

for (const width of [1440, 390])
  test(`a section's way to all of it stands under its rows on their text edge at ${width} px`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2-pane:not([data-side]) .k2-sec")).map((section) => {
          const words = section.querySelector(".k2-sec-link > b")!.getBoundingClientRect();
          const rows = Array.from(section.querySelectorAll(".k2-row"));
          const text = rows[0]!.querySelector(".k2-row-l1")!.getBoundingClientRect();
          const last = rows.at(-1)!.getBoundingClientRect();
          return {
            edge: Math.round(words.left - text.left),
            under: words.top >= last.bottom - 0.5,
            left: words.left < section.getBoundingClientRect().left + section.getBoundingClientRect().width / 2,
          };
        }),
      );
      // the words of the way start where the text of the rows starts: after a symbol (44 or 40 px) and without one
      expect(found).toEqual([
        { edge: 0, under: true, left: true },
        { edge: 0, under: true, left: true },
      ]);
      // a side column keeps its way as a row from the edge of its column (on the phone, where the columns stand one
      // under the other, too)
      const side = await page.evaluate(() => {
        const link = document.querySelector(".k2-pane[data-side] .k2-sec-link");
        const section = link?.closest(".k2-sec");
        return link && section ? Math.round(link.getBoundingClientRect().left - section.getBoundingClientRect().left) : null;
      });
      expect(side).toBe(0);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });

// Review of #4173: a section takes an anchor for a link to it, and a way that folds the list points up, not onwards.
test("a section carries its anchor, and its way shows its own symbol instead of the chevron", async () => {
  await withPage(1440, async (page) => {
    const ways = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".k2-pane:not([data-side]) .k2-sec")).map((section) => ({
        id: section.id,
        icon: Array.from(section.querySelectorAll(".k2-sec-link [data-k2-part='Icon']")).at(-1)?.getAttribute("data-name"),
      })),
    );
    expect(ways).toEqual([
      { id: "", icon: "chevron-right" },
      { id: "notes", icon: "chevron-up" },
    ]);
  });
});

// Review of #4337: in a page written right to left the way stands at the right, its words on the rows' text edge there.
test("in a page written right to left the way's words start on the rows' text edge at the right", async () => {
  await withPage(
    1440,
    async (page) => {
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2-pane:not([data-side]) .k2-sec")).map((section) => {
          const words = section.querySelector(".k2-sec-link > b")!.getBoundingClientRect();
          const text = section.querySelector(".k2-row .k2-row-l1")!.getBoundingClientRect();
          return Math.round(text.right - words.right);
        }),
      );
      expect(found).toEqual([0, 0]);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    },
    "rtl",
  );
});
