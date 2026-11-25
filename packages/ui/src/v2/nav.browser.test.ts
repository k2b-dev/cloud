import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-nav.demo";

// A folding entry of the v2 sidebar ("› Mehr" with the archive, the bin and spam, mockup mail.html): a button that
// says whether it is open and which entries it controls, opened by the pointer and by Enter or Space, its entries one
// level further in. It starts open while it holds the open entry, also in the server's markup, and remembers nothing.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-nav"), serverMarkup("../v2-nav"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
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

const fold = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const names = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll(".k2-nav [data-k2-part='Nav.Item']")].map((item) => item.textContent?.trim()));

test("server markup: a closed fold sends no entries; the fold that holds the open entry is open", () => {
  expect(markup).toMatch(/aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Mehr/);
  expect(markup).not.toContain("Papierkorb");
  expect(markup).toMatch(/aria-expanded="true"[^>]*>(?:(?!<\/button>).)*Rechnungen/);
  expect(markup).toContain("Bezahlt");
});

test("a fold opens and closes by the pointer and by Enter and Space; its entries stand one level further in", async () => {
  await withPage(async (page) => {
    const more = fold(page, "Mehr");
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await more.click();
    await page.getByRole("button", { name: "Papierkorb" }).waitFor();
    expect(await more.getAttribute("aria-expanded")).toBe("true");
    // the fold names the group it opens, and the group is named by the fold
    const group = page.getByRole("group", { name: "Mehr" });
    expect(await group.getAttribute("id")).toBe(await more.getAttribute("aria-controls"));
    expect(await names(page)).toEqual([
      "Kontakt",
      "Posteingang",
      "Gesendet",
      "Mehr",
      "Archiv",
      "Papierkorb",
      "Spam",
      "Lieferanten",
      "Rechnungen",
      "Offen",
      "Bezahlt",
    ]);
    await settled(page);
    const left = (name: string) =>
      page.evaluate((text) => {
        const item = [...document.querySelectorAll(".k2-ni")].find((each) => each.textContent?.trim() === text)!;
        return Math.round(item.querySelector(".k2-icon")!.getBoundingClientRect().left);
      }, name);
    // a fold stands where its level stands; its entries 24 px further in
    expect(await left("Mehr")).toBe(await left("Gesendet"));
    expect((await left("Archiv")) - (await left("Mehr"))).toBe(24);
    expect((await left("Gesendet")) - (await left("Kontakt"))).toBe(24);
    // the keyboard: Enter closes, Space opens, the focus stays on the fold
    await more.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Papierkorb" }).waitFor({ state: "detached" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Papierkorb" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Mehr");
  });
});

test("an entry inside a closed fold that becomes the open one shows itself", async () => {
  await withPage(async (page) => {
    expect(await fold(page, "Mehr").getAttribute("aria-expanded")).toBe("false");
    await page.evaluate(() => window.__openSpam?.());
    await page.getByRole("button", { name: "Spam" }).waitFor();
    expect(await page.getByRole("button", { name: "Spam" }).getAttribute("aria-current")).toBe("page");
    expect(await fold(page, "Mehr").getAttribute("aria-expanded")).toBe("true");
  });
});
