import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-form-controls.demo";
import { measureV2Layout } from "./testing";

// The form controls of v2 beyond text in a real engine, with v2.css: a field's reset deed in its label line, a locked
// select, tags, an image, a code, a disclosure and a folded group, each through the behaviour layer on the ui-sdk core.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-form-controls"), serverMarkup("../v2-form-controls"), launchBrowser()]);
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
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
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
const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);
const field = (page: Page, label: string) => page.locator(".k2-field", { has: page.locator(".k2-field-label", { hasText: label }) });

test("server markup: the code is one named input under drawn boxes, the folded group's content is not sent", () => {
  expect(markup).toContain('autocomplete="one-time-code"');
  expect(markup).toContain('maxlength="6"');
  expect(markup.match(/class="k2-code-box"/g)?.length).toBe(6);
  expect(markup).toContain('data-k2-part="TagsInput"');
  expect(markup).toContain(">werkstatt.example<");
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain("Drei Pakete");
  // the closed answer stays in the page for find in page
  expect(markup).toContain("Sie gelten bis zu ihrem Ende weiter.");
  expect(markup).toContain('hidden="until-found"');
});

test("field action: in the 20 px label line, the field keeps its height, a press runs it", async () => {
  await withPage(async (page) => {
    const session = field(page, "Sitzungsdauer");
    const plain = field(page, "Tarif");
    const [withAction, without] = [await session.boundingBox(), await plain.boundingBox()];
    expect(withAction?.height).toBe(without?.height);
    const action = page.getByRole("button", { name: "Auf Standard zurücksetzen" });
    const [label, button] = [await session.locator(".k2-field-label").boundingBox(), await action.boundingBox()];
    expect(button?.height).toBe(20);
    expect(Math.round((button?.y ?? 0) - (label?.y ?? 0))).toBe(0);
    await action.focus();
    await page.keyboard.press("Enter");
    expect(await deeds(page)).toEqual(["reset"]);
    expect(await session.locator(".k2-input-value").textContent()).toBe("24 Stunden");
  });
});

test("select: a locked select takes no focus and opens nothing; a dimmed option is skipped", async () => {
  await withPage(async (page) => {
    const locked = field(page, "Verfahren").locator("[data-select]");
    expect(await locked.isDisabled()).toBe(true);
    await locked.click({ force: true });
    expect(await page.locator('[data-slot="select-content"]:visible').count()).toBe(0);
    const plan = field(page, "Tarif").locator("[data-select]");
    await plan.focus();
    await page.keyboard.press("ArrowDown");
    await page.locator('[data-slot="select-content"]').waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await deeds(page)).toEqual(["plan:pro"]);
  });
});

test("tags: Enter adds the typed text as a chip, Backspace in the empty field takes it back, a chip's x removes it", async () => {
  await withPage(async (page) => {
    const input = field(page, "Erlaubte Domains").locator("input:not([type=hidden])").first();
    await input.click();
    await page.keyboard.type("k2b.example");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("[data-tags] > .k2-chip").length === 2);
    expect(await deeds(page)).toEqual(["tags:werkstatt.example,k2b.example"]);
    expect(await input.inputValue()).toBe("");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll("[data-tags] > .k2-chip").length === 1);
    await page.getByRole("button", { name: "werkstatt.example entfernen" }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-tags] > .k2-chip").length === 0);
    expect((await deeds(page)).at(-1)).toBe("tags:");
  });
});

test("image: a picked file becomes the value through transform, the preview shows it, remove clears it", async () => {
  await withPage(async (page) => {
    const logo = field(page, "Logo");
    expect(await logo.getAttribute("role")).toBe("group");
    await logo.locator('input[type="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("logo") });
    await logo.locator(".k2-image-preview > img").waitFor();
    expect(await deeds(page)).toEqual(["image:set"]);
    expect(await logo.getByRole("button", { name: "Bild ändern" }).count()).toBe(1);
    await logo.getByRole("button", { name: "Bild entfernen" }).click();
    await logo.locator(".k2-image-preview > img").waitFor({ state: "detached" });
    expect(await deeds(page)).toEqual(["image:set", "image:none"]);
    // a file that `accept` rules out says so at the field
    await logo.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await logo.getByRole("alert").waitFor();
  });
});

test("code: typing fills the boxes, the last box completes it, the input is the one named control", async () => {
  await withPage(async (page) => {
    const code = page.getByRole("textbox", { name: "Code vom anderen Gerät" });
    await code.focus();
    await page.keyboard.type("12a3456");
    await page.waitForFunction(() => (window.__deeds ?? []).some((deed) => deed.startsWith("code:")));
    expect(await deeds(page)).toEqual(["code:123456"]);
    expect(await page.locator(".k2-code-box").allTextContents()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});

test("slider: named by its field, arrows step it, the end of a key press commits, the number reads at the end", async () => {
  await withPage(async (page) => {
    const slider = page.getByRole("slider", { name: "Abdunkeln" });
    expect(await slider.inputValue()).toBe("30");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await page.waitForFunction(() => (window.__deeds ?? []).includes("dim:100"));
    expect(await page.locator(".k2-slider-value").textContent()).toBe("100");
    const [control, thumb] = [
      await field(page, "Abdunkeln").locator(".k2-slider").boundingBox(),
      await page.locator(".k2-slider-thumb").boundingBox(),
    ];
    expect(control?.height).toBe(36);
    expect(thumb?.width).toBe(16);
  });
});

test("colour: a swatch press sets it, a typed CSS colour becomes its code, the hue thumb is named and steps", async () => {
  await withPage(async (page) => {
    const code = page.getByRole("textbox", { name: "Farbcode" });
    expect(await code.inputValue()).toBe("#b45309");
    await page.getByRole("option", { name: "Farbe #1d4ed8" }).click();
    expect(await code.inputValue()).toBe("#1d4ed8");
    await code.fill("rgb(15, 118, 110)");
    await code.press("Enter");
    await page.waitForFunction(() => (window.__deeds ?? []).includes("accent:#0f766e"));
    expect(await page.getByRole("option", { name: "Farbe #0f766e" }).getAttribute("aria-selected")).toBe("true");
    const hue = page.getByRole("slider", { name: "Farbton" });
    const before = await hue.getAttribute("aria-valuenow");
    await hue.focus();
    await page.keyboard.press("ArrowRight");
    expect(await hue.getAttribute("aria-valuenow")).not.toBe(before);
    expect(await page.getByRole("slider", { name: "Sättigung und Helligkeit" }).count()).toBe(1);
  });
});

test("disclosure and folded group open and close in place and say so", async () => {
  await withPage(async (page) => {
    const question = page.getByRole("button", { name: "Was passiert mit laufenden Sitzungen?" });
    expect(await question.getAttribute("aria-expanded")).toBe("false");
    await question.click();
    expect(await question.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByText("Sie gelten bis zu ihrem Ende weiter.").isVisible()).toBe(true);
    const fold = page.getByRole("button", { name: "Lieferung 4711" });
    expect(await fold.getAttribute("aria-expanded")).toBe("false");
    await fold.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Drei Pakete").waitFor();
    expect(await page.locator(".k2-group").getAttribute("data-folded")).toBeNull();
    await page.keyboard.press("Enter");
    await page.getByText("Drei Pakete").waitFor({ state: "hidden" });
  });
});

for (const width of [1440, 1024, 390])
  test(`layout at ${width} px: edges, lines, type roles and grips hold`, async () => {
    await withPage(async (page) => {
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    }, width);
  });
