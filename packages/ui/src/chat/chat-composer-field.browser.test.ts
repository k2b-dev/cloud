import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The conversation pill: one row while the text fits beside "Aa", emoji and microphone; once it does not, the text takes
// the pill's whole width, so its scrollbar sits at the pill's edge, and the tools stand over a row of their own below it,
// so the text never ends under them. Whether the text fits is measured at the one-row width, so the layout never flips
// back while the text stays. These are questions of a real layout engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");
const TEST_TIMEOUT = 30_000;
// Set K2B_UI_SHOTS to a directory to keep a picture of each layout at 1440 and 390 px.
const shots = process.env.K2B_UI_SHOTS;
const SHORT = "Bin gleich da";
const LONG =
  "Kannst du bis Freitag die Inventurliste für Hochregal B fertig machen und Jana Bescheid geben, wann die Zählung beginnt und wer mithilft?";
const entry = resolve(import.meta.dir, "chat-composer-field.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [value, setValue] = createSignal("");
window.fx = { setValue };
render(() => createComponent(LocaleProvider, {
  locale: "de",
  get children() {
    return createComponent(Chat.Composer, {
      variant: "conversation",
      get value() { return value(); },
      onValueChange: setValue,
      onSubmit: () => {},
      placeholder: "Nachricht an Team Logistik",
      formatting: true,
      emoji: { onOpen: () => {} },
      fileSelection: { onSelect: () => {} },
    });
  },
}), document.getElementById("app"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the composer field fixture.");
const script = await build.outputs[0]!.text();
declare const fx: { setValue: (value: string) => void };

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
    #app{display:flex;flex-direction:column;justify-content:flex-end;height:100%;max-width:760px;margin:0 auto;box-sizing:border-box;padding:0 12px 12px;container:k2b-chat / size}</style></head>
    <body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`);
  await page.evaluate(async () => {
    await Promise.all(
      ["400 14px 'IBM Plex Sans'", "400 16px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)),
    );
  });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-chat-composer__field textarea:not(.k2b-chat-composer__measure)").waitFor();
  await settled(page);
  return page;
};

const type = async (page: Page, text: string) => {
  await page.evaluate((next) => fx.setValue(next), text);
  await settled(page);
};

/** The pill, its text field and its tools, in page coordinates, and the field's line metrics. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const field = document.querySelector<HTMLElement>(".k2b-chat-composer__field")!;
    const textarea = field.querySelector<HTMLTextAreaElement>("textarea:not(.k2b-chat-composer__measure)")!;
    const tools = field.querySelector<HTMLElement>(".k2b-chat-composer__field-tools")!;
    const box = (node: Element) => {
      const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const edge = Number.parseFloat(getComputedStyle(field).borderRightWidth);
    const style = getComputedStyle(textarea);
    return {
      lines: field.dataset.lines,
      field: box(field),
      inner: { left: field.getBoundingClientRect().left + edge, right: field.getBoundingClientRect().right - edge },
      text: box(textarea),
      tools: box(tools),
      lineHeight: Number.parseFloat(style.lineHeight),
      scroll: { height: textarea.scrollHeight, client: textarea.clientHeight },
    };
  });

const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const box = (await page.locator(".k2b-chat-composer").boundingBox())!;
  await page.screenshot({
    path: resolve(shots, `${name}.png`),
    clip: { x: 0, y: box.y - 24, width: page.viewportSize()!.width, height: box.height + 36 },
  });
};

describe("Chat.Composer conversation field", () => {
  for (const [width, context] of [
    [1440, {}],
    [390, touch],
  ] as const) {
    test(
      `at ${width} px a short message keeps one row beside the tools`,
      async () => {
        const page = await open(width, context);
        try {
          const empty = await layout(page);
          await type(page, SHORT);
          const short = await layout(page);
          await shoot(page, `field-${width}-short`);
          expect(short.lines).toBe("one");
          // Same pill as before: one row, the tools beside the text, nothing grew.
          expect(short.field).toEqual(empty.field);
          expect(short.text.right).toBeLessThanOrEqual(short.tools.left + 0.5);
          expect(Math.abs(short.tools.bottom - short.text.bottom)).toBeLessThan(3);
        } finally {
          await page.context().close();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      `at ${width} px longer text takes the whole width, its scrollbar at the pill's edge, and ends above the tools`,
      async () => {
        const page = await open(width, context);
        try {
          await type(page, LONG);
          const long = await layout(page);
          await shoot(page, `field-${width}-long`);
          expect(long.lines).toBe("many");
          // The whole width for typing: the text field reaches the pill's inner right edge, where its scrollbar sits.
          expect(Math.abs(long.text.right - long.inner.right)).toBeLessThan(0.5);
          expect(Math.abs(long.text.left - long.inner.left)).toBeLessThan(0.5);
          // The tools stand at the bottom right, over a row of their own: the text ends above them.
          expect(long.tools.top).toBeGreaterThanOrEqual(long.text.bottom - 0.5);
          expect(Math.abs(long.tools.right - long.inner.right)).toBeLessThan(0.5);
          // At the cap the text scrolls in its own box, which still ends above the tools.
          await type(page, Array.from({ length: 40 }, (_, line) => `Zeile ${line + 1} ${LONG}`).join("\n"));
          const capped = await layout(page);
          await shoot(page, `field-${width}-capped`);
          expect(capped.scroll.height).toBeGreaterThan(capped.scroll.client);
          expect(capped.tools.top).toBeGreaterThanOrEqual(capped.text.bottom - 0.5);
          expect(Math.abs(capped.text.right - capped.inner.right)).toBeLessThan(0.5);
        } finally {
          await page.context().close();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      `at ${width} px the layout changes once while typing across the edge and never flips back`,
      async () => {
        const page = await open(width, context);
        try {
          const seen: (string | undefined)[] = [];
          for (let length = 1; length <= LONG.length; length += 3) {
            await page.evaluate((next) => fx.setValue(next), LONG.slice(0, length));
            seen.push((await layout(page)).lines);
          }
          await settled(page);
          const changes = seen.filter((lines, index) => index > 0 && lines !== seen[index - 1]).length;
          expect(seen[0]).toBe("one");
          expect(seen.at(-1)).toBe("many");
          expect(changes).toBe(1);
        } finally {
          await page.context().close();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      `at ${width} px around the edge, character by character, the mode follows the one-row fit and nothing moves but the top`,
      async () => {
        const page = await open(width, context);
        try {
          const place = () =>
            page.evaluate(() => {
              const composer = document.querySelector(".k2b-chat-composer")!.getBoundingClientRect();
              const tools = document.querySelector(".k2b-chat-composer__field-tools")!.getBoundingClientRect();
              return {
                lines: document.querySelector<HTMLElement>(".k2b-chat-composer__field")!.dataset.lines,
                composer: { left: composer.left, right: composer.right, bottom: composer.bottom, top: composer.top },
                tools: { left: tools.left, top: tools.top, width: tools.width, height: tools.height },
              };
            });
          // Find the first length that no longer fits one row beside the tools.
          let edge = 0;
          for (let length = 1; length <= LONG.length; length++) {
            await page.evaluate((next) => fx.setValue(next), LONG.slice(0, length));
            if ((await place()).lines === "many") {
              edge = length;
              break;
            }
          }
          expect(edge).toBeGreaterThan(1);
          await type(page, LONG.slice(0, edge - 1));
          const one = await place();
          await type(page, LONG.slice(0, edge));
          const many = await place();
          // Back and forth across the edge, one character at a time: the mode follows the one-row fit and holds.
          for (const length of [edge - 1, edge, edge - 1, edge, edge + 1, edge, edge - 1, edge - 2, edge - 1, edge]) {
            await type(page, LONG.slice(0, length));
            const first = await place();
            // A frame later, after the field and its copy measured again, nothing switched back.
            await settled(page);
            const later = await place();
            const expected = length >= edge ? "many" : "one";
            expect(first.lines, `${length} characters`).toBe(expected);
            expect(later.lines, `${length} characters, a frame later`).toBe(expected);
            // The bottom and both side edges stay; the tools stand at the same bottom right spot in both modes.
            expect(later.composer.bottom).toBe(one.composer.bottom);
            expect(later.composer.left).toBe(one.composer.left);
            expect(later.composer.right).toBe(one.composer.right);
            expect(later.tools).toEqual(one.tools);
          }
          // Only the top moves: the field grows upward when the text needs more rows.
          expect(many.composer.top).toBeLessThan(one.composer.top);
          expect(many.tools).toEqual(one.tools);
        } finally {
          await page.context().close();
        }
      },
      TEST_TIMEOUT * 2,
    );

    test(
      `at ${width} px three typed lines stand one line apart, and the field is exactly as tall as its text`,
      async () => {
        const page = await open(width, context);
        try {
          await type(page, "Erste Zeile");
          const one = await layout(page);
          await type(page, "Erste Zeile\nZweite Zeile\nDritte Zeile");
          const three = await layout(page);
          // Each further line adds exactly one line height: no gap between typed lines comes from the layout.
          expect(three.scroll.height - one.scroll.height).toBe(2 * three.lineHeight);
          // The measuring copy and the field agree: the field shows all of its text and no empty space below it.
          expect(three.scroll.height).toBe(three.scroll.client);
          // Blank lines typed on purpose are kept as they are: each one adds one line height too.
          await type(page, "Erste Zeile\n\n\nZweite Zeile");
          const blank = await layout(page);
          expect(blank.scroll.height).toBe(three.scroll.height + blank.lineHeight);
        } finally {
          await page.context().close();
        }
      },
      TEST_TIMEOUT,
    );
  }
});
