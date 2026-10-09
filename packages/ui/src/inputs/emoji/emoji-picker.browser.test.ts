import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../../test/browser";

// Keyboard use, focus, and whether anything moves are results of a real engine. The fixture is a conversation
// composer whose emoji button opens EmojiPicker.Popover, as an application wires it, plus an inline picker.
const ui = resolve(import.meta.dir, "../../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "emoji-picker.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat, EmojiPicker, LocaleProvider, rememberEmoji } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const options = window.fixtureOptions ?? {};
const [draft, setDraft] = createSignal("");
const [open, setOpen] = createSignal();
const [recent, setRecent] = createSignal([]);
const [tone, setTone] = createSignal(0);
window.state = { picked: [], completed: [], recent, tone };

render(
  () =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        if (options.inline) return createComponent(EmojiPicker, { onPick: (emoji) => window.state.picked.push(emoji) });
        return [
          createComponent(Chat.Composer, {
            variant: "conversation",
            get value() {
              return draft();
            },
            onValueChange: setDraft,
            onSubmit: () => undefined,
            get emoji() {
              return {
                onOpen: setOpen,
                skinTone: tone(),
                onPick: (emoji) => {
                  window.state.completed.push(emoji);
                  setRecent(rememberEmoji(recent(), emoji));
                },
              };
            },
          }),
          createComponent(EmojiPicker.Popover, {
            get anchor() {
              return open()?.anchor;
            },
            get recent() {
              return recent();
            },
            get skinTone() {
              return tone();
            },
            onSkinToneChange: setTone,
            onPick: (emoji) => {
              open()?.insert(emoji);
              window.state.picked.push(emoji);
              setRecent(rememberEmoji(recent(), emoji));
            },
            onClose: () => setOpen(undefined),
          }),
        ];
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the EmojiPicker fixture for the browser.");
const script = await build.outputs[0]!.text();

declare const state: { picked: string[]; completed: string[]; recent: () => string[]; tone: () => number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
let context: BrowserContext | undefined;
// Each test closes its pages, so a remote browser does not slow down with every test.
afterEach(async () => {
  await context?.close();
  context = undefined;
}, 30_000);

const open = async (
  options: { width?: number; locale?: "en" | "de"; inline?: boolean } = {},
  contextOptions: BrowserContextOptions = {},
): Promise<Page> => {
  context = await browser.newContext({ viewport: { width: options.width ?? 720, height: 720 }, ...contextOptions });
  const page = await context.newPage();
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="${options.locale ?? "en"}"><head><meta name="viewport" content="width=device-width">` +
      `<style>${css}</style><style>${fonts}</style>` +
      `<style>*,*::before,*::after{transition:none!important}
html, body { margin: 0; height: 100%; }
#app { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; padding: 0.5rem; box-sizing: border-box; }
</style></head><body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`,
  );
  await page.evaluate(async () => {
    await Promise.all(["400 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
  });
  await page.addScriptTag({ content: `window.fixtureOptions = ${JSON.stringify(options)};` });
  await page.addScriptTag({ content: script });
  return page;
};

const field = (page: Page) => page.locator(".k2b-chat-composer textarea").first();
const search = (page: Page) => page.getByRole("combobox", { name: "Search emoji" });
const activeEmoji = (page: Page) =>
  page.evaluate(() => {
    const id = document.activeElement?.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.textContent : null;
  });
/** The boxes of the picker's parts, which must never move. */
const parts = (page: Page) =>
  page.evaluate(() =>
    [
      ".k2b-emoji-picker",
      ".k2b-emoji-picker__header",
      ".k2b-emoji-picker__groups",
      ".k2b-emoji-picker__scroll",
      ".k2b-emoji-picker__preview",
    ].map((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    }),
  );

describe(`EmojiPicker in ${browserName}`, () => {
  test("works with the keyboard alone: search, arrows, Enter, Escape, and the focus comes back", async () => {
    const page = await open();
    await field(page).click();
    await page.keyboard.type("Great ");
    const button = page.getByRole("button", { name: "Insert emoji" });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(search(page).evaluate((input) => input === document.activeElement)).resolves.toBe(true);
    await page.locator(".k2b-emoji-picker__option").first().waitFor();

    // "Daumen" finds 👍 first, and Enter picks it into the composer, which keeps the focus.
    await page.keyboard.type("Daumen");
    expect(await activeEmoji(page)).toBe("👍");
    await page.keyboard.press("Enter");
    expect(await field(page).inputValue()).toBe("Great 👍");
    expect(await page.locator(".k2b-emoji-picker-popover").evaluate((popover) => popover.matches(":popover-open"))).toBe(false);
    expect(await field(page).evaluate((textarea) => textarea === document.activeElement)).toBe(true);

    // Arrows move through the grid; the recent emoji come first.
    await button.focus();
    await page.keyboard.press("Enter");
    await page.locator(".k2b-emoji-picker__option").first().waitFor();
    expect(await activeEmoji(page)).toBe("👍");
    await page.keyboard.press("ArrowDown");
    expect(await activeEmoji(page)).toBe("😀");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await activeEmoji(page)).toBe("😄");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    expect(await activeEmoji(page)).toBe("😄");

    // Escape closes and returns the focus to the button that opened the picker.
    await page.keyboard.press("Escape");
    expect(await page.locator(".k2b-emoji-picker-popover").evaluate((popover) => popover.matches(":popover-open"))).toBe(false);
    expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await field(page).inputValue()).toBe("Great 👍");
  }, 30_000);

  test("chooses a skin tone with the keyboard and picks emoji in it", async () => {
    const page = await open({ locale: "de" });
    await field(page).click();
    const button = page.getByRole("button", { name: "Emoji einfügen" });
    await button.focus();
    await page.keyboard.press("Enter");
    await page.locator(".k2b-emoji-picker__option").first().waitFor();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Hautfarbe");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Standard");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => state.tone())).toBe(3);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Hautfarbe");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("daumen hoch");
    await page.keyboard.press("Enter");
    expect(await field(page).inputValue()).toBe("👍🏽");
  }, 30_000);

  test("moves nothing while searching, hovering, choosing a tone, or finding nothing", async () => {
    const page = await open();
    await page.getByRole("button", { name: "Insert emoji" }).click();
    await page.locator(".k2b-emoji-picker__option").first().waitFor();
    const before = await parts(page);
    await page.locator(".k2b-emoji-picker__option").nth(20).hover();
    expect(await parts(page)).toEqual(before);
    await page.keyboard.type("heart");
    expect(await parts(page)).toEqual(before);
    await page.keyboard.type("xyzzy");
    expect(await page.getByRole("status").textContent()).toBe("No emoji found");
    expect(await parts(page)).toEqual(before);
    await page.getByRole("button", { name: "Skin tone" }).click();
    expect(await parts(page)).toEqual(before);
  }, 30_000);

  test("opens above its button, picks with a click, and a second press of the button closes it", async () => {
    const page = await open();
    const button = page.getByRole("button", { name: "Insert emoji" });
    await field(page).click();
    await button.click();
    const popover = page.locator(".k2b-emoji-picker-popover");
    await page.locator(".k2b-emoji-picker__option").first().waitFor();
    const [box, anchor] = await Promise.all([popover.boundingBox(), button.boundingBox()]);
    expect(box!.y + box!.height).toBeLessThanOrEqual(anchor!.y);
    await page.locator(".k2b-emoji-picker__option", { hasText: "😂" }).first().click();
    expect(await field(page).inputValue()).toBe("😂");
    expect(await popover.evaluate((element) => element.matches(":popover-open"))).toBe(false);

    await button.click();
    expect(await popover.evaluate((element) => element.matches(":popover-open"))).toBe(true);
    await button.click();
    await page.waitForTimeout(50);
    expect(await popover.evaluate((element) => element.matches(":popover-open"))).toBe(false);
  }, 30_000);

  test("completes :shortcodes in the composer and turns a closed :shortcode: into its emoji", async () => {
    const page = await open();
    await field(page).click();
    await page.keyboard.type("Nice :thu");
    const list = page.getByRole("listbox", { name: "Emoji suggestions" });
    await list.waitFor();
    expect(await list.getByRole("option").first().textContent()).toContain("👍");
    await page.keyboard.press("Enter");
    expect(await field(page).inputValue()).toBe("Nice 👍");
    expect(await list.count()).toBe(0);

    await page.keyboard.type(" :tada:");
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "Nice 👍 🎉");
    // Times and URLs stay text.
    await page.keyboard.type(" at 10:30: https://example.org");
    expect(await field(page).inputValue()).toBe("Nice 👍 🎉 at 10:30: https://example.org");
    expect(await page.evaluate(() => state.completed)).toEqual(["👍", "🎉"]);
  }, 30_000);

  test("fits a phone with cells for a finger", async () => {
    const page = await open({ width: 390, inline: true }, { hasTouch: true, isMobile: true });
    await page.locator(".k2b-emoji-picker__option").first().waitFor();
    const picker = await page.locator(".k2b-emoji-picker").boundingBox();
    expect(picker!.width).toBeLessThanOrEqual(390 - 16);
    const cell = await page.locator(".k2b-emoji-picker__option").first().boundingBox();
    expect(cell!.height).toBeGreaterThanOrEqual(44);
    expect(cell!.width).toBeGreaterThanOrEqual(40);
    await page.locator(".k2b-emoji-picker__option", { hasText: "😂" }).first().tap();
    expect(await page.evaluate(() => state.picked)).toEqual(["😂"]);
  }, 30_000);
});
