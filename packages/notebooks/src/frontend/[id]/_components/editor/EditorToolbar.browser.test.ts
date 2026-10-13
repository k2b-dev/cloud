import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, type Page, devices as playwrightDevices } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import type { ToolbarHarness } from "./EditorToolbar.browser-harness";

const indentLabel = "Indent (Ctrl/⌘+])";
const outdentLabel = "Outdent (Ctrl/⌘+[)";
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
  phone,
};

const open = async (device: BrowserContextOptions) => {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  await page.goto(server.url.href);
  await page.waitForFunction(() => "harness" in window);
  return page;
};

const load = (page: Page, doc: string) =>
  page.evaluate(async (doc) => {
    const harness = (window as unknown as { harness: ToolbarHarness }).harness;
    harness.loadDocument(doc);
    await harness.settle();
  }, doc);

const caret = (page: Page, text: string, offset = 3) =>
  page.evaluate(
    async ({ text, offset }) => {
      const harness = (window as unknown as { harness: ToolbarHarness }).harness;
      harness.placeCaret(text, offset);
      await harness.settle();
    },
    { text, offset },
  );

const read = (page: Page) =>
  page.evaluate(async () => {
    const harness = (window as unknown as { harness: ToolbarHarness }).harness;
    await harness.settle();
    const content = document.querySelector(".cm-content");
    return { ...harness.read(), activeInEditor: content !== null && content.contains(document.activeElement) };
  });

const select = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const harness = (window as unknown as { harness: ToolbarHarness }).harness;
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
      const paragraph = await layout(page);
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

// The device preset (393 or 412 px wide) and the 390 px phone width the layout targets.
test.each([
  ["preset", phone],
  ["390px", { ...phone, viewport: { width: 390, height: 844 } }],
] as const)(
  "phone (%s): Indent and Outdent fit inside the viewport and visible toolbar scrollport without scrolling",
  async (_, device) => {
    const page = await open(device);
    try {
      await load(page, original);
      await caret(page, "Charger");
      // Measure before any tap: Playwright must not reveal an off-screen button by scrolling to it.
      const bounds = await page.locator(".notebooks-editor-toolbar").evaluate(
        (toolbar, labels) => {
          const scroll = toolbar.querySelector<HTMLElement>(".overflow-x-auto")!;
          const rect = scroll.getBoundingClientRect();
          const visible = {
            left: rect.left + scroll.clientLeft,
            top: rect.top + scroll.clientTop,
            width: scroll.clientWidth,
            height: scroll.clientHeight,
          };
          return {
            viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
            toolbar: toolbar.getBoundingClientRect().toJSON(),
            visible,
            scrollLeft: scroll.scrollLeft,
            buttons: labels.map((label) => {
              const button = Array.from(toolbar.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === label);
              if (!button) throw new Error(`Missing toolbar button: ${label}`);
              return { label, box: button.getBoundingClientRect().toJSON() };
            }),
          };
        },
        [outdentLabel, indentLabel],
      );
      expect(bounds.scrollLeft).toBe(0);
      for (const { label, box } of bounds.buttons) {
        expect(await page.getByRole("button", { name: label, exact: true }).isVisible()).toBe(true);
        const diagnostic = `${label}: ${JSON.stringify(bounds)}`;
        expect(box.width, diagnostic).toBeGreaterThan(0);
        expect(box.height, diagnostic).toBeGreaterThan(0);
        expect(box.left, diagnostic).toBeGreaterThanOrEqual(0);
        expect(box.top, diagnostic).toBeGreaterThanOrEqual(0);
        expect(box.right, diagnostic).toBeLessThanOrEqual(bounds.viewport.width);
        expect(box.bottom, diagnostic).toBeLessThanOrEqual(bounds.viewport.height);
        expect(box.left, diagnostic).toBeGreaterThanOrEqual(bounds.visible.left);
        expect(box.top, diagnostic).toBeGreaterThanOrEqual(bounds.visible.top);
        expect(box.right, diagnostic).toBeLessThanOrEqual(bounds.visible.left + bounds.visible.width);
        expect(box.bottom, diagnostic).toBeLessThanOrEqual(bounds.visible.top + bounds.visible.height);
      }
    } finally {
      await page.context().close();
    }
  },
  30_000,
);

describe.each(Object.entries(devices))("editor toolbar list kinds (%s)", (name, device) => {
  test("the insert menu converts the selected lines instead of stacking prefixes, keeping focus and the caret", async () => {
    const page = await open(device);
    try {
      await load(page, "- Pack\n  - Charger");
      await page.evaluate(async () => {
        const harness = (window as unknown as { harness: ToolbarHarness }).harness;
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
        const trigger = page.getByRole("button", { name: "Insert content", exact: true });
        await (name === "phone" ? trigger.tap() : trigger.click());
        const item = page.getByRole("menuitem", { name: new RegExp(`^${label}`) });
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

  test("Insert content keeps focus on pointer down and inserts an Info callout at the caret line", async () => {
    const page = await open(device);
    try {
      await load(page, "First line\nLast line");
      await caret(page, "First", 2);
      await pressKeepingFocus(page, "Insert content");
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
