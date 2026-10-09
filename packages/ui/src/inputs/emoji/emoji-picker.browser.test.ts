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
window.state = { picked: [], completed: [], sent: [], recent, tone };

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
            onSubmit: ({ text }) => {
              window.state.sent.push(text);
            },
            commands: [{ name: "example", description: "An example command" }],
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

declare const state: { picked: string[]; completed: string[]; sent: string[]; recent: () => string[]; tone: () => number };
declare const keyboard: { show: (top: number, height: number) => void };

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
  options: { width?: number; locale?: "en" | "de"; inline?: boolean; keyboard?: boolean } = {},
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
  // A phone's keyboard shrinks only the visual viewport; this one stands in for it, as no desktop engine has one.
  if (options.keyboard) {
    await page.addScriptTag({
      content: `const viewport = new EventTarget();
Object.assign(viewport, { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight, scale: 1 });
Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
window.keyboard = { show(top, height) { Object.assign(viewport, { offsetTop: top, height }); viewport.dispatchEvent(new Event("resize")); } };`,
    });
  }
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
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
  }, selector);
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
    // WebKit's Enter that confirms an input method's text arrives after the composition with keyCode 229; it picks nothing.
    await search(page).evaluate((input) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true })),
    );
    expect(await field(page).inputValue()).toBe("Great ");
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

    // A key press on the button closes it as well, although no click outside dismissed it first.
    await button.focus();
    await page.keyboard.press("Enter");
    expect(await popover.evaluate((element) => element.matches(":popover-open"))).toBe(true);
    await button.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(50);
    expect(await popover.evaluate((element) => element.matches(":popover-open"))).toBe(false);
    expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
  }, 30_000);

  test("stays in the part of the page a phone's keyboard leaves visible", async () => {
    const page = await open({ keyboard: true });
    await page.getByRole("button", { name: "Insert emoji" }).click();
    await page.locator(".k2b-emoji-picker__option").first().waitFor();
    // The keyboard covers the lower half, and the page scrolled the visible part down by 200 px.
    await page.evaluate(() => keyboard.show(200, 360));
    await page.waitForTimeout(50);
    for (const selector of [".k2b-emoji-picker-popover", ".k2b-emoji-picker__header", ".k2b-emoji-picker__preview"]) {
      const [, top, , height] = await box(page, selector);
      expect(top!).toBeGreaterThanOrEqual(200);
      expect(top! + height!).toBeLessThanOrEqual(560);
    }
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

  test("sends emoticons as they are and picks a suggestion only with a plain Enter or Tab", async () => {
    const page = await open({ locale: "de" });
    await field(page).click();
    for (const text of ["lol :DD", "Haha :-D", "na gut :-P", "oh :-O"]) {
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    }
    expect(await page.evaluate(() => state.sent)).toEqual(["lol :DD", "Haha :-D", "na gut :-P", "oh :-O"]);
    expect(await page.evaluate(() => state.completed)).toEqual([]);

    const list = page.getByRole("listbox", { name: "Emoji-Vorschläge" });
    await page.keyboard.type(":thu");
    await list.waitFor();
    await page.keyboard.press("Shift+Enter");
    expect(await field(page).inputValue()).toBe(":thu\n");
    await page.keyboard.type(":thu");
    await list.waitFor();
    await page.keyboard.press("Shift+Tab");
    expect(await field(page).inputValue()).toBe(":thu\n:thu");
    expect(await field(page).evaluate((textarea) => textarea === document.activeElement)).toBe(false);
    expect(await page.evaluate(() => state.completed)).toEqual([]);
  }, 30_000);

  test("opens emoji and command suggestions without moving the composer", async () => {
    const page = await open();
    const shell = await box(page, ".k2b-chat-composer-shell");
    const composer = await box(page, ".k2b-chat-composer");
    await field(page).click();
    for (const [text, name] of [
      [":th", "Emoji suggestions"],
      ["/ex", "Commands"],
    ] as const) {
      await page.keyboard.type(text);
      const list = page.getByRole("listbox", { name });
      await list.waitFor();
      expect(await box(page, ".k2b-chat-composer-shell")).toEqual(shell);
      expect(await box(page, ".k2b-chat-composer")).toEqual(composer);
      // The list sits 0.5rem above the composer.
      const listBox = (await list.boundingBox())!;
      expect(Math.round(listBox.y + listBox.height)).toBe(composer[1]! - 8);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
    }
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
