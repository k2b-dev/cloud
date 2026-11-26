import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-notice-primary.client";
import type { NoticeProps } from "./components";
import { describeV2Page, measureV2Layout } from "./testing";

// PS (PWA, 26.11.): a Notice's deeds were all text buttons, so "Neu laden" in the offline notice looked like any other
// deed. A Notice may name one deed `primary`, the one thing to do: framed, at the end, after the quiet text deeds. It is
// no primary of the page, so the page keeps its own one.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-notice-primary.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
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

// at most two deeds in all, by type: with a primary, one more
const twoInAll: NoticeProps = {
  tone: "warn",
  primary: { label: "Neu laden" },
  actions: [{ label: "Später" }],
  children: "Offline.",
};
// @ts-expect-error a primary and two more are three deeds
const three: NoticeProps = { tone: "warn", primary: { label: "Neu laden" }, actions: [{ label: "A" }, { label: "B" }], children: "" };
void [twoInAll, three];

for (const width of [1440, 390])
  test(`a notice's one primary deed is framed and stands after its quiet deeds at ${width} px`, async () => {
    await withPage(width, async (page) => {
      const deeds = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".k2-notice-end > .k2-btn")).map((button) => ({
          name: button.textContent?.trim(),
          variant: button.getAttribute("data-variant"),
          // a frame a person sees: a border of some width in a colour that is not transparent
          framed: (() => {
            const style = getComputedStyle(button);
            return (
              style.borderTopStyle !== "none" && style.borderTopWidth !== "0px" && !/rgba\(.*, 0\)$|transparent/.test(style.borderTopColor)
            );
          })(),
        })),
      );
      expect(deeds).toEqual([
        { name: "Später", variant: "text", framed: false },
        { name: "Neu laden", variant: null, framed: true },
      ]);
      await page.getByRole("button", { name: "Neu laden" }).click();
      expect(await page.evaluate(() => window.__k2Deeds)).toEqual(["reload"]);
      // the page keeps its own one primary; the notice's is none of the page
      const outline = await describeV2Page(page, "#root");
      expect(outline).not.toContain("Problems (");
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });

// PS (PWA review): the refresh sign stood twice, as the notice's sign and on its "Neu laden". A deed of a notice shows
// no symbol that repeats the notice's sign; a deed with a symbol of its own keeps it.
test("a notice's deed does not repeat the notice's sign", async () => {
  await withPage(1440, async (page) => {
    const signs = await page.evaluate(() => ({
      notice: document.querySelector(".k2-notice > .k2-icon")?.getAttribute("data-name"),
      deeds: Array.from(document.querySelectorAll(".k2-notice-end > .k2-btn")).map((button) => [
        button.textContent?.trim(),
        button.querySelector(".k2-icon")?.getAttribute("data-name") ?? null,
      ]),
    }));
    expect(signs).toEqual({
      notice: "refresh",
      deeds: [
        ["Später", "clock"],
        ["Neu laden", null],
      ],
    });
  });
});
