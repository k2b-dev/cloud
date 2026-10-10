import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// A mouse drag on a resize handle sweeps across page text. Whether the engine
// starts a native text selection under it depends on the engine: WebKit, the
// engine of every iPadOS browser, ignores the unprefixed `user-select`. A real
// engine therefore runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "drag-selection.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, PullToRefresh, suppressTextSelection } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.suppressTextSelection = suppressTextSelection;
window.refreshes = 0;

render(
  () =>
    createComponent(AppWorkspace, {
      get children() {
        return [
          createComponent(AppWorkspace.Sidebar, {
            id: "navigation",
            label: "Navigation",
            get children() {
              return createComponent(AppWorkspace.SidebarDesktop, {
                get children() {
                  return createComponent(AppWorkspace.SidebarItem, { href: "#private", children: "Private folder" });
                },
              });
            },
          }),
          createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, {
                get children() {
                  const text = document.createElement("p");
                  text.id = "text";
                  text.textContent = "Quarterly planning notes. ".repeat(80);
                  return text;
                },
              });
            },
          }),
        ];
      },
    }),
  document.getElementById("app"),
);

render(
  () =>
    createComponent(PullToRefresh, {
      onRefresh: async () => {
        window.refreshes += 1;
      },
      get children() {
        const port = document.createElement("div");
        port.style.cssText = "height:100%;overflow:auto";
        const text = document.createElement("p");
        text.id = "pull-text";
        text.style.margin = "0";
        text.textContent = "Inbox conversation preview. ".repeat(40);
        port.append(text);
        return port;
      },
    }),
  document.getElementById("pull"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the drag selection fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div>` +
      `<div id="pull" style="display:grid;height:8rem"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#text").waitFor();
  await page.locator("#pull-text").waitFor();
  return page;
};

const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");
const inlineStyles = (page: Page) => page.evaluate(() => [document.documentElement.style.cssText, document.body.style.cssText]);

/**
 * What the page offers a text selection under the pointer. iPadOS starts a
 * mouse or trackpad selection through the system's text interaction, which a
 * prevented `pointerdown` does not stop and which no desktop engine runs. It
 * follows `-webkit-user-select` and `selectstart`, and a selection the platform
 * makes anyway, here made by the page, must not survive the drag's next move.
 */
const selectionUnderDrag = (page: Page) =>
  page.evaluate(() => {
    const text = document.getElementById("text")!;
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    text.dispatchEvent(selectStart);
    window.getSelection()?.selectAllChildren(text);
    return {
      webkitUserSelect: getComputedStyle(text).getPropertyValue("-webkit-user-select"),
      selectStartCancelled: selectStart.defaultPrevented,
    };
  });
// Engines hide the text of a selection in unselectable content, so the ranges themselves must be gone.
const selectionCollapsed = (page: Page) => page.evaluate(() => window.getSelection()?.isCollapsed ?? true);

describe("workspace resize drag", () => {
  test("a mouse drag on the sidebar handle across page text selects no text and restores the page", async () => {
    const page = await load();
    try {
      const before = await inlineStyles(page);
      // The handle itself never starts a selection, however early the platform resolves the gesture.
      const handleUserSelect = await page
        .locator('[data-app-workspace-resize="sidebar"]')
        .evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-user-select"));
      expect(handleUserSelect).toBe("none");
      const handle = await page.locator('[data-app-workspace-resize="sidebar"]').boundingBox();
      const text = await page.locator("#text").boundingBox();
      const y = text!.y + 10;
      await page.mouse.move(handle!.x + handle!.width / 2, y);
      await page.mouse.down();
      // Across the text, then back so the sidebar keeps a usable width.
      await page.mouse.move(text!.x + text!.width - 20, text!.y + text!.height - 10, { steps: 12 });
      expect(await selectedText(page)).toBe("");
      expect(await selectionUnderDrag(page)).toEqual({ webkitUserSelect: "none", selectStartCancelled: true });
      await page.mouse.move(text!.x + text!.width - 40, text!.y + text!.height - 10);
      expect(await selectionCollapsed(page)).toBe(true);
      await page.mouse.move(handle!.x + 40, y, { steps: 6 });
      await page.mouse.up();
      expect(await selectedText(page)).toBe("");
      expect(await inlineStyles(page)).toEqual(before);
    } finally {
      await page.close();
    }
  });

  test("outside a drag, a mouse drag across the text still selects it", async () => {
    const page = await load();
    try {
      const text = await page.locator("#text").boundingBox();
      await page.mouse.move(text!.x + 40, text!.y + 6);
      await page.mouse.down();
      await page.mouse.move(text!.x + text!.width / 2, text!.y + text!.height / 2, { steps: 8 });
      await page.mouse.up();
      expect((await selectedText(page)).length).toBeGreaterThan(20);
      const selectStart = await page.evaluate(() => {
        const event = new Event("selectstart", { bubbles: true, cancelable: true });
        document.getElementById("text")!.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(selectStart).toBe(false);
    } finally {
      await page.close();
    }
  });
});

describe("pull to refresh", () => {
  test("a text selection released outside the list survives a hover back over it", async () => {
    const page = await load();
    try {
      const before = await inlineStyles(page);
      const text = await page.locator("#pull-text").boundingBox();
      const start = { x: text!.x + text!.width / 2, y: text!.y + 30 };
      // Select upward out of the list and release above it, where the list hears no pointerup.
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x, text!.y - 60, { steps: 8 });
      await page.mouse.up();
      const selected = (await selectedText(page)).length;
      expect(selected).toBeGreaterThan(20);
      // Hovering below the start point without a pressed button is no pull.
      await page.mouse.move(start.x, start.y + 60, { steps: 8 });
      expect((await selectedText(page)).length).toBe(selected);
      expect(await inlineStyles(page)).toEqual(before);
      expect(await page.locator(".k2b-pull-to-refresh").getAttribute("data-state")).toBe("idle");
      const selectStart = await page.evaluate(() => {
        const event = new Event("selectstart", { bubbles: true, cancelable: true });
        document.getElementById("pull-text")!.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(selectStart).toBe(false);
      await page.mouse.down();
      await page.mouse.up();
      expect(await page.evaluate(() => (window as unknown as { refreshes: number }).refreshes)).toBe(0);
    } finally {
      await page.close();
    }
  });
});

type Fixture = { suppressTextSelection: (pointerId: number) => () => void };

describe("suppressTextSelection", () => {
  test("overlapping holds share one suppression and the last release restores the inline styles exactly", async () => {
    const page = await load();
    try {
      const state = await page.evaluate(() => {
        const { suppressTextSelection } = window as unknown as Fixture;
        const root = document.documentElement;
        root.style.setProperty("user-select", "text");
        const before = root.style.cssText;
        const text = document.getElementById("text")!;
        const webkitUserSelect = () => getComputedStyle(text).getPropertyValue("-webkit-user-select");
        const first = suppressTextSelection(1);
        const second = suppressTextSelection(2);
        const both = webkitUserSelect();
        first();
        first();
        const one = webkitUserSelect();
        second();
        return { both, one, after: webkitUserSelect(), restored: root.style.cssText === before };
      });
      expect(state).toEqual({ both: "none", one: "none", after: "text", restored: true });
    } finally {
      await page.close();
    }
  });

  test("the pointer's pointerup or pointercancel and a window blur end a hold", async () => {
    const page = await load();
    try {
      const state = await page.evaluate(() => {
        const { suppressTextSelection } = window as unknown as Fixture;
        const suppressed = () => {
          const event = new Event("selectstart", { bubbles: true, cancelable: true });
          document.getElementById("text")!.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const end = (type: string, pointerId: number) => window.dispatchEvent(new PointerEvent(type, { pointerId }));
        suppressTextSelection(7);
        end("pointerup", 8);
        const otherPointer = suppressed();
        end("pointerup", 7);
        const afterUp = suppressed();
        suppressTextSelection(7);
        end("pointercancel", 7);
        const afterCancel = suppressed();
        suppressTextSelection(7);
        suppressTextSelection(9);
        window.dispatchEvent(new Event("blur"));
        return { otherPointer, afterUp, afterCancel, afterBlur: suppressed() };
      });
      expect(state).toEqual({ otherPointer: true, afterUp: false, afterCancel: false, afterBlur: false });
    } finally {
      await page.close();
    }
  });

  test("a selection from before the press stays, one made during the hold goes", async () => {
    const page = await load();
    try {
      const text = await page.locator("#text").boundingBox();
      // A real press marks the selection it found.
      await page.evaluate(() => {
        const range = document.createRange();
        range.setStart(document.getElementById("text")!.firstChild!, 0);
        range.setEnd(document.getElementById("text")!.firstChild!, 9);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        document.getElementById("text")!.addEventListener("pointerdown", (event) => event.preventDefault(), { once: true });
      });
      await page.mouse.move(text!.x + 40, text!.y + 6);
      await page.mouse.down();
      const kept = await page.evaluate(async () => {
        const release = (window as unknown as Fixture).suppressTextSelection(1);
        await new Promise((settle) => setTimeout(settle, 50));
        release();
        return window.getSelection()!.toString();
      });
      await page.mouse.up();
      expect(kept).toBe("Quarterly");

      const cleared = await page.evaluate(async () => {
        const release = (window as unknown as Fixture).suppressTextSelection(1);
        window.getSelection()!.selectAllChildren(document.getElementById("text")!);
        await new Promise((settle) => setTimeout(settle, 50));
        release();
        return window.getSelection()!.toString();
      });
      expect(cleared).toBe("");
    } finally {
      await page.close();
    }
  });
});
