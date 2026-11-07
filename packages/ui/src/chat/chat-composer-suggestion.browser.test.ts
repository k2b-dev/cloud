import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// A suggested next message stands in the empty assistant prompt, wraps like text and grows the field. Whether the
// conversation above keeps its distance to the composer, whether accepting or the first typed character changes the
// field's height, and which keys reach it are results of layout and focus in a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");
const TEST_TIMEOUT = 30_000;
// Set K2B_UI_SHOTS to a directory to keep a screenshot of every state at 1440 and 390 px for review.
const shots = process.env.K2B_UI_SHOTS;
const SUGGESTION = "Ja, entwirf die Antwort an Jana und häng das Angebot an";
const LONG =
  "Ja, entwirf die Antwort an Jana, häng das Angebot vom 02.11. an und schlag ihr für den Aufbau Samstag, den 14.11., ab 8 Uhr vor, mit Beleuchtung als Position 4";

const entry = resolve(import.meta.dir, "chat-composer-suggestion.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [value, setValue] = createSignal("");
const [suggestion, setSuggestion] = createSignal(undefined);
const [running, setRunning] = createSignal(false);
window.calls = { accept: 0, dismiss: 0, sent: [] };
window.fx = { setValue, setSuggestion, setRunning, value };
const conversation = document.createElement("div");
conversation.className = "conv";
conversation.innerHTML = '<p class="you">Kannst du mir sagen, was Jana zum Angebot für den Messestand gefragt hat?</p>' +
  '<p class="ai">Jana Berger fragt zwei Dinge: ob der Aufbau am Sonntag, 15.11., möglich ist und ob die Beleuchtung im Preis enthalten ist. Beides steht im Angebot vom 02.11.: Aufbau ab Samstag, Beleuchtung als Position 4.</p>' +
  '<p class="ai" id="last">Soll ich ihr eine kurze Antwort entwerfen und das Angebot anhängen?</p>';
const before = document.createElement("button");
before.id = "before";
before.textContent = "Vorher";
const dock = document.createElement("div");
dock.className = "dock";
const after = document.createElement("button");
after.id = "after";
after.textContent = "Danach";
document.getElementById("app").append(before, conversation, dock, after);
render(() => createComponent(LocaleProvider, {
  locale: "de",
  get children() {
    return createComponent(Chat.Composer, {
      get value() { return value(); },
      onValueChange: setValue,
      onSubmit: ({ text }) => { window.calls.sent.push(text); },
      get state() { return running() ? "running" : "idle"; },
      runningSubmitIntent: "queue",
      onStop: () => {},
      get placeholder() { return running() ? "Weitere Nachricht vormerken" : "Assistent etwas fragen"; },
      menuActions: [{ id: "files", label: "Dateien", icon: "ti ti-paperclip", onSelect: () => {} }],
      models: [{ id: "orion", label: "Orion 2" }],
      selectedModelId: "orion",
      onModelChange: () => {},
      get suggestion() {
        const text = suggestion();
        return text ? { text, onAccept: () => window.calls.accept++, onDismiss: () => window.calls.dismiss++ } : undefined;
      },
    });
  },
}), dock);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the composer suggestion fixture.");
const script = await build.outputs[0]!.text();

declare const fx: { setValue: (value: string) => void; setSuggestion: (text: string | undefined) => void; setRunning: (on: boolean) => void };
declare const calls: { accept: number; dismiss: number; sent: string[] };

const FIELD = ".k2b-chat-composer textarea:not(.k2b-chat-composer__measure)";
const touch: BrowserContextOptions = { hasTouch: true, isMobile: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, context: BrowserContextOptions = {}): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 760 }, ...context })).newPage();
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <style>${css}</style><style>${fonts}</style>
    <style>*,*::before,*::after{transition:none!important;animation:none!important}
    html,body{margin:0;height:100%}
    #app{display:flex;flex-direction:column;height:100%;max-width:760px;margin:0 auto;box-sizing:border-box;padding:0 12px 12px}
    #before,#after{position:fixed;top:4px;height:24px}
    #before{left:4px}#after{right:4px}
    .conv{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;padding:40px 4px 16px;font:15px/1.6 'IBM Plex Sans',sans-serif}
    .conv p{margin:0}.conv .you{align-self:flex-end;max-width:80%;padding:8px 12px;border-radius:14px;background:var(--k2b-surface-muted)}</style></head>
    <body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`);
  await page.evaluate(async () => {
    await Promise.all(["400 14px 'IBM Plex Sans'", "500 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
  });
  await page.addScriptTag({ content: script });
  await page.locator(FIELD).waitFor();
  await page.mouse.move(2, 2);
  await settled(page);
  return page;
};

/** The field's height and where the conversation ends against the composer. */
const layout = (page: Page) =>
  page.evaluate((field) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(field)!;
    const composer = document.querySelector(".k2b-chat-composer")!.getBoundingClientRect();
    const last = document.getElementById("last")!.getBoundingClientRect();
    const overlay = document.querySelector(".k2b-chat-composer__suggestion");
    return {
      field: Math.round(textarea.getBoundingClientRect().height * 100) / 100,
      gap: Math.round((composer.top - last.bottom) * 100) / 100,
      bottom: Math.round(composer.bottom * 100) / 100,
      overlay: overlay ? Math.round(overlay.getBoundingClientRect().height * 100) / 100 : null,
      value: textarea.value,
      placeholder: textarea.placeholder,
      focused: document.activeElement === textarea,
      describedBy: textarea.getAttribute("aria-describedby"),
    };
  }, FIELD);

const suggest = async (page: Page, text: string | undefined) => {
  await page.evaluate((next) => fx.setSuggestion(next), text);
  await settled(page);
};

describe("Chat.Composer suggestion", () => {
  for (const [width, context] of [
    [1440, {}],
    [390, touch],
  ] as const) {
    test(`appearing and disappearing keep the conversation at the composer at ${width} px`, async () => {
      const page = await open(width, context);
      try {
        const empty = await layout(page);
        expect(empty.overlay).toBeNull();
        for (const text of [SUGGESTION, LONG]) {
          await suggest(page, text);
          const shown = await layout(page);
          // The whole suggestion grows the field like text; the conversation moves up with the composer's top.
          expect(shown.field).toBe(shown.overlay!);
          // The short one fits one line on a desktop; the long one wraps.
          if (text === LONG || width === 390) expect(shown.field).toBeGreaterThan(empty.field);
          expect(shown.gap).toBe(empty.gap);
          expect(shown.bottom).toBe(empty.bottom);
          expect(shown.placeholder).toBe("");
          await suggest(page, undefined);
          expect(await layout(page)).toEqual(empty);
        }
        // A phone wraps the long suggestion onto three lines or more; it is read in full, never cut.
        if (width === 390) {
          await suggest(page, LONG);
          const lines = await page.evaluate(() => {
            const overlay = document.querySelector<HTMLElement>(".k2b-chat-composer__suggestion")!;
            return overlay.scrollHeight <= overlay.clientHeight && overlay.getBoundingClientRect().height;
          });
          expect(lines).toBeGreaterThan(3 * 21);
        }
      } finally {
        await page.context().close();
      }
    }, TEST_TIMEOUT);
  }

  test("Tab accepts as an undoable edit without changing the height; Escape dismisses", async () => {
    const page = await open(1440);
    try {
      const empty = await layout(page);
      await suggest(page, LONG);
      await page.locator(FIELD).focus();
      const shown = await layout(page);
      expect(shown.overlay).not.toBeNull();
      await page.keyboard.press("Tab");
      await settled(page);
      const accepted = await layout(page);
      expect(accepted.value).toBe(LONG);
      expect(accepted.focused).toBe(true);
      expect(accepted.field).toBe(shown.field);
      expect(accepted.gap).toBe(shown.gap);
      expect(await page.evaluate(() => calls)).toEqual({ accept: 1, dismiss: 0, sent: [] });
      expect(await page.locator(FIELD).evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(LONG.length);
      // The edit is the field's own: undo takes it back in one step, and the suggestion stands again.
      await page.keyboard.press("Control+z");
      await settled(page);
      const undone = await layout(page);
      expect(undone.value).toBe("");
      expect(undone.overlay).not.toBeNull();
      expect(undone.field).toBe(shown.field);
      // Escape sets it aside: the placeholder is back and the field returns to one line.
      await page.keyboard.press("Escape");
      await settled(page);
      const dismissed = await layout(page);
      expect(dismissed.overlay).toBeNull();
      expect(dismissed.placeholder).toBe("Assistent etwas fragen");
      expect(dismissed.field).toBe(empty.field);
      expect(dismissed.gap).toBe(empty.gap);
      expect(dismissed.describedBy).toBeNull();
      expect(await page.evaluate(() => calls.dismiss)).toBe(1);
      // A new suggestion shows again.
      await suggest(page, SUGGESTION);
      expect((await layout(page)).overlay).not.toBeNull();
    } finally {
      await page.context().close();
    }
  }, TEST_TIMEOUT);

  test("typing replaces the suggestion and keeps its height until the field is empty or sent", async () => {
    const page = await open(1440);
    try {
      const empty = await layout(page);
      await suggest(page, LONG);
      await page.locator(FIELD).focus();
      const shown = await layout(page);
      await page.keyboard.type("K");
      await settled(page);
      const typed = await layout(page);
      expect(typed.overlay).toBeNull();
      expect(typed.field).toBe(shown.field);
      expect(typed.gap).toBe(shown.gap);
      await page.keyboard.type("annst du vorher noch");
      await settled(page);
      expect((await layout(page)).field).toBe(shown.field);
      // An empty field shows it again.
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace");
      await settled(page);
      const cleared = await layout(page);
      expect(cleared.overlay).not.toBeNull();
      expect(cleared.field).toBe(shown.field);
      // Sending sets it aside: the field returns to one line with the placeholder.
      await page.keyboard.type("Kannst du vorher noch");
      await page.keyboard.press("Enter");
      await settled(page);
      const sent = await layout(page);
      expect(await page.evaluate(() => calls.sent)).toEqual(["Kannst du vorher noch"]);
      expect(sent.value).toBe("");
      expect(sent.overlay).toBeNull();
      expect(sent.field).toBe(empty.field);
      expect(sent.gap).toBe(empty.gap);
    } finally {
      await page.context().close();
    }
  }, TEST_TIMEOUT);

  test("Tab moves the focus as before without a suggestion, with a modifier, and during an input method", async () => {
    const page = await open(1440);
    try {
      const field = page.locator(FIELD);
      // Without a suggestion, Tab leaves the empty field as it always did.
      await field.focus();
      await page.keyboard.press("Tab");
      expect(await field.evaluate((node) => document.activeElement === node)).toBe(false);
      await suggest(page, SUGGESTION);
      await field.focus();
      await page.keyboard.press("Shift+Tab");
      expect(await field.evaluate((node) => document.activeElement === node)).toBe(false);
      expect(await field.inputValue()).toBe("");
      // A key that confirms an input method's composition is not Tab for the suggestion.
      await field.focus();
      const prevented = await field.evaluate((node) => {
        const key = new KeyboardEvent("keydown", { key: "Tab", isComposing: true, bubbles: true, cancelable: true });
        node.dispatchEvent(key);
        return key.defaultPrevented;
      });
      expect(prevented).toBe(false);
      for (const modifier of ["Control", "Alt", "Meta"]) {
        const ignored = await field.evaluate((node, mod) => {
          const key = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: mod === "Control", altKey: mod === "Alt", metaKey: mod === "Meta", bubbles: true, cancelable: true });
          node.dispatchEvent(key);
          return !key.defaultPrevented;
        }, modifier);
        expect(ignored).toBe(true);
      }
      expect(await field.inputValue()).toBe("");
      expect(await page.evaluate(() => calls.accept)).toBe(0);
      // Once accepted, the next Tab moves on.
      await page.keyboard.press("Tab");
      expect(await field.inputValue()).toBe(SUGGESTION);
      await page.keyboard.press("Tab");
      expect(await field.evaluate((node) => document.activeElement === node)).toBe(false);
    } finally {
      await page.context().close();
    }
  }, TEST_TIMEOUT);

  test("a click on the hint accepts; screen readers hear it once and the field describes it", async () => {
    const page = await open(1440);
    try {
      await suggest(page, SUGGESTION);
      const field = page.locator(FIELD);
      await field.focus();
      await settled(page);
      const spoken = `Vorgeschlagene Nachricht: ${SUGGESTION}. Tab übernimmt, Escape verwirft.`;
      expect(await page.locator('.k2b-sr-only[role="status"]').first().textContent()).toBe(spoken);
      const describedBy = await field.getAttribute("aria-describedby");
      expect(await page.locator(`[id="${describedBy}"]`).textContent()).toBe(spoken);
      // The keyboard hint is no control of its own; the touch button is hidden with a keyboard.
      expect(await page.locator(".k2b-chat-composer__suggestion-key").getAttribute("aria-hidden")).toBe("true");
      expect(await page.locator(".k2b-chat-composer__suggestion-accept").isVisible()).toBe(false);
      const before = await layout(page);
      await page.locator(".k2b-chat-composer__suggestion-key").click();
      await settled(page);
      const after = await layout(page);
      expect(after.value).toBe(SUGGESTION);
      expect(after.focused).toBe(true);
      expect(after.field).toBe(before.field);
    } finally {
      await page.context().close();
    }
  }, TEST_TIMEOUT);

  test("on a touch-only phone the hint is an Accept button with a 44 px touch area", async () => {
    const page = await open(390, touch);
    try {
      await suggest(page, SUGGESTION);
      expect(await page.locator(".k2b-chat-composer__suggestion-key").isVisible()).toBe(false);
      const button = page.getByRole("button", { name: `Vorschlag übernehmen: ${SUGGESTION}` });
      expect(await button.isVisible()).toBe(true);
      const target = await button.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const hit = (y: number) => document.elementFromPoint(x, y)?.closest("button") === node;
        // 28 px high, and the touch area reaches 8 px above and below it: 44 px.
        return { height: box.height, above: hit(box.top - 7.5), below: hit(box.bottom + 7.5), outside: hit(box.bottom + 8.5) };
      });
      expect(target).toEqual({ height: 28, above: true, below: true, outside: false });
      const before = await layout(page);
      await button.tap();
      await settled(page);
      const after = await layout(page);
      expect(after.value).toBe(SUGGESTION);
      expect(after.field).toBe(before.field);
      expect(after.gap).toBe(before.gap);
    } finally {
      await page.context().close();
    }
  }, TEST_TIMEOUT);

  test.if(Boolean(shots))("screenshots of the six states", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const [width, context] of [
      [1440, {}],
      [390, touch],
    ] as const) {
      const page = await open(width, context);
      try {
        const field = page.locator(FIELD);
        const shot = async (name: string) => {
          await settled(page);
          // The desktop picture keeps the lower part, where the conversation meets the composer.
          const clip = width === 1440 ? { x: 0, y: 900 - 360, width, height: 360 } : undefined;
          await page.screenshot({ path: resolve(shots!, `suggestion-${width}-${name}.png`), clip });
        };
        await shot("1-none");
        await page.evaluate(() => fx.setRunning(true));
        await shot("2-running");
        await page.evaluate(() => fx.setRunning(false));
        await suggest(page, SUGGESTION);
        await page.locator("#before").focus();
        await shot("3-shown");
        await field.focus();
        await page.keyboard.type("Kannst du vorher noch");
        await shot("4-typing");
        await page.evaluate(() => fx.setValue(""));
        await settled(page);
        if (width === 390) await page.locator(".k2b-chat-composer__suggestion-accept").tap();
        else await page.keyboard.press("Tab");
        await shot("5-accepted");
        await page.evaluate(() => fx.setValue(""));
        await settled(page);
        await field.focus();
        await page.keyboard.press("Escape");
        await shot("6-dismissed");
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);
});
