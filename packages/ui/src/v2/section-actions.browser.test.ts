import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-section-actions.client";
import { describeV2Page, measureV2Layout } from "./testing";
import { textEdge } from "./tokens";

// W2 (26.11.): on the phone a section's deeds keep only their symbol, and the rule hid their words with
// `display: none`, so a deed lost its name for assistive technology, and a deed without a symbol showed nothing at all.
// A section's deed keeps its name at every width; one without a symbol keeps its words in sight.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-section-actions.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>, which = "") => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-case="${which}"><div id="root"></div></body></html>`,
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

for (const width of [390, 1440])
  test(`a section's deeds keep their names at ${width} px; one without a symbol keeps its words`, async () => {
    await withPage(width, async (page) => {
      for (const name of ["Neuer Vorgang", "Alle ansehen", "Alle Notizen"]) {
        const deed = page.getByRole("button", { name, exact: true });
        expect(await deed.isVisible()).toBe(true);
      }
      const shown = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".k2-sh .k2-btn")).map((button) => {
          const words = button.querySelector(".k2-btn-label")!.getBoundingClientRect();
          // what a finger hits: the deed with what it reaches beyond its box
          const hit = button.getBoundingClientRect();
          const reach = getComputedStyle(button, "::after");
          const target =
            reach.content === "none" ? hit : { width: Number.parseFloat(reach.width), height: Number.parseFloat(reach.height) };
          return {
            name: button.textContent?.trim(),
            words: words.width > 1 && words.height > 1,
            target: Math.min(Math.round(Math.max(hit.width, target.width)), Math.round(Math.max(hit.height, target.height))),
          };
        }),
      );
      // on the phone the deed with a symbol before its words shows only the symbol, and a finger hits 44 px of it; a
      // deed without a symbol, and one whose sign follows its words (it leads on), keep their words
      expect(shown.map(({ name, words }) => ({ name, words }))).toEqual([
        { name: "Neuer Vorgang", words: width >= 768 },
        { name: "Alle ansehen", words: true },
        { name: "Alle Notizen", words: true },
      ]);
      if (width < 768) expect(shown[0]!.target).toBeGreaterThanOrEqual(44);
      // words kept as a name are no cut label
      expect(await describeV2Page(page, "#root")).not.toContain("Problems (");
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });

// S2 (Core admin): tabs in a detail's status slot stood on the edge of the pane instead of the text edge, unlike the
// same tabs as the head of a pane.
for (const width of [390, 1440])
  test(`tabs in a detail's status slot start on the text edge at ${width} px`, async () => {
    await withPage(
      width,
      async (page) => {
        const inset = await page.evaluate(() => {
          const tab = document.querySelector("[data-slot='status'] .k2-tab")!.getBoundingClientRect();
          const pane = document.querySelector(".k2-pane[data-detail]")!.getBoundingClientRect();
          return Math.round(tab.left - pane.left);
        });
        expect(inset).toBe(width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide);
        expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
      },
      "status-tabs",
    );
  });

// Review of #4287: words clipped on purpose are no finding, but a label a person sees cut still is one.
test("a section deed whose words have no room at 390 px is still reported as cut", async () => {
  await withPage(
    390,
    async (page) => {
      // the deed is held narrower than its words, as a box that gives it too little room would
      await page.addStyleTag({ content: ".k2-sh .k2-btn { max-width: 80px; }" });
      await settled(page);
      expect(await describeV2Page(page, "#root")).toContain("cuts its label");
    },
    "cut",
  );
});

// Review of #4287: a deed without a symbol keeps its words on the phone, so a long one did not fit beside the title and
// ran past the screen, and no rule said so. On the phone the deeds go under the title when they do not fit (by layout,
// nothing measured); at 1440 they stay beside it. A deed that runs past its row is a finding.
for (const width of [390, 1440])
  test(`a long deed without a symbol stays inside its section at ${width} px`, async () => {
    await withPage(
      width,
      async (page) => {
        const found = await page.evaluate(() => {
          const head = document.querySelector(".k2-sh")!.getBoundingClientRect();
          const title = document.querySelector(".k2-sh > h3")!.getBoundingClientRect();
          const deed = document.querySelector(".k2-sh .k2-btn")!.getBoundingClientRect();
          return { inside: deed.right <= head.right + 0.5 && deed.left >= head.left - 0.5, under: deed.top >= title.bottom - 0.5 };
        });
        expect(found).toEqual({ inside: true, under: width < 768 });
        expect(await describeV2Page(page, "#root")).not.toContain("Problems (");
        expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
      },
      "long",
    );
  });

test("a deed that runs past its row is a finding", async () => {
  await withPage(
    390,
    async (page) => {
      // a deed wider than its row, forced: the head no longer lets one run past (its deeds go under the title, and since
      // #4216 the title gives way too), but the check must still find one that does
      await page.addStyleTag({ content: ".k2-ui .k2-sh .k2-btn { min-width: 600px !important; }" });
      await settled(page);
      expect(await describeV2Page(page, "#root")).toMatch(/runs \d+ px past its row/);
    },
    "long",
  );
});
