import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Quotes stand in the composer's accessory, above its reserved hint line. Where they land against the field, a reply and
// a visible hint is layout, so a real engine measures the shipped build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "composer-quotes.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat, ChatComposerQuotes } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [quotes, setQuotes] = createSignal(true);
const [reply, setReply] = createSignal(false);
const [hint, setHint] = createSignal("");
window.setState = (state) => {
  setQuotes(state.quotes);
  setReply(state.reply);
  setHint(state.hint);
};
const quote = { id: "q1", author: "Lea Muster", text: "the quarterly report is ready for review", onRemove: () => {} };
render(
  () =>
    createComponent(Chat.Composer, {
      variant: "conversation",
      value: "",
      onValueChange: () => {},
      onSubmit: () => true,
      inputLabel: "Message",
      get hint() {
        return hint() || undefined;
      },
      get reply() {
        return reply() ? { author: "Ben Schulz", text: "Thanks, I read it after lunch.", onCancel: () => {} } : undefined;
      },
      get accessory() {
        return quotes() ? createComponent(ChatComposerQuotes, { quotes: [quote] }) : undefined;
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the composer quotes fixture for the browser.");
const script = await build.outputs[0]!.text();

const html =
  "<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
  `<style>${css}</style><style>body { margin: 0; } #app { position: fixed; inset: auto 0 0; padding: 0 12px 12px; }</style>` +
  "</head><body class='k2b-ui' data-theme='light'><div id='app'></div></body></html>";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number) => {
  const page = await (await browser.newContext({ viewport: { width, height: 800 } })).newPage();
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  await settled(page);
  return page;
};
type State = { quotes: boolean; reply: boolean; hint: string };
const geometry = async (page: Page, state: State) => {
  await page.evaluate((next) => (window as unknown as { setState: (state: State) => void }).setState(next), state);
  await settled(page);
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    return {
      field: box(".k2b-chat-composer__field")!,
      quotes: box(".k2b-chat-composer__quotes"),
      reply: box(".k2b-chat-composer__reply"),
      hint: box(".k2b-chat-composer__hint-text"),
    };
  });
};

describe("ChatComposerQuotes in a conversation composer's accessory", () => {
  for (const width of [1440, 390])
    test(`stand as close above the field as a reply, over the empty hint line, and never over a visible hint (${width}px)`, async () => {
      const page = await load(width);
      try {
        const replyAlone = await geometry(page, { quotes: false, reply: true, hint: "" });
        const replyGap = replyAlone.field.top - replyAlone.reply!.bottom;
        const quotesAlone = await geometry(page, { quotes: true, reply: false, hint: "" });
        const quotesGap = quotesAlone.field.top - quotesAlone.quotes!.bottom;
        expect(Math.abs(quotesGap - replyGap)).toBeLessThanOrEqual(1);

        // With a reply as well, the quotes end as close above the reply, without covering it.
        const both = await geometry(page, { quotes: true, reply: true, hint: "" });
        const aboveReply = both.reply!.top - both.quotes!.bottom;
        expect(aboveReply).toBeGreaterThanOrEqual(0);
        expect(Math.abs(aboveReply - replyGap)).toBeLessThanOrEqual(1);

        // A visible hint keeps the quotes above it, and the field stays where it was.
        const hinted = await geometry(page, { quotes: true, reply: false, hint: "People without access see a placeholder." });
        expect(hinted.quotes!.bottom).toBeLessThanOrEqual(hinted.hint!.top);
        expect(hinted.field).toEqual(quotesAlone.field);
      } finally {
        await page.context().close();
      }
    });
});
