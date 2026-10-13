import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, type Page, devices as playwrightDevices } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";

const indentLabel = "Indent";
const outdentLabel = "Outdent";
const original = "1. Pack\n2. Charger\n3. Leave";
const nested = "1. Pack\n   1. Charger\n2. Leave";

const buildHarness = async () => {
  // Resolve from the directory: `[id]` in a filesystem path is not a URL segment.
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "EditorToolbar.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-editor-toolbar-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Editor toolbar harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string) => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const bundle = await buildHarness();
  // The sidebar harness uses these same shipped styles, including @k2b/ui via global.css.
  const css =
    (await buildCss(resolve(import.meta.dir, "../../../../../../../styles.css"))) +
    (await buildCss(resolve(import.meta.dir, "../../../../styles/app.css")));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      return new Response(
        '<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0">' +
          '<div id="root" style="display:flex;width:100%;height:100dvh;min-width:0"></div><script src="/harness.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

// Use the engine's real mobile user agent so CodeMirror exercises its Android/iOS focus paths.
const { defaultBrowserType: _, ...phone } = playwrightDevices[browserName === "webkit" ? "iPhone 15" : "Pixel 7"];
const devices: Record<string, BrowserContextOptions> = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { ...phone, viewport: { width: 390, height: 844 } },
};

const open = async (device: BrowserContextOptions) => {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  await page.goto(server.url.href);
  await page.waitForFunction(() => "toolbarHarness" in window);
  return page;
};

const load = (page: Page, doc: string) =>
  page.evaluate(async (doc) => {
    const harness = window.toolbarHarness;
    harness.loadDocument(doc);
    await harness.settle();
  }, doc);

const caret = (page: Page, text: string, offset = 3) =>
  page.evaluate(
    async ({ text, offset }) => {
      const harness = window.toolbarHarness;
      harness.placeCaret(text, offset);
      await harness.settle();
    },
    { text, offset },
  );

const read = (page: Page) =>
  page.evaluate(async () => {
    const harness = window.toolbarHarness;
    await harness.settle();
    const content = document.querySelector(".cm-content");
    return { ...harness.read(), activeInEditor: content !== null && content.contains(document.activeElement) };
  });

const select = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const harness = window.toolbarHarness;
    harness.select(text);
    await harness.settle();
  }, text);

const expectEditor = async (page: Page, doc: string, text: string, offset = 3) => {
  expect(await read(page)).toEqual({
    doc,
    anchor: doc.indexOf(text) + offset,
    head: doc.indexOf(text) + offset,
    hasFocus: true,
    activeInEditor: true,
  });
};

const layout = (page: Page) =>
  page.locator(".notebooks-editor-toolbar").evaluate((toolbar) => ({
    width: toolbar.getBoundingClientRect().width,
    buttons: Array.from(toolbar.querySelectorAll("button, a.k2b-icon-button")).map((button) => ({
      label: button.getAttribute("aria-label"),
      x: button.getBoundingClientRect().x,
    })),
  }));

describe.each(Object.entries(devices))("editor toolbar list indentation (%s)", (name, device) => {
  const press = (page: Page, label: string, disabled = false) => {
    // aria-disabled is advisory in the DOM, but Playwright blocks it. Force sends real pointer events to test the guard.
    const selector = `button[aria-label="${label}"]`;
    return name === "phone" ? page.tap(selector, { force: disabled }) : page.click(selector, { force: disabled });
  };

  test("Indent nests and renumbers; Outdent restores text, with focus and the caret preserved after each press", async () => {
    const page = await open(device);
    try {
      await load(page, original);
      await caret(page, "Charger");
      await expectEditor(page, original, "Charger");
      expect(await page.getByRole("button", { name: indentLabel, exact: true }).getAttribute("aria-disabled")).toBeNull();

      await press(page, indentLabel);
      await expectEditor(page, nested, "Charger");
      expect(await page.getByRole("button", { name: outdentLabel, exact: true }).getAttribute("aria-disabled")).toBeNull();

      await press(page, outdentLabel);
      await expectEditor(page, original, "Charger");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("caret availability never shifts the toolbar; disabled presses leave the paragraph and editor focus intact", async () => {
    const page = await open(device);
    try {
      const doc = `Paragraph\n\n${original}`;
      await load(page, doc);
      await caret(page, "Paragraph");
      let paragraph = await layout(page);
      for (const label of [indentLabel, outdentLabel]) {
        expect(await page.getByRole("button", { name: label, exact: true }).count()).toBe(1);
        const button = page.getByRole("button", { name: label, exact: true });
        expect(await button.getAttribute("aria-disabled")).toBe("true");
        // The shared @k2b/ui disabled look, with no hover tint, while the button stays focusable.
        if (name === "desktop") await button.hover({ force: true });
        expect(await button.evaluate((element) => [getComputedStyle(element).opacity, getComputedStyle(element).backgroundColor])).toEqual([
          "0.4",
          "rgba(0, 0, 0, 0)",
        ]);
        await press(page, label, true);
        await expectEditor(page, doc, "Paragraph");
      }

      paragraph = await layout(page);
      await caret(page, "Charger");
      expect(await page.getByRole("button", { name: indentLabel, exact: true }).getAttribute("aria-disabled")).toBeNull();
      expect(await layout(page)).toEqual(paragraph);

      await caret(page, "Pack", 2);
      expect(await page.getByRole("button", { name: indentLabel, exact: true }).getAttribute("aria-disabled")).toBe("true");
      expect(await layout(page)).toEqual(paragraph);

      await load(page, nested);
      await caret(page, "Charger");
      expect(await page.getByRole("button", { name: outdentLabel, exact: true }).getAttribute("aria-disabled")).toBeNull();
      expect(await layout(page)).toEqual(paragraph);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

test("phone at 390px scrolls the toolbar without overflowing the page", async () => {
  const page = await open({ ...phone, viewport: { width: 390, height: 844 } });
  try {
    const bounds = await page.locator(".notebooks-editor-toolbar__tools").evaluate((toolbar) => ({
      pageWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
      scrollWidth: toolbar.scrollWidth,
      clientWidth: toolbar.clientWidth,
    }));
    expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.scrollWidth).toBeGreaterThan(bounds.clientWidth);
    for (const label of [outdentLabel, indentLabel]) {
      const button = page.getByRole("button", { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
  } finally {
    await page.context().close();
  }
});

describe.each(Object.entries(devices))("editor toolbar list kinds (%s)", (name, device) => {
  test("visible list buttons convert the selected lines instead of stacking prefixes, keeping focus and the caret", async () => {
    const page = await open(device);
    try {
      await load(page, "- Pack\n  - Charger");
      await page.evaluate(async () => {
        const harness = window.toolbarHarness;
        harness.placeCaret("Pack", 0);
        await harness.settle();
      });
      // Select from "Pack" to the end so both depths convert.
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+End");
      for (const [label, doc] of [
        ["Numbered list", "1. Pack\n   1. Charger"],
        ["Checklist", "- [ ] Pack\n  - [ ] Charger"],
      ] as const) {
        const item = page.getByRole("button", { name: label, exact: true });
        await (name === "phone" ? item.tap() : item.click());
        const state = await read(page);
        expect(state.doc).toBe(doc);
        expect(state.hasFocus).toBe(true);
        expect(state.head).toBe(doc.length);
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe.each(Object.entries(devices))("editor toolbar inline formatting and insertion (%s)", (name, device) => {
  // A pointer press must not move focus: its mousedown default is prevented. Solid delegates the handler to the
  // document, so a window listener sees the final result, also for the mousedown that follows a tap.
  const pressKeepingFocus = async (page: Page, label: string) => {
    const button = page.getByRole("button", { name: label, exact: true });
    await page.evaluate(() => {
      delete document.body.dataset.pointerPrevented;
      window.addEventListener(
        "mousedown",
        (event) => {
          document.body.dataset.pointerPrevented = String(event.defaultPrevented);
        },
        { once: true },
      );
    });
    if (name === "phone") {
      await button.tap();
    } else {
      const box = await button.boundingBox();
      if (!box) throw new Error(`Missing toolbar button: ${label}`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      expect((await read(page)).activeInEditor).toBe(true);
      await page.mouse.up();
    }
    expect(await page.evaluate(() => document.body.dataset.pointerPrevented)).toBe("true");
  };

  test("Bold preserves editor focus and the selected word on both presses", async () => {
    const page = await open(device);
    try {
      await load(page, "Ein Wort hier");
      await select(page, "Wort");
      expect(await read(page)).toEqual({ doc: "Ein Wort hier", anchor: 4, head: 8, hasFocus: true, activeInEditor: true });
      await pressKeepingFocus(page, "Bold");
      expect(await read(page)).toEqual({ doc: "Ein **Wort** hier", anchor: 6, head: 10, hasFocus: true, activeInEditor: true });
      await pressKeepingFocus(page, "Bold");
      expect(await read(page)).toEqual({ doc: "Ein Wort hier", anchor: 4, head: 8, hasFocus: true, activeInEditor: true });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("More keeps focus on pointer down and inserts an Info callout at the caret line", async () => {
    const page = await open(device);
    try {
      await load(page, "First line\nLast line");
      await caret(page, "First", 2);
      await pressKeepingFocus(page, "More");
      const item = page.getByRole("menuitem", { name: /^Info/ });
      expect(await item.isVisible()).toBe(true);
      await (name === "phone" ? item.tap() : item.click());
      const doc = "First line\n\n:::info\n\n:::\n\nLast line";
      expect(await read(page)).toEqual({
        doc,
        anchor: doc.indexOf(":::info") + 8,
        head: doc.indexOf(":::info") + 8,
        hasFocus: true,
        activeInEditor: true,
      });
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe.each(Object.entries(devices))("toolbar active states and keyboard navigation (%s)", (name, device) => {
  test("every control keeps its bounding rectangle as the caret and selection change formats", async () => {
    const page = await open(device);
    try {
      await load(page, "plain\n\n**bold**\n\n==highlight==\n\n- item\n\n## heading\n\n###### deepest");
      const rectangles = () =>
        page
          .locator(".notebooks-editor-toolbar")
          .evaluate((toolbar) =>
            Array.from(toolbar.querySelectorAll("button, a.k2b-icon-button")).map((control) => control.getBoundingClientRect().toJSON()),
          );
      await caret(page, "plain", 2);
      const original = await rectangles();
      for (const [text, offset] of [
        ["bold", 2],
        ["highlight", 3],
        ["item", 2],
        ["heading", 3],
        ["deepest", 3],
      ] as const) {
        await caret(page, text, offset);
        expect(await rectangles()).toEqual(original);
      }
      await select(page, "bold");
      expect(await rectangles()).toEqual(original);
      expect(await page.getByRole("button", { name: "Bold", exact: true }).getAttribute("aria-pressed")).toBe("true");
      await caret(page, "heading");
      expect(await page.getByRole("button", { name: "Text style: H2", exact: true }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("one tab stop and wrapping arrow keys navigate the rendered toolbar controls", async () => {
    const page = await open(device);
    try {
      const items = page.locator(".notebooks-editor-toolbar__tools");
      const visible = await items.evaluate((toolbar) =>
        Array.from(toolbar.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"))
          .filter((control) => !control.closest("[popover]") && !control.matches(":disabled") && control.getClientRects().length > 0)
          .map((control) => control.getAttribute("aria-label")),
      );
      const first = visible[0]!,
        second = visible[1]!,
        last = visible.at(-1)!;
      await page.getByRole("button", { name: first, exact: true }).focus();
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      for (const [key, expected] of [
        ["ArrowRight", second],
        ["ArrowLeft", first],
        ["ArrowLeft", last],
        ["ArrowRight", first],
        ["End", last],
        ["Home", first],
      ]) {
        await page.keyboard.press(key!);
        expect(await focused()).toBe(expected!);
        expect(await items.locator('[tabindex="0"]').count()).toBe(1);
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("style menu keeps the selection in the note and applies its checked heading", async () => {
    const page = await open(device);
    try {
      await load(page, "word here");
      await select(page, "word");
      const trigger = page.getByRole("button", { name: "Text style: Normal", exact: true });
      await (name === "phone" ? trigger.tap() : trigger.click());
      const item = page.getByRole("menuitemradio", { name: /^Heading 2/ });
      await (name === "phone" ? item.tap() : item.click());
      expect(await read(page)).toEqual({ doc: "## word here", anchor: 3, head: 7, hasFocus: true, activeInEditor: true });
      const updated = page.getByRole("button", { name: "Text style: H2", exact: true });
      await (name === "phone" ? updated.tap() : updated.click());
      expect(await page.getByRole("menuitemradio", { name: /^Heading 2/ }).getAttribute("aria-checked")).toBe("true");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Undo and Redo are visible only for touch, and restore the action", async () => {
    const page = await open(device);
    try {
      const undo = page.locator('.notebooks-editor-toolbar__history button[aria-label="Undo"]');
      const redo = page.locator('.notebooks-editor-toolbar__history button[aria-label="Redo"]');
      expect(await undo.isVisible()).toBe(name === "phone");
      expect(await redo.isVisible()).toBe(name === "phone");
      if (name === "phone") {
        await load(page, "word");
        await select(page, "word");
        await page.getByRole("button", { name: "Bold", exact: true }).tap();
        expect((await read(page)).doc).toBe("**word**");
        await undo.tap();
        expect((await read(page)).doc).toBe("word");
        await redo.tap();
        expect((await read(page)).doc).toBe("**word**");
        expect((await read(page)).activeInEditor).toBe(true);
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
