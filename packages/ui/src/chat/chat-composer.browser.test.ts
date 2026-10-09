import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// How far the field grows, whether it ever collapses to be measured, and whether anything moves are results of layout
// in a real engine. The composer sits under a VirtualFeed, as in a conversation, inside a size container.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "chat-composer.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat, LocaleProvider, VirtualFeed } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const options = window.fixtureOptions ?? {};
const [items, setItems] = createSignal(
  Array.from({ length: 40 }, (_, index) => ({ id: "m" + index, text: "Message " + (index + 1) + " in the conversation" })),
);
const [draft, setDraft] = createSignal("");
const [hint, setHint] = createSignal(undefined);
const [dictation, setDictation] = createSignal(null);
window.sent = [];
window.fixture = { setHint, setDictation, setDraft };

render(
  () =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        return [
          createComponent(VirtualFeed, {
            get items() {
              return items();
            },
            getKey: (item) => item.id,
            estimateSize: () => 32,
            label: "Messages",
            children: (item) => {
              const row = document.createElement("p");
              row.className = "row";
              row.textContent = item.text;
              return row;
            },
          }),
          createComponent(Chat.Composer, {
            variant: "conversation",
            get value() {
              return draft();
            },
            onValueChange: setDraft,
            onSubmit: ({ text }) => {
              window.sent.push(text);
              setItems((current) => [...current, { id: "s" + current.length, text }]);
              // A server round trip, as an application that waits for its request.
              if (options.submitDelay) return new Promise((done) => setTimeout(done, options.submitDelay));
            },
            fileSelection: { onSelect: () => {} },
            formatting: true,
            emoji: { onOpen: ({ insert }) => insert("🙂") },
            get microphone() {
              return { onDictate: () => {}, onVoiceMessage: () => {}, dictation: dictation(), onRestoreOriginal: () => {} };
            },
            get hint() {
              return hint();
            },
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
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the ChatComposer fixture for the browser.");
const script = await build.outputs[0]!.text();

type Fixture = {
  setHint: (hint: string | undefined) => void;
  setDictation: (state: string | null) => void;
  setDraft: (value: string) => void;
};
declare const fixture: Fixture;
declare const probe: { start: () => void; stop: () => { frames: number; gaps: number[]; heights: number[] } };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const height = 800;

const open = async (
  options: { width?: number; locale?: "en" | "de"; dark?: boolean; submitDelay?: number } = {},
  context: BrowserContextOptions = {},
): Promise<Page> => {
  const width = options.width ?? 720;
  const page = await (await browser.newContext({ viewport: { width, height }, ...context })).newPage();
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="${options.locale ?? "en"}"><head><meta name="viewport" content="width=device-width">` +
      `<style>${css}</style><style>${fonts}</style>` +
      `<style>*,*::before,*::after{transition:none!important}
html, body { margin: 0; height: 100%; }
#app { display: flex; flex-direction: column; height: ${height}px; container-type: size; padding: 0 0.5rem 0.5rem; box-sizing: border-box; }
.k2b-virtual-feed { flex: 1; min-height: 0; }
.row { margin: 0; padding: 6px 12px; font: 14px/20px sans-serif; }
</style></head>` +
      `<body class="k2b-ui${options.dark ? " k2b-dark" : ""}" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`,
  );
  await page.evaluate(async () => {
    await Promise.all(["400 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
  });
  await page.addScriptTag({ content: `window.fixtureOptions = ${JSON.stringify(options)};` });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-virtual-feed__item").first().waitFor();
  // Measures after the feed's own resize handling: a ResizeObserver created after the feed's, woken every frame.
  await page.evaluate(() => {
    const composer = () => document.querySelector(".k2b-chat-composer")!;
    const gap = () => {
      const rows = [...document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item")];
      const last = rows.reduce((a, b) => (Number(b.dataset.index) > Number(a.dataset.index) ? b : a));
      return composer().getBoundingClientRect().top - last.getBoundingClientRect().bottom;
    };
    const ping = document.createElement("div");
    ping.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none";
    document.body.append(ping);
    let record: { frames: number; gaps: number[]; heights: number[] } | null = null;
    let frame = 0;
    new ResizeObserver(() => {
      if (!record) return;
      record.frames++;
      record.gaps.push(gap());
      record.heights.push(document.querySelector("textarea")!.getBoundingClientRect().height);
    }).observe(ping);
    const loop = () => {
      ping.style.height = ping.style.height === "2px" ? "1px" : "2px";
      frame = requestAnimationFrame(loop);
    };
    (window as unknown as { probe: object }).probe = {
      start() {
        record = { frames: 0, gaps: [], heights: [] };
        loop();
      },
      stop() {
        cancelAnimationFrame(frame);
        const result = record!;
        record = null;
        return result;
      },
    };
  });
  await frames(page, 4);
  return page;
};

const frames = (page: Page, count: number) =>
  page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let seen = 0;
        const tick = () => (++seen >= count ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );

/** The composer's box and the left edge of every footer control, which must not move. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector(".k2b-chat-composer")!.getBoundingClientRect();
    const left = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().left);
    return {
      top: Math.round(box.top),
      height: Math.round(box.height),
      controls: [
        left('[aria-label="Add to chat"]'),
        left('[aria-label="Formatting"]'),
        left('[aria-label="Insert emoji"]'),
        left(".k2b-chat-composer__microphone-button"),
        left('[aria-label="Microphone options"]'),
        left(".k2b-chat-composer__send"),
      ],
    };
  });

describe(`conversation ChatComposer in ${browserName}`, () => {
  test("starts with one line and grows to a third of its container, without collapsing or moving the newest message", async () => {
    const page = await open();
    const field = page.locator("textarea").first();
    const start = await field.evaluate((element) => element.getBoundingClientRect().height);
    expect(start).toBeGreaterThan(30);
    expect(start).toBeLessThan(40);
    await page.evaluate(() => probe.start());

    await field.click();
    await page.keyboard.type("Line 1");
    for (let line = 2; line <= 16; line++) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`Line ${line}`);
    }
    await frames(page, 4);
    const run = await page.evaluate(() => probe.stop());
    expect(run.frames).toBeGreaterThan(10);
    // The newest message stays right above the composer in every frame.
    expect(Math.max(...run.gaps) - Math.min(...run.gaps)).toBeLessThanOrEqual(1);
    // The field only ever grows while lines are added; it never shrinks to be measured.
    for (let index = 1; index < run.heights.length; index++) expect(run.heights[index]!).toBeGreaterThanOrEqual(run.heights[index - 1]!);

    const end = await field.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrolls: element.scrollHeight > element.clientHeight,
    }));
    // A third of the container's content box (#app keeps 0.5rem below the composer).
    expect(Math.abs(end.height - (height - 8) / 3)).toBeLessThanOrEqual(1);
    expect(end.scrolls).toBe(true);

    // Enter sends; the field is one line again and keeps the focus.
    await page.keyboard.press("Enter");
    await frames(page, 4);
    expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent.length)).toBe(1);
    expect(await field.evaluate((element) => element.getBoundingClientRect().height)).toBe(start);
    expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  }, 30_000);

  test("a submission that waits for the server keeps the field focused and editable", async () => {
    const page = await open({ submitDelay: 200 });
    const field = page.locator("textarea").first();
    await field.click();
    await field.evaluate((element) => {
      (window as unknown as { focusEvents: string[] }).focusEvents = [];
      for (const type of ["blur", "focus"]) {
        element.addEventListener(type, () => (window as unknown as { focusEvents: string[] }).focusEvents.push(type));
      }
    });
    await page.keyboard.type("Hello");
    await page.keyboard.press("Enter");
    // Typed while the request runs.
    await page.keyboard.type("next");
    expect(await field.evaluate((element) => (element as HTMLTextAreaElement).disabled)).toBe(false);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual(["Hello"]);
    expect(await field.inputValue()).toBe("next");
    expect(await page.evaluate(() => (window as unknown as { focusEvents: string[] }).focusEvents)).toEqual([]);
    expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.close();
  }, 30_000);

  test("Aa, hints and dictation states change neither the composer's height nor the place of a control", async () => {
    for (const width of [720, 360]) {
      const page = await open({ width });
      const before = await layout(page);
      await page.locator('[aria-label="Formatting"]').click();
      await frames(page, 2);
      expect(await layout(page)).toEqual(before);
      const format = await page.evaluate(() => {
        const group = document.querySelector(".k2b-chat-composer__format")!;
        return { scrolls: group.scrollWidth > group.clientWidth, buttons: group.querySelectorAll("button").length };
      });
      expect(format.buttons).toBe(8);
      // A phone shows some buttons and scrolls to the others.
      expect(format.scrolls).toBe(width === 360);

      await page.evaluate(() => fixture.setHint("Everyone in this chat can open the reference, as far as their own access reaches."));
      await frames(page, 2);
      expect(await layout(page)).toEqual(before);
      for (const state of ["listening", "refining", "refined", "unrefined", "interrupted", null]) {
        await page.evaluate((state) => fixture.setDictation(state), state);
        await frames(page, 2);
        expect(await layout(page)).toEqual(before);
      }
      await page.close();
    }
  }, 30_000);

  test("a phone hides the emoji button, gives every control 44 px, and Enter breaks the line", async () => {
    const page = await open({ width: 390 }, { hasTouch: true, isMobile: true });
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse) and (not (any-pointer: fine))").matches)).toBe(true);
    expect(await page.locator('[aria-label="Insert emoji"]').isVisible()).toBe(false);
    const widths = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".k2b-chat-composer__footer button")]
        .filter((button) => button.offsetParent)
        .map((button) => Math.round(button.getBoundingClientRect().width)),
    );
    expect(widths.length).toBeGreaterThanOrEqual(5);
    for (const width of widths) expect(width).toBe(44);

    // The formatting row scrolls sideways only, and its buttons keep their taller tap areas.
    const before = await layout(page);
    await page.locator('button[aria-label="Formatting"]').tap();
    await frames(page, 2);
    expect(await layout(page)).toEqual(before);
    const format = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>(".k2b-chat-composer__format")!;
      group.scrollTop = 20;
      const bold = group.querySelector("button")!.getBoundingClientRect();
      const tap = document.elementFromPoint(bold.left + bold.width / 2, bold.top - 6);
      return {
        scrollTop: group.scrollTop,
        tall: group.scrollHeight - group.clientHeight,
        wide: group.scrollWidth > group.clientWidth,
        fade: group.dataset.scrollFade,
        tapsBold: tap?.getAttribute("aria-label"),
      };
    });
    expect(format).toEqual({ scrollTop: 0, tall: 0, wide: true, fade: "bottom", tapsBold: "Bold (Ctrl/Cmd+B)" });
    await page.locator('button[aria-label="Formatting"]').tap();

    const field = page.locator("textarea").first();
    await field.tap();
    await page.keyboard.type("Hello");
    await page.keyboard.press("Enter");
    expect(await field.inputValue()).toBe("Hello\n");
    expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent.length)).toBe(0);
    await page.locator(".k2b-chat-composer__send").tap();
    expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual(["Hello\n"]);
    await page.close();
  }, 30_000);
});
