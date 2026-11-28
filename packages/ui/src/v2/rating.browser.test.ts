import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-rating.demo";
import { measureV2Layout } from "./testing";

// Rating (test/v2-rating.demo.tsx): five stars as one radio group on the ui-sdk core. One Tab stop, the arrows move
// and choose, Space and Enter choose, Enter on the chosen star sends the form; each star named by its value in the
// page's language; required, hint and error through the Field; at least 44 px to press on the phone, in one row; the
// amber of a toggle that is on in light and dark; read-only a line of small stars with its words. Runs in Chromium
// and in WebKit (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-rating"), serverMarkup("../v2-rating"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (options: { width?: number; dark?: boolean; lang?: "de" | "en" }, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    if (options.dark) await page.emulateMedia({ colorScheme: "dark" });
    await page.setContent(
      `<!doctype html><html lang="${options.lang ?? "de"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.dark ? ' data-theme="dark"' : ""}><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const group = (page: Page, name: string) => page.getByRole("radiogroup", { name });
/** The stars of a rating: their names, which one is chosen, which one holds the Tab stop, and their fill. */
const stars = (page: Page, name: string) =>
  group(page, name).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>(".k2-star")].map((star) => {
      const radio = star.querySelector<HTMLElement>('[role="radio"]');
      return {
        name: radio?.getAttribute("aria-label"),
        checked: radio?.getAttribute("aria-checked"),
        stop: radio?.getAttribute("tabindex"),
        filled: star.hasAttribute("data-filled"),
      };
    }),
  );
const chosen = async (page: Page, name: string) =>
  (await stars(page, name)).filter((star) => star.checked === "true").map((star) => star.name);
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent);

test("server markup: a named radio group of five stars, each named by its value, one Tab stop, the given ratings as pictures", () => {
  expect(markup).toContain('role="radiogroup"');
  for (const value of [1, 2, 3, 4, 5]) expect(markup).toContain(`aria-label="${value} von 5 Sternen"`);
  expect(markup).toContain('aria-required="true"');
  expect(markup).toContain('aria-label="4 von 5 Sternen"');
  expect(markup).toContain('aria-label="4,2 von 5 Sternen"');
  expect(markup).toContain('aria-label="0 von 5 Sternen"');
});

test("keyboard: one Tab stop, Enter and the arrows choose, Space chooses, Enter on the chosen star sends the form", async () => {
  await withPage({}, async (page) => {
    const form = page.locator("#visit");
    // nothing chosen yet: the form is not sent without stars
    expect(await form.evaluate((element: HTMLFormElement) => element.checkValidity())).toBe(false);
    expect(await chosen(page, "Wie war dein Besuch?")).toEqual([]);
    // the Tab stop of a rating nobody has rated is its first star, the only star in the Tab order
    expect((await stars(page, "Wie war dein Besuch?")).map((star) => star.stop)).toEqual(["0", "-1", "-1", "-1", "-1"]);
    await group(page, "Wie war dein Besuch?").getByRole("radio", { name: "1 von 5 Sternen" }).focus();
    // Enter chooses the star in focus (and does not send the form yet)
    await page.keyboard.press("Enter");
    expect(await chosen(page, "Wie war dein Besuch?")).toEqual(["1 von 5 Sternen"]);
    expect(await page.evaluate(() => window.__sent ?? [])).toEqual([]);
    // the arrows move and choose
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    expect(await focused(page)).toBe("3 von 5 Sternen");
    expect(await chosen(page, "Wie war dein Besuch?")).toEqual(["3 von 5 Sternen"]);
    expect(await page.evaluate(() => window.__rated)).toEqual([1, 2, 3, 4, 3]);
    // the stars up to the chosen one fill; the field's hint reads the choice
    expect((await stars(page, "Wie war dein Besuch?")).map((star) => star.filled)).toEqual([true, true, true, false, false]);
    expect(await page.getByText("3 von 5", { exact: true }).count()).toBe(1);
    // a visible focus: the star in focus draws its ring
    const ring = await page.locator(".k2-star", { has: page.locator(":focus") }).evaluate((star) => getComputedStyle(star).boxShadow);
    expect(ring).not.toBe("none");
    // one Tab stop: the next Tab leaves the group for the send button
    expect((await stars(page, "Wie war dein Besuch?")).filter((star) => star.stop === "0").length).toBe(1);
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("Senden");
    // back on the chosen star, Enter sends the form with the stars under the field's name
    await page.keyboard.press("Shift+Tab");
    expect(await focused(page)).toBe("3 von 5 Sternen");
    expect(await form.evaluate((element: HTMLFormElement) => element.checkValidity())).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.__sent)).toEqual([{ stars: "3" }]);
    // Space chooses in a rating nobody has rated yet
    await group(page, "Mit Fehler").getByRole("radio", { name: "1 von 5 Sternen" }).focus();
    await page.keyboard.press("Space");
    expect(await chosen(page, "Mit Fehler")).toEqual(["1 von 5 Sternen"]);
  });
}, 30_000);

test("a press chooses a star; a rating that keeps its choice starts at its value, a locked one does not change", async () => {
  await withPage({}, async (page) => {
    await group(page, "Wie war dein Besuch?").getByRole("radio", { name: "5 von 5 Sternen" }).click();
    expect(await chosen(page, "Wie war dein Besuch?")).toEqual(["5 von 5 Sternen"]);
    expect(await chosen(page, "Wie war das Essen?")).toEqual(["3 von 5 Sternen"]);
    await group(page, "Wie war das Essen?").getByRole("radio", { name: "4 von 5 Sternen" }).click();
    expect(await chosen(page, "Wie war das Essen?")).toEqual(["4 von 5 Sternen"]);
    await group(page, "Gesperrt").getByRole("radio", { name: "5 von 5 Sternen" }).click({ force: true });
    expect(await chosen(page, "Gesperrt")).toEqual(["2 von 5 Sternen"]);
    // the error of the field marks the group and describes it
    const invalid = group(page, "Mit Fehler");
    expect(await invalid.getAttribute("aria-invalid")).toBe("true");
    const described = await invalid.getAttribute("aria-describedby");
    expect(await page.locator(`[id="${described}"]`).textContent()).toBe("Wähle mindestens einen Stern.");
  });
}, 30_000);

test("read-only: a line of small stars as one picture with its words, part of a star for an average, nothing to focus", async () => {
  await withPage({}, async (page) => {
    const average = page.getByRole("img", { name: "4,2 von 5 Sternen" });
    const fills = await average.evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>(".k2-star")].map((star) => Number(getComputedStyle(star).getPropertyValue("--rating-fill"))),
    );
    expect(fills).toEqual([1, 1, 1, 1, 0.2]);
    expect(await average.locator("button, input, [tabindex]").count()).toBe(0);
    // the part of the fifth star is a fifth of its filled sign
    const cut = await average
      .locator(".k2-star")
      .nth(4)
      .locator('[data-name="star-filled"]')
      .evaluate((icon) => getComputedStyle(icon).clipPath);
    expect(cut).toContain("80%");
    const box = await average.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(20);
    expect(await page.getByRole("img", { name: "0 von 5 Sternen" }).count()).toBe(1);
  });
}, 30_000);

for (const width of [1440, 390]) {
  test(`at ${width} px the five stars stand in one row, each at least 44 px to press, and the layout is clean`, async () => {
    await withPage({ width }, async (page) => {
      const boxes = await group(page, "Wie war dein Besuch?").evaluate((root) =>
        [...root.querySelectorAll<HTMLElement>(".k2-star")].map((star) => {
          const box = star.getBoundingClientRect();
          const hit = star.querySelector('[role="radio"]')!.getBoundingClientRect();
          return { top: box.top, width: box.width, height: box.height, hitWidth: hit.width, hitHeight: hit.height };
        }),
      );
      expect(boxes.length).toBe(5);
      expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBe(56);
        // the radio takes the whole star (inside its 1 px edge at most)
        expect(box.hitWidth).toBeGreaterThanOrEqual(box.width - 2);
        expect(box.hitHeight).toBeGreaterThanOrEqual(box.height - 2);
      }
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  }, 30_000);
}

/** The colour of the filled sign of the first chosen star and the surface, as [r, g, b]. */
const amber = (page: Page) =>
  page.evaluate(() => {
    const rgb = (value: string) =>
      value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const icon = document.querySelector('[role="radiogroup"] .k2-star[data-filled] [data-name="star-filled"]')!;
    const surface = getComputedStyle(document.body).getPropertyValue("--k2-surface").trim();
    return {
      star: rgb(getComputedStyle(icon).color),
      surface: [1, 3, 5].map((start) => Number.parseInt(surface.slice(start, start + 2), 16)),
    };
  });
const luminance = ([r, g, b]: number[]) => {
  const [lr, lg, lb] = [r!, g!, b!].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};
const contrast = (a: number[], b: number[]) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

test("a chosen star keeps 3:1 on the surface in light and dark, and the layout in the dark is clean", async () => {
  const seen: { star: number[]; surface: number[] }[] = [];
  for (const dark of [false, true])
    await withPage({ dark }, async (page) => {
      await group(page, "Wie war dein Besuch?").getByRole("radio", { name: "4 von 5 Sternen" }).click();
      seen.push(await amber(page));
      if (dark) expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  for (const { star, surface } of seen) expect(contrast(star, surface)).toBeGreaterThanOrEqual(3);
  expect(seen[0]!.star).not.toEqual(seen[1]!.star);
}, 30_000);

test("in English each star is named in English", async () => {
  await withPage({ lang: "en" }, async (page) => {
    expect((await stars(page, "Wie war dein Besuch?")).map((star) => star.name)).toEqual([
      "1 of 5 stars",
      "2 of 5 stars",
      "3 of 5 stars",
      "4 of 5 stars",
      "5 of 5 stars",
    ]);
    expect(await page.getByRole("img", { name: "4.2 of 5 stars" }).count()).toBe(1);
  });
}, 30_000);
