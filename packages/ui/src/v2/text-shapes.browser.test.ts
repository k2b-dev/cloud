import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-text-shapes.client";
import { measureV2Layout } from "./testing";
import { heights } from "./tokens";

// Texts of free length keep their words whole (test/v2-text-shapes.client.tsx, gaps of the FAQ lane in #4172): a long
// section title wraps and its head grows, a check carries a line under its words, a multi-line field grows with them.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-text-shapes.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** `fallback`: the browser sizes no text field to its words (`field-sizing` off, as in Firefox), so the field does. */
type PageOptions = { fallback?: boolean; height?: number };

const withPage = async (width: number, run: (page: Page) => Promise<void>, options: PageOptions = {}) => {
  const page = await browser.newPage({ viewport: { width, height: options.height ?? 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style>${options.fallback ? "<style>.k2-ui textarea { field-sizing: fixed !important; }</style>" : ""}</head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    // without field-sizing the page asks the browser and hears no, before the client starts
    if (options.fallback)
      await page.evaluate(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((...query: [string, string?]) =>
          query[0] === "field-sizing"
            ? false
            : query.length === 2
              ? supports(query[0], query[1]!)
              : supports(query[0])) as typeof CSS.supports;
      });
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
  test(`at ${width}: a long section title wraps whole and its head grows; a short one keeps one line`, async () => {
    await withPage(width, async (page) => {
      const heads = await page.evaluate(() =>
        [...document.querySelectorAll(".k2-sh")].map((head) => {
          const title = head.querySelector("h3")!;
          const box = title.getBoundingClientRect();
          return {
            height: Math.round(head.getBoundingClientRect().height),
            whole: title.scrollWidth <= title.clientWidth + 0.5 && getComputedStyle(title).textOverflow !== "ellipsis",
            lines: Math.round(box.height / 20),
            inside: box.right <= head.getBoundingClientRect().right,
          };
        }),
      );
      // A in a narrow pane keeps its 52 px; B (a pane of 960 px and more) is its title column, one line of 22 px
      expect(heads[0]).toEqual({ height: width < 768 ? heights.status : 22, whole: true, lines: 1, inside: true });
      expect(heads[1]!.whole).toBe(true);
      expect(heads[1]!.inside).toBe(true);
      if (width < 768) {
        expect(heads[1]!.lines).toBeGreaterThan(1);
        expect(heads[1]!.height).toBeGreaterThan(heights.status);
      }
      // still the section's heading, named by its words
      expect(await page.getByRole("heading", { level: 3, name: /^Wie lange dauert es/ }).count()).toBe(1);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });

test("a check's description stands under its words and describes the box", async () => {
  await withPage(1440, async (page) => {
    // named by its words only: the description describes it, it is no part of its name
    const box = page.getByRole("checkbox", { name: "Öffentlich zeigen", exact: true });
    expect(await box.count()).toBe(1);
    const described = await box.evaluate((input) =>
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" | "),
    );
    expect(described).toBe("Wer die Seite kennt, sieht diese Frage ohne Anmeldung.");
    // the words and the line under them start on one edge, the line below the words
    const shape = await page.evaluate(() => {
      const text = document.querySelector('[data-k2-part="Check"] .k2-choice-text')!.getBoundingClientRect();
      const line = document.querySelector('[data-k2-part="Check"] .k2-choice-description')!.getBoundingClientRect();
      return { left: Math.round(line.left - text.left), below: Math.round(line.top - text.top) };
    });
    expect(shape.left).toBe(0);
    expect(shape.below).toBe(20);
  });
});

for (const width of [1440, 390])
  test(`at ${width}: a multi-line field shows its rows and grows line by line with its words up to ten, then scrolls`, async () => {
    await withPage(width, async (page) => {
      const height = (name: string) =>
        page.getByRole("textbox", { name }).evaluate((area) => Math.round(area.parentElement!.getBoundingClientRect().height));
      // 3 rows by default (80 px, as before), 5 rows asked for
      expect(await height("Antwort")).toBe(80);
      expect(await height("Notiz")).toBe(5 * 20 + 20);
      const answer = page.getByRole("textbox", { name: "Antwort" });
      await answer.click();
      await answer.press("End");
      const grown: number[] = [];
      for (let line = 2; line <= 12; line++) {
        await answer.press("Enter");
        await answer.pressSequentially(`Zeile ${line}`);
        // settled: read at once, since the subject is that the field has its new height in the frame of the key
        grown.push(await height("Antwort"));
      }
      expect(grown).toEqual([80, 80, 100, 120, 140, 160, 180, 200, 220, 220, 220]);
      // past ten lines the field scrolls inside
      expect(await answer.evaluate((area) => area.scrollHeight > area.clientHeight)).toBe(true);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });

// Without field-sizing the field measures its words from its least height; the panes above it must not move for that.
// A long field at the end of a pane scrolled to its end, the caret in its first line: typing and a value set by code
// leave every scroll where it was.
test("without field-sizing, a long field at the end of a pane keeps the pane where it is as you type and as code sets it", async () => {
  await withPage(
    1440,
    async (page) => {
      const field = page.getByRole("textbox", { name: "Ausführliche Erklärung" });
      expect(await field.evaluate((area) => Math.round(area.getBoundingClientRect().height))).toBe(9 * 20);
      const pane = () => field.evaluate((area) => area.closest(".k2-scroll")!.scrollTop);
      await field.evaluate((area) => {
        const scroll = area.closest(".k2-scroll")!;
        scroll.scrollTop = scroll.scrollHeight;
      });
      await settled(page);
      const end = await pane();
      expect(end).toBeGreaterThan(0);
      await field.evaluate((area) => {
        (area as HTMLTextAreaElement).focus({ preventScroll: true });
        (area as HTMLTextAreaElement).setSelectionRange(0, 0);
      });
      for (const key of ["N", "e", "u"]) {
        await page.keyboard.press(key);
        expect(await pane()).toBe(end);
      }
      await page.evaluate(() => window.__k2SetAnswer!(Array.from({ length: 9 }, (_, line) => `Zeile ${line + 1}, neu geladen`).join("\n")));
      await settled(page);
      expect(await pane()).toBe(end);
      expect(await field.evaluate((area) => Math.round(area.getBoundingClientRect().height))).toBe(9 * 20);
    },
    { fallback: true, height: 600 },
  );
});
