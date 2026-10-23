import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

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
window.outsideClicks = { native: 0, onclick: 0 };
if (options.viewportHeight) {
  const header = document.createElement("header");
  header.id = "outside-header";
  const headerButton = document.createElement("button");
  headerButton.textContent = "Header action";
  header.append(headerButton);
  const feedButton = document.createElement("button");
  feedButton.id = "outside-feed";
  feedButton.textContent = "Feed action";
  for (const button of [headerButton, feedButton]) {
    button.addEventListener("click", () => window.outsideClicks.native++);
    button.onclick = () => window.outsideClicks.onclick++;
  }
  document.body.append(header, feedButton);
}
if (options.tabBar) {
  const bar = document.createElement("nav");
  bar.id = "tab-bar";
  const button = document.createElement("button");
  button.textContent = "Cloud tab";
  button.addEventListener("click", () => window.outsideClicks.native++);
  bar.append(button);
  document.body.append(bar);
}
let resolveSearch;
let searches = 0;
window.fixture = { setHint, setDictation, setDraft,
  resolveSearch: (rows) => resolveSearch?.(rows),
  searchCount: () => searches,
};

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
            addOpensCommands: options.add ? true : undefined,
            variant: options.mode === "slash" ? "default" : "conversation",
            commandSections: options.sections ? [{ id: "local", label: "Local commands" }, { id: "remote", label: "Results", searched: true }] : undefined,
            commands: options.sections ? Array.from({ length: 24 }, (_, index) => ({ id: "local-" + index, name: "Query " + index, description: "Local command", section: "local" })) : options.mode === "slash" ? [
              { id: "alpha", name: "alpha", label: "Alpha", description: "First local command", keywords: ["q", "qu"] },
              { id: "blocked", name: "blocked", label: "Blocked", description: "Unused", keywords: ["q", "qu"], reason: "Available after the first response" },
              { name: "fail", description: "Reject this action", action: async () => { throw new Error("Please try again"); } },
              { name: "done", description: "Finish this action", action: async () => ({ done: "All done" }) },
              // An action that navigates within the page at once, as an application's router does.
              ...(options.navigate ? [{ name: "go", label: "Go", description: "Open the next page", action: () => { history.pushState({ page: 2 }, "", "#next"); } }] : []),
            ] : undefined,
            searchCommands: options.mode === "slash" ? () => new Promise((resolve) => { searches++; resolveSearch = resolve; }) : undefined,
            get value() {
              return draft();
            },
            onValueChange: setDraft,
            onSubmit: ({ text }) => {
              window.sent.push(text);
              setItems((current) => [...current, { id: "s" + current.length, text }]);
              // An application that opens the sent conversation's address at once.
              if (options.submitNavigate) history.pushState({ page: "sent" }, "", "#sent");
              // A server round trip, as an application that waits for its request.
              if (options.submitDelay) return new Promise((done) => setTimeout(done, options.submitDelay));
            },
            // "files" attaches directly, "menu" turns attach into the add menu, "none" leaves it out.
            fileSelection: options.attach === "none" ? undefined : { onSelect: () => {} },
            menuActions: options.attach === "menu" ? [{ id: "poll", label: "Poll", onSelect: () => {} }] : undefined,
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
  resolveSearch: (rows: { id?: string; name: string; description: string; section?: string; keywords?: string[] }[]) => void;
  searchCount: () => number;
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
  options: {
    mode?: "slash";
    add?: boolean;
    tabBar?: boolean;
    sections?: boolean;
    /** Places the composer at the screen bottom, including in phone landscape. */
    viewportHeight?: boolean;
    /** Adds a command whose action pushes a history entry, as a router's navigation does. */
    navigate?: boolean;
    /** Makes onSubmit push a history entry, as an application that opens the sent conversation does. */
    submitNavigate?: boolean;
    /** Installs Playwright's clock before the page loads; it follows real time until a test moves it. */
    clock?: boolean;
    width?: number;
    locale?: "en" | "de";
    dark?: boolean;
    submitDelay?: number;
    attach?: "files" | "menu" | "none";
  } = {},
  context: BrowserContextOptions = {},
): Promise<Page> => {
  const width = options.width ?? 720;
  const page = await (await browser.newContext({ viewport: { width, height }, ...context })).newPage();
  if (options.clock) await page.clock.install({ time: new Date("2026-10-15T12:00:00Z") });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  const documentHtml =
    `<!doctype html><html lang="${options.locale ?? "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<style>${css}</style><style>${fonts}</style>` +
    `<style>*,*::before,*::after{transition:none!important}
html, body { margin: 0; height: 100%; }
#app { display: flex; flex-direction: column; height: ${options.viewportHeight ? "100dvh" : `${height}px`}; container-type: size; padding: 0 0.5rem 0.5rem; box-sizing: border-box; }
.k2b-virtual-feed { flex: 1; min-height: 0; }
#outside-header { position: fixed; top: 4px; left: 12px; }
#outside-header button, #outside-feed { height: 24px; padding: 0 8px; }
#outside-feed { position: fixed; top: 36px; right: 12px; }
${
  options.tabBar
    ? `
#app { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.5rem + 3.875rem + 0.75rem); }
#tab-bar { position: fixed; bottom: 0; left: 0; right: 0; height: calc(env(safe-area-inset-bottom, 0px) + 0.5rem + 3.875rem + 0.75rem); }
#tab-bar button { height: 3.875rem; width: 100%; }
`
    : ""
}
.row { margin: 0; padding: 6px 12px; font: 14px/20px sans-serif; }
</style></head>` +
    `<body class="k2b-ui${options.dark ? " k2b-dark" : ""}" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`;
  // A real origin lets same-URL history entries behave equally in Chromium and WebKit.
  const documentUrl = `${assets}chat-composer`;
  await page.route(documentUrl, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
  await page.goto(documentUrl);
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

/** The composer's box and the box of the field and every control in its row, which must not move. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    const composer = document.querySelector(".k2b-chat-composer")!.getBoundingClientRect();
    return {
      bottom: Math.round(composer.bottom),
      height: Math.round(composer.height),
      row: [".k2b-chat-composer__field", ...[...document.querySelectorAll(".k2b-chat-composer__row button")].map((_, index) => index)].map(
        (item) =>
          typeof item === "string"
            ? box(document.querySelector(item)!)
            : box(document.querySelectorAll(".k2b-chat-composer__row button")[item]!),
      ),
    };
  });

/** Every formatting button: its box, and whether a tap on its middle reaches it; and where the field starts. */
const formatButtons = (page: Page) =>
  page.evaluate(() => {
    const group = document.querySelector<HTMLElement>(".k2b-chat-composer__format")!;
    const buttons = [...group.querySelectorAll("button")];
    return {
      fieldLeft: document.querySelector(".k2b-chat-composer__field")!.getBoundingClientRect().left,
      scrolls: group.scrollWidth > group.clientWidth,
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          reached: Boolean(hit && button.contains(hit)),
        };
      }),
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

  test("Aa adds one row above the field; it, hints and dictation states never move the field, a control, or the newest message", async () => {
    for (const width of [720, 360]) {
      const page = await open({ width });
      const before = await layout(page);
      await page.evaluate(() => probe.start());
      await page.locator('button[aria-label="Formatting"]').click();
      await frames(page, 4);
      const run = await page.evaluate(() => probe.stop());
      const opened = await layout(page);
      // The composer grows upward by the formatting row; the field and every control in its row stay put.
      expect(opened.row).toEqual(before.row);
      expect(opened.bottom).toBe(before.bottom);
      expect(opened.height).toBeGreaterThan(before.height);
      // The newest message stays right above the composer in every frame.
      expect(Math.max(...run.gaps) - Math.min(...run.gaps)).toBeLessThanOrEqual(1);
      const format = await formatButtons(page);
      expect(format.buttons).toHaveLength(3);
      expect(format.scrolls).toBe(false);
      // The row starts where the field starts, not at the attach button.
      expect(format.buttons[0]!.left).toBeCloseTo(format.fieldLeft, 1);
      for (const button of format.buttons) expect(button.reached).toBe(true);

      await page.evaluate(() => fixture.setHint("Everyone in this chat can open the reference, as far as their own access reaches."));
      await frames(page, 2);
      expect(await layout(page)).toEqual(opened);
      for (const state of ["listening", "refining", "refined", "unrefined", "interrupted", null]) {
        await page.evaluate((state) => fixture.setDictation(state), state);
        await frames(page, 2);
        expect(await layout(page)).toEqual(opened);
      }
      await page.locator('button[aria-label="Formatting"]').click();
      await frames(page, 2);
      expect(await layout(page)).toEqual(before);
      await page.close();
    }
  }, 30_000);

  test("a phone shows the v5 row with 44 px controls, the formatting row from the field's edge, and Enter breaks the line", async () => {
    for (const width of [390, 360]) {
      const page = await open({ width }, { hasTouch: true, isMobile: true });
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse) and (not (any-pointer: fine))").matches)).toBe(true);
      expect(await page.locator('[aria-label="Insert emoji"]').isVisible()).toBe(false);
      const row = await page.evaluate(() => {
        const size = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return [Math.round(rect.width), Math.round(rect.height)];
        };
        return {
          attach: size('[aria-label="Attach files"]'),
          field: size(".k2b-chat-composer__field"),
          formatting: size('[aria-label="Formatting"]'),
          microphone: size(".k2b-chat-composer__microphone-button"),
          options: size('[aria-label="Microphone options"]'),
          send: size(".k2b-chat-composer__send"),
          fieldText: getComputedStyle(document.querySelector("textarea")!).fontSize,
        };
      });
      expect(row).toEqual({
        attach: [44, 44],
        field: [row.field[0]!, 44],
        formatting: [44, 44],
        microphone: [44, 44],
        options: [28, 44],
        send: [44, 44],
        // iOS zooms into a field with smaller text.
        fieldText: "16px",
      });

      const before = await layout(page);
      await page.locator('button[aria-label="Formatting"]').tap();
      await frames(page, 2);
      expect((await layout(page)).row).toEqual(before.row);
      const format = await formatButtons(page);
      // Bold, Italic and List start at the field's edge: nothing scrolls, nothing overlaps, and each takes its own taps.
      expect(format.scrolls).toBe(false);
      expect(format.buttons).toHaveLength(3);
      expect(format.buttons[0]!.left).toBeCloseTo(format.fieldLeft, 1);
      for (const [index, button] of format.buttons.entries()) {
        expect(button.reached).toBe(true);
        expect([button.width, button.height]).toEqual([44, 44]);
        if (index > 0) expect(button.left).toBeGreaterThanOrEqual(format.buttons[index - 1]!.right);
        expect(button.right).toBeLessThanOrEqual(width);
      }
      await page.locator('button[aria-label="Bold (Ctrl/Cmd+B)"]').tap();
      expect(await page.locator("textarea").first().inputValue()).toBe("****");
      await page.locator('button[aria-label="Formatting"]').tap();
      await page.evaluate(() => fixture.setDraft(""));
      await frames(page, 2);
      // Closing the row gives its height back; the field and every control are where they were.
      expect(await layout(page)).toEqual(before);

      const field = page.locator("textarea").first();
      await field.tap();
      await page.keyboard.type("Hello");
      await page.keyboard.press("Enter");
      expect(await field.inputValue()).toBe("Hello\n");
      expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent.length)).toBe(0);
      await page.locator(".k2b-chat-composer__send").tap();
      expect(await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual(["Hello\n"]);
      expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.close();
    }
  }, 30_000);

  test("on a phone the empty field shows the placeholder on one line, as tall as the field with one typed character", async () => {
    for (const width of [390, 320]) {
      for (const locale of ["en", "de"] as const) {
        const page = await open({ width, locale }, { hasTouch: true, isMobile: true });
        const field = page.locator("textarea").first();
        const empty = await field.evaluate((element) => {
          // The placeholder's unwrapped width in the field's font, against the room the field leaves for text.
          const style = getComputedStyle(element);
          const probe = document.createElement("span");
          probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`;
          probe.textContent = element.getAttribute("placeholder");
          document.body.append(probe);
          const text = probe.getBoundingClientRect().width;
          probe.remove();
          return {
            text,
            room: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            height: element.getBoundingClientRect().height,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          };
        });
        // The German placeholder is wider than the field on both phones, so the test covers the overflow case whatever
        // the exact wording; the English one fits at 390.
        if (locale === "de") expect(empty.text).toBeGreaterThan(empty.room);
        // Both engines count a wrapped placeholder in the empty field's scroll height.
        expect(empty.scrollHeight).toBeLessThanOrEqual(empty.clientHeight);
        const before = await layout(page);

        await field.tap();
        await page.keyboard.type("x");
        await frames(page, 2);
        expect(await field.evaluate((element) => element.getBoundingClientRect().height)).toBe(empty.height);
        expect(await layout(page)).toEqual(before);
        await page.close();
      }
    }
  }, 30_000);

  test("an action from the add menu returns the focus to the field, as attaching files does", async () => {
    const page = await open({ attach: "menu" });
    await page.locator(".k2b-chat-composer__attach").click();
    await page.getByRole("menuitem", { name: "Poll" }).click();
    await page.waitForFunction(() => document.activeElement?.matches(".k2b-chat-composer textarea:not([aria-hidden])"));
    await page.close();
  }, 30_000);

  test("the formatting row starts at the field's edge also with the add menu or without an attach control", async () => {
    const devices: [number, BrowserContextOptions][] = [
      [720, {}],
      [390, { hasTouch: true, isMobile: true }],
    ];
    for (const attach of ["menu", "none"] as const) {
      for (const [width, context] of devices) {
        const page = await open({ width, attach }, context);
        // The add menu's attach sits in the Dropdown's wrapper; "none" has no attach control at all.
        expect(await page.locator(".k2b-chat-composer__row .k2b-dropdown .k2b-chat-composer__attach").count()).toBe(
          attach === "menu" ? 1 : 0,
        );
        expect(await page.locator(".k2b-chat-composer__attach").count()).toBe(attach === "menu" ? 1 : 0);
        const before = await layout(page);
        await page.locator('button[aria-label="Formatting"]').click();
        await frames(page, 2);
        expect((await layout(page)).row).toEqual(before.row);
        const format = await formatButtons(page);
        expect(format.buttons).toHaveLength(3);
        expect(format.buttons[0]!.left).toBeCloseTo(format.fieldLeft, 1);
        await page.close();
      }
    }
  }, 30_000);
});

const slashBoxes = (page: Page, option = false) =>
  page.evaluate((option) => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    return { field: box("textarea"), composer: box(".k2b-chat-composer"), ...(option ? { firstOption: box('[role="option"]') } : {}) };
  }, option);

describe(`default slash ChatComposer in ${browserName}`, () => {
  for (const width of [1440, 390]) {
    test(`pending search retains option ids and field and option boxes at ${width}px`, async () => {
      const page = await open({ mode: "slash", width });
      try {
        const field = page.locator("textarea").first();
        await field.fill("/q");
        await page.waitForFunction(() => fixture.searchCount() === 1);
        await page.evaluate(() =>
          fixture.resolveSearch([{ id: "server", name: "Server", keywords: ["qu"], description: "Previous result" }]),
        );
        await page.locator('[role="option"]').filter({ hasText: "Previous result" }).waitFor();
        await frames(page, 2);
        const ids = await page.locator('[role="option"]').evaluateAll((rows) => rows.map((row) => row.id));
        const before = await slashBoxes(page, true);
        await field.press("End");
        await page.keyboard.type("u");
        await page.waitForFunction(() => fixture.searchCount() === 2);
        expect(await page.locator('[role="option"]').evaluateAll((rows) => rows.map((row) => row.id))).toEqual(ids);
        expect(await slashBoxes(page, true)).toEqual(before);
        expect(await page.locator('[role="listbox"]').getAttribute("aria-busy")).toBe("true");
        expect(await page.locator(".k2b-chat-composer__loading").count()).toBe(0);
        await page.evaluate(() => fixture.resolveSearch([{ id: "replacement", name: "Replacement", description: "New result" }]));
        await page.locator('[role="option"]').filter({ hasText: "New result" }).waitFor();
        expect(await page.locator('[role="option"]').filter({ hasText: "Previous result" }).count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`error and done status never move the field or composer and hide behind suggestions at ${width}px`, async () => {
      const page = await open({ mode: "slash", width, clock: true });
      try {
        const field = page.locator("textarea").first();
        await field.fill("/fail");
        await frames(page, 2);
        const before = await slashBoxes(page);
        await field.press("Enter");
        const status = page.locator('.k2b-chat-composer__status-line[data-tone="error"]');
        await status.waitFor();
        expect(await status.textContent()).toBe("Please try again");
        expect(await field.inputValue()).toBe("/fail");
        expect(await slashBoxes(page)).toEqual(before);
        await field.click();
        expect(await page.locator('[role="listbox"]').isVisible()).toBe(true);
        expect(await page.locator(".k2b-chat-composer__status-line").count()).toBe(0);
        await field.press("Escape");
        expect(await status.isVisible()).toBe(true);
        await field.fill("/done");
        await frames(page, 2);
        const beforeDone = await slashBoxes(page);
        await field.press("Enter");
        await page.locator('.k2b-chat-composer__status-line[data-tone="done"]').waitFor();
        expect(await slashBoxes(page)).toEqual(beforeDone);
        await field.fill("/done");
        expect(await page.locator(".k2b-chat-composer__status-line").count()).toBe(0);
        await field.press("Escape");
        expect(await page.locator(".k2b-chat-composer__status-line").textContent()).toBe("All done");
        await page.clock.fastForward(3_100);
        expect(await page.locator(".k2b-chat-composer__status-line").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

test(`section headings stick while scrolled and arriving server rows preserve the visible row in ${browserName}`, async () => {
  for (const width of [1440, 390]) {
    const page = await open({ mode: "slash", sections: true, width });
    try {
      await page.locator("textarea").first().fill("/q");
      await page.waitForFunction(() => fixture.searchCount() === 1);
      const list = page.locator('[role="listbox"]');
      await list.evaluate((element) => {
        element.scrollTop = 120;
      });
      await frames(page, 2);
      const heading = page.locator(".k2b-chat-composer__command-heading").first();
      const listBefore = await list.boundingBox();
      const headingBox = await heading.boundingBox();
      expect(Math.abs(headingBox!.y - listBefore!.y)).toBeLessThanOrEqual(1.5);
      const visibleId = await list.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const heading = element.querySelector(".k2b-chat-composer__command-heading")!.getBoundingClientRect();
        return [...element.querySelectorAll('[role="option"]')].find(
          (row) => row.getBoundingClientRect().top >= Math.max(top, heading.bottom),
        )!.id;
      });
      const row = page.locator(`[id="${visibleId}"]`);
      const before = await row.boundingBox();
      await page.evaluate(() =>
        fixture.resolveSearch(
          Array.from({ length: 8 }, (_, index) => ({
            id: "server-" + index,
            name: "Query server " + index,
            description: "Loaded result",
            section: "remote",
          })),
        ),
      );
      await page.locator('[role="option"]').filter({ hasText: "Query server 0" }).waitFor();
      await frames(page, 2);
      expect(await list.boundingBox()).toEqual(listBefore);
      expect(await row.boundingBox()).toEqual(before);
      expect(Math.abs((await heading.boundingBox())!.y - listBefore!.y)).toBeLessThanOrEqual(1.5);
    } finally {
      await page.close();
    }
  }
}, 30_000);

const phones: { name: string; context: BrowserContextOptions }[] = [
  { name: "portrait", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { name: "landscape", context: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true } },
];

const finishListAnimation = async (page: Page) => {
  await frames(page, 2);
  await page.locator(".k2b-chat-composer__commands").evaluate(async (element) => {
    const panel = element.closest("[data-search]") ?? element;
    await Promise.all(
      panel
        .getAnimations({ subtree: true })
        .filter((animation) => animation.timeline === document.timeline)
        .map((animation) => animation.finished),
    );
  });
};

const listGeometry = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".k2b-chat-composer__commands")!;
    const rect = list.getBoundingClientRect();
    const style = getComputedStyle(list);
    const shell = document.querySelector(".k2b-chat-composer-shell")!.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      composerTop: document.querySelector(".k2b-chat-composer")!.getBoundingClientRect().top,
      shellLeft: shell.left,
      shellRight: shell.right,
      width: innerWidth,
      corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(
        parseFloat,
      ),
      sides: [style.borderLeftWidth, style.borderRightWidth].map(parseFloat),
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      listOverflow: list.scrollWidth - list.clientWidth,
      rows: [...list.querySelectorAll(".k2b-chat-composer__command")].map((row) => {
        const name = row.querySelector("strong")!;
        const description = row.querySelector("small");
        return {
          height: row.getBoundingClientRect().height,
          descriptionTop: description?.getBoundingClientRect().top,
          nameBottom: name.getBoundingClientRect().bottom,
        };
      }),
    };
  });

const expectPageHistory = async (page: Page) => {
  await page.waitForFunction(() => history.state?.sentinel === 1 && history.state?.k2bDialog === undefined);
  expect(await page.evaluate(() => history.state)).toEqual({ sentinel: 1 });
};

const outsideClicks = (page: Page) => page.evaluate(() => window.outsideClicks);

declare global {
  interface Window {
    outsideClicks: { native: number; onclick: number };
    /** The hash of every popstate an application listener received. */
    pops: string[];
    /** The text of every submission. */
    sent: string[];
  }
}

describe(`slash command phone sheet in ${browserName}`, () => {
  for (const { name, context } of phones) {
    test(`the ${name} sheet spans the column, joins the composer and keeps the field still`, async () => {
      const page = await open({ mode: "slash", viewportHeight: true }, context);
      try {
        const field = page.locator("textarea").first();
        await field.tap();
        const before = await field.boundingBox();
        await page.keyboard.type("/");
        await page.locator(".k2b-chat-composer__commands").waitFor();
        expect(await field.boundingBox()).toEqual(before);
        await finishListAnimation(page);
        expect(await field.boundingBox()).toEqual(before);
        const box = await listGeometry(page);
        expect(Math.abs(box.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.right - box.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.bottom - box.composerTop)).toBeLessThanOrEqual(1);
        expect(box.corners[0]).toBeGreaterThan(0);
        expect(box.corners[1]).toBeGreaterThan(0);
        expect(box.corners.slice(2)).toEqual([0, 0]);
        expect(box.sides).toEqual([0, 0]);
        expect(box.rows.length).toBeGreaterThan(0);
        for (const row of box.rows) {
          expect(row.height).toBeGreaterThanOrEqual(48);
          if (row.descriptionTop !== undefined) expect(row.descriptionTop).toBeGreaterThanOrEqual(row.nameBottom - 1);
        }
        expect(box.rows.some((row) => row.descriptionTop !== undefined)).toBe(true);
        expect(box.pageOverflow).toBeLessThanOrEqual(0);
        expect(box.listOverflow).toBeLessThanOrEqual(0);
      } finally {
        await page.close();
      }
    }, 30_000);

    for (const target of ["#outside-header button", "#outside-feed"]) {
      test(`a ${name} tap on ${target} dismisses only the sheet and the next tap acts normally`, async () => {
        const page = await open({ mode: "slash", viewportHeight: true }, context);
        try {
          await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
          const field = page.locator("textarea").first();
          await field.tap();
          await page.keyboard.type("/al");
          await finishListAnimation(page);
          expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
          const button = page.locator(target);
          // The test taps an exposed button, not a command covering it.
          expect(
            await button.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
            }),
          ).toBe(true);
          await button.tap();
          expect(await page.locator(".k2b-chat-composer__commands").count()).toBe(0);
          expect(await outsideClicks(page)).toEqual({ native: 0, onclick: 0 });
          expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await field.inputValue()).toBe("/al");
          await expectPageHistory(page);
          await button.tap();
          expect(await outsideClicks(page)).toEqual({ native: 1, onclick: 1 });
        } finally {
          await page.close();
        }
      }, 30_000);
    }

    test(`Back closes the ${name} sheet first, preserving URL, focus and slash text`, async () => {
      const page = await open({ mode: "slash", viewportHeight: true }, context);
      try {
        const url = page.url();
        await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
        const length = await page.evaluate(() => history.length);
        const field = page.locator("textarea").first();
        await field.tap();
        await page.keyboard.type("/al");
        await finishListAnimation(page);
        expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
        expect(await page.evaluate(() => history.length)).toBe(length + 1);
        // The page's own popstate listeners never see this Back: it only closes the sheet's same-URL entry.
        await page.evaluate(() => {
          window.addEventListener("popstate", () => document.body.setAttribute("data-page-popstate", ""));
          history.back();
        });
        await page.waitForFunction(() => !document.querySelector(".k2b-chat-composer__commands"));
        await expectPageHistory(page);
        expect(page.url()).toBe(url);
        expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await field.inputValue()).toBe("/al");
        expect(await page.evaluate(() => document.body.hasAttribute("data-page-popstate"))).toBe(false);
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`choosing a command and Escape both remove the ${name} sheet history entry`, async () => {
      const page = await open({ mode: "slash", viewportHeight: true }, context);
      try {
        await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
        const field = page.locator("textarea").first();
        for (const close of ["choose", "escape"]) {
          await field.fill("");
          await field.tap();
          await page.keyboard.type("/al");
          await finishListAnimation(page);
          expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
          if (close === "choose") await page.locator(".k2b-chat-composer__command").filter({ hasText: "First local command" }).tap();
          else await field.press("Escape");
          expect(await page.locator(".k2b-chat-composer__commands").count()).toBe(0);
          await expectPageHistory(page);
          expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await field.inputValue()).toBe(close === "choose" ? "" : "/al");
        }
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`an action that navigates finds the ${name} sheet's history entry gone`, async () => {
      const page = await open({ mode: "slash", viewportHeight: true, navigate: true }, context);
      try {
        await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
        const field = page.locator("textarea").first();
        await field.tap();
        await page.keyboard.type("/go");
        await finishListAnimation(page);
        expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
        await page.locator(".k2b-chat-composer__command").filter({ hasText: "Open the next page" }).tap();
        await page.waitForFunction(() => history.state?.page === 2);
        // One Back returns to the page as it was before the sheet opened, not to a leftover sheet entry.
        await page.evaluate(
          () =>
            new Promise<void>((done) => {
              window.addEventListener("popstate", () => done(), { once: true });
              history.back();
            }),
        );
        expect(await page.evaluate(() => history.state)).toEqual({ sentinel: 1 });
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`emoji suggestions keep their floating list and leave history alone in ${name}`, async () => {
      const page = await open({ mode: "slash", viewportHeight: true }, context);
      try {
        await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
        const field = page.locator("textarea").first();
        await field.tap();
        await page.keyboard.type(":smi");
        await page.locator(".k2b-chat-composer__commands").waitFor();
        await finishListAnimation(page);
        expect(await page.locator(".k2b-chat-composer-accessory[data-commands]").count()).toBe(0);
        const box = await listGeometry(page);
        expect(Math.abs(box.bottom - (box.composerTop - 8))).toBeLessThanOrEqual(1);
        expect(Math.abs(box.left - box.shellLeft)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.right - box.shellRight)).toBeLessThanOrEqual(1);
        for (const corner of box.corners) expect(corner).toBeGreaterThan(0);
        for (const side of box.sides) expect(side).toBeGreaterThan(0);
        await expectPageHistory(page);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("a router sees address changes under the sheet but never its same-URL Back or Forward", async () => {
    const page = await open({ mode: "slash", viewportHeight: true }, phones[0]!.context);
    try {
      await page.evaluate(() => {
        history.replaceState({ sentinel: 1 }, "");
        window.pops = [];
        window.addEventListener("popstate", () => window.pops.push(location.hash));
      });
      const field = page.locator("textarea").first();
      const openSheet = async () => {
        await field.tap();
        await page.keyboard.type("/al");
        await finishListAnimation(page);
        expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
      };
      const pops = () => page.evaluate(() => window.pops);

      // The application navigates while the sheet is open: Back from its page reaches the router.
      await openSheet();
      await page.evaluate(() => history.pushState(null, "", "#pushed"));
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => window.pops.length === 1);
      expect(await pops()).toEqual([""]);
      await field.press("Escape");
      await expectPageHistory(page);

      // The application rewrites the sheet entry's address: Back to the page beneath reaches the router.
      await field.fill("");
      await openSheet();
      await page.evaluate(() => history.replaceState(history.state, "", "#replaced"));
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => window.pops.length === 2);
      expect(await pops()).toEqual(["", ""]);
      await page.waitForFunction(() => !document.querySelector(".k2b-chat-composer__commands"));

      // Forward onto the entry a chosen command left behind, and Back again, stay with the sheet's history.
      await field.fill("");
      await openSheet();
      await page.locator(".k2b-chat-composer__command").filter({ hasText: "First local command" }).tap();
      await expectPageHistory(page);
      await page.evaluate(() => history.forward());
      await page.waitForFunction(() => typeof history.state?.k2bDialog === "number");
      await page.evaluate(() => history.back());
      await expectPageHistory(page);
      await frames(page, 2);
      expect(await pops()).toEqual(["", ""]);
      expect(await page.locator(".k2b-chat-composer__commands").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("sending with the sheet open lets the application's address follow the page beneath it", async () => {
    const page = await open({ mode: "slash", viewportHeight: true, submitNavigate: true }, phones[0]!.context);
    try {
      await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
      const field = page.locator("textarea").first();
      await field.tap();
      await page.keyboard.type("/al");
      await finishListAnimation(page);
      expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
      await page.locator(".k2b-chat-composer__send").tap();
      await page.waitForFunction(() => history.state?.page === "sent");
      expect(await page.evaluate(() => window.sent)).toEqual(["/al"]);
      // One Back returns to the page as it was before the sheet opened, not to a leftover sheet entry.
      await page.evaluate(() => history.back());
      await expectPageHistory(page);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("desktop commands keep floating geometry and an outside click closes them and acts normally", async () => {
    const page = await open({ mode: "slash", viewportHeight: true }, { viewport: { width: 1440, height: 900 }, hasTouch: false });
    try {
      await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
      const length = await page.evaluate(() => history.length);
      const field = page.locator("textarea").first();
      await field.click();
      await page.keyboard.type("/");
      await finishListAnimation(page);
      const box = await listGeometry(page);
      expect(Math.abs(box.bottom - (box.composerTop - 8))).toBeLessThanOrEqual(1);
      expect(Math.abs(box.left - box.shellLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.right - box.shellRight)).toBeLessThanOrEqual(1);
      for (const corner of box.corners) expect(corner).toBeGreaterThan(0);
      for (const side of box.sides) expect(side).toBeGreaterThan(0);
      // Desktop rows keep their compact type; only the phone sheet takes the larger sizes.
      expect(
        await page
          .locator(".k2b-chat-composer__command strong")
          .first()
          .evaluate((name) => getComputedStyle(name).fontSize),
      ).toBe("13px");
      await expectPageHistory(page);
      expect(await page.evaluate(() => history.length)).toBe(length);
      await page.locator("#outside-header button").click();
      expect(await page.locator(".k2b-chat-composer__commands").count()).toBe(0);
      expect(await outsideClicks(page)).toEqual({ native: 1, onclick: 1 });
    } finally {
      await page.close();
    }
  }, 30_000);
});

/** The search and top option stay anchored while Plus filters a panel of held height. */
const plusBoxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
    };
    return {
      composer: box(".k2b-chat-composer"),
      search: box('input[role="combobox"]'),
      option: box('[role="option"]'),
      panel: box(".k2b-chat-composer-accessory[data-commands]"),
    };
  });

/** The assistant composer and its field, which opening the list from Plus must not move. */
const composerBoxes = (page: Page) =>
  page.evaluate(() =>
    [".k2b-chat-composer", "textarea", '[aria-haspopup="listbox"]'].map((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
    }),
  );

describe(`Plus command list in ${browserName}`, () => {
  for (const width of [1440, 390]) {
    const context = width === 390 ? phones[0]!.context : {};
    for (const tabBar of [false, true]) {
      test(`Plus focuses search above the composer at ${width}px (tab bar=${tabBar})`, async () => {
        const page = await open({ mode: "slash", add: true, width, viewportHeight: true, tabBar }, context);
        try {
          const field = page.locator("textarea").first();
          const before = await composerBoxes(page);
          const plus = page.getByRole("button", { name: "Add", exact: true });
          if (width === 390) await plus.tap();
          else await plus.click();
          await finishListAnimation(page);
          await settled(page);
          expect(await composerBoxes(page)).toEqual(before);
          expect(await page.getByRole("combobox", { name: "Search entries" }).evaluate((el) => el === document.activeElement)).toBe(true);
          expect(await field.getAttribute("role")).toBeNull();
          const boxes = await page.evaluate(() => {
            const panel = document.querySelector(".k2b-chat-composer-accessory[data-commands]")!.getBoundingClientRect();
            const composer = document.querySelector(".k2b-chat-composer")!.getBoundingClientRect();
            const search = document.querySelector('input[role="combobox"]')!.getBoundingClientRect();
            const bar = document.querySelector("#tab-bar")?.getBoundingClientRect();
            const viewport = visualViewport;
            return {
              panelBottom: panel.bottom,
              composerTop: composer.top,
              composerBottom: composer.bottom,
              searchTop: search.top,
              searchBottom: search.bottom,
              barTop: bar?.top,
              viewportTop: viewport?.offsetTop ?? 0,
              viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
            };
          });
          expect(Math.abs(boxes.panelBottom - (boxes.composerTop - (width === 390 ? 0 : 8)))).toBeLessThanOrEqual(1);
          expect(boxes.searchTop).toBeGreaterThanOrEqual(boxes.viewportTop);
          expect(boxes.searchBottom).toBeLessThanOrEqual(Math.min(boxes.composerTop, boxes.viewportBottom));
          if (tabBar) {
            expect(boxes.composerBottom).toBeLessThanOrEqual(boxes.barTop! + 1);
            expect(boxes.panelBottom).toBeLessThanOrEqual(boxes.barTop!);
          }
        } finally {
          await page.close();
        }
      }, 30_000);
    }

    test(`Plus keeps the composer, search and first option still while typing and resolving at ${width}px`, async () => {
      const page = await open({ mode: "slash", add: true, width, viewportHeight: true }, context);
      try {
        const plus = page.getByRole("button", { name: "Add", exact: true });
        if (width === 390) await plus.tap();
        else await plus.click();
        await finishListAnimation(page);
        await settled(page);
        await page.waitForFunction(() => fixture.searchCount() === 1);
        const search = page.getByRole("combobox", { name: "Search entries" });
        const before = await plusBoxes(page);
        for (const character of ["q", "u"]) {
          const count = await page.evaluate(() => fixture.searchCount());
          await search.press(character);
          await page.waitForFunction((count) => fixture.searchCount() > count, count);
          await settled(page);
          expect(await plusBoxes(page)).toEqual(before);
          await page.evaluate(() => fixture.resolveSearch([{ id: "server", name: "Query server", description: "Loaded result" }]));
          await page.getByRole("option").filter({ hasText: "Loaded result" }).waitFor();
          await settled(page);
          expect(await plusBoxes(page)).toEqual(before);
        }
        // The option is absent when no rows match; the panel and search keep their original boxes throughout.
        for (const character of ["z", "z", "z"]) {
          const count = await page.evaluate(() => fixture.searchCount());
          await search.press(character);
          await page.waitForFunction((count) => fixture.searchCount() > count, count);
          await page.evaluate(() => fixture.resolveSearch([]));
          await settled(page);
          const boxes = await plusBoxes(page);
          expect(boxes.composer).toEqual(before.composer);
          expect(boxes.search).toEqual(before.search);
          expect(boxes.panel).toEqual(before.panel);
        }
        await page.getByText("Nothing found for “quzzz”", { exact: true }).waitFor();
        expect(await page.getByRole("option").count()).toBe(0);
        await search.fill("");
        await settled(page);
        expect(await plusBoxes(page)).toEqual(before);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  for (const target of ["#outside-header button", "#outside-feed", "#tab-bar button"]) {
    test(`a phone tap on ${target} closes only Plus and restores textarea focus`, async () => {
      const page = await open({ mode: "slash", add: true, tabBar: true, viewportHeight: true }, phones[0]!.context);
      try {
        await page.evaluate(() => history.replaceState({ sentinel: 1 }, ""));
        const field = page.locator("textarea").first();
        await field.fill("Hello world");
        await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(1, 5));
        await page.getByRole("button", { name: "Add", exact: true }).tap();
        await finishListAnimation(page);
        await settled(page);
        const button = page.locator(target);
        expect(
          await button.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          }),
        ).toBe(true);
        await button.tap();
        expect(await page.getByRole("listbox").count()).toBe(0);
        expect(await outsideClicks(page)).toEqual({ native: 0, onclick: 0 });
        expect(await field.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([1, 5]);
        expect(await field.inputValue()).toBe("Hello world");
        await expectPageHistory(page);
        await button.tap();
        expect(await outsideClicks(page)).toEqual({ native: 1, onclick: target === "#tab-bar button" ? 0 : 1 });
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test("phone Back closes Plus first and the next Back navigates normally", async () => {
    const page = await open({ mode: "slash", add: true, tabBar: true, viewportHeight: true }, phones[0]!.context);
    try {
      await page.evaluate(() => {
        history.replaceState({ previous: 1 }, "", "#previous");
        history.pushState({ sentinel: 1 }, "", "#current");
        window.pops = [];
        window.addEventListener("popstate", () => window.pops.push(location.hash));
      });
      const url = page.url();
      const length = await page.evaluate(() => history.length);
      const field = page.locator("textarea").first();
      await field.fill("Hello world");
      await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
      await page.getByRole("button", { name: "Add", exact: true }).tap();
      await finishListAnimation(page);
      await settled(page);
      expect(await page.evaluate(() => typeof history.state?.k2bDialog)).toBe("number");
      expect(await page.evaluate(() => history.length)).toBe(length + 1);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
      await expectPageHistory(page);
      expect(page.url()).toBe(url);
      expect(await page.evaluate(() => window.pops)).toEqual([]);
      expect(await field.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 5]);
      expect(await field.inputValue()).toBe("Hello world");
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => history.state?.previous === 1);
      expect(new URL(page.url()).hash).toBe("#previous");
      expect(await page.evaluate(() => window.pops)).toEqual(["#previous"]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
