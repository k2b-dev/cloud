import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Scrolling, touch-action, the toast rail's place, and the room a persistent toast takes are layout results, which
// happy-dom does not model, so a real engine runs the built package at phone size.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "mobile-shell.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { dialogCore, MobileShell, TabBar, TextInput, toast } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};

const rows = () => Array.from({ length: 40 }, (_, index) => {
  const row = document.createElement("p");
  row.className = "row";
  row.style.cssText = "margin:0;height:48px";
  row.textContent = "Task " + (index + 1);
  return row;
});
render(
  () =>
    createComponent(MobileShell, {
      get header() {
        return createComponent(MobileShell.Header, { title: "Tasks" });
      },
      get footer() {
        return createComponent(TabBar, {
          label: "App",
          items: [
            { id: "start", label: "Start", icon: "ti ti-home", href: "#start", current: true },
            { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "#tasks" },
          ],
        });
      },
      get children() {
        return [createComponent(TextInput, { label: "Search", value: () => "", onValueChange: () => {} }), ...rows()];
      },
    }),
  document.getElementById("root"),
);
window.ui = { toast, dialogCore };
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the MobileShell fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type ToastHandle = {
  dismiss: () => void;
  update: (text: string, options?: { progress?: number | null; duration?: number }) => void;
};
type Ui = {
  toast: ((text: string, options?: { duration?: number; progress?: number | "indeterminate" | null }) => ToastHandle) & {
    dismissAll: () => void;
    custom: (content: HTMLElement) => { dismiss: () => void };
  };
  /** A toast a test keeps between two `page.evaluate` calls. */
  kept?: ToastHandle;
  dialogCore: { open: (view: () => Node) => Promise<unknown>; close: () => void };
};
declare const ui: Ui;

const open = async (): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-tab-bar").waitFor();
  return page;
};

const geometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
    return {
      footerTop: rect(".k2b-tab-bar")!.top,
      footerHeight: getComputedStyle(document.body).getPropertyValue("--k2b-mobile-shell-footer-height"),
      inset: getComputedStyle(document.querySelector(".k2b-mobile-shell")!).getPropertyValue("--k2b-mobile-shell-toast-inset"),
      bodyBottom: body.getBoundingClientRect().bottom,
      cards: [...document.querySelectorAll("[data-k2b-toast-container] [data-k2b-toast]:not([data-closing])")].map((card) => {
        const box = card.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }),
    };
  });

/** Scrolls the content to its end and reports where the last row ends. */
const lastRowBottom = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
    body.scrollTop = body.scrollHeight;
    return [...document.querySelectorAll(".row")].at(-1)!.getBoundingClientRect().bottom;
  });

describe("MobileShell in a phone browser", () => {
  test("only the content scrolls; the page, the header, and the tab bar stay put", async () => {
    const page = await open();
    try {
      const layout = await page.evaluate(() => {
        let topEdge: string | null = null;
        for (let element = document.elementFromPoint(innerWidth / 2, 4); element && !topEdge; element = element.parentElement) {
          const { position } = getComputedStyle(element);
          if (position === "fixed" || position === "sticky") topEdge = element.className;
        }
        const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
        return {
          html: [getComputedStyle(document.documentElement).overflow, getComputedStyle(document.documentElement).overscrollBehavior],
          page: [getComputedStyle(document.body).overflow, getComputedStyle(document.body).overscrollBehavior],
          documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
          contentScrolls: body.scrollHeight > body.clientHeight,
          root: getComputedStyle(document.querySelector(".k2b-mobile-shell")!).position,
          tabBar: getComputedStyle(document.querySelector(".k2b-tab-bar")!).position,
          tabBarBottom: document.querySelector(".k2b-tab-bar")!.getBoundingClientRect().bottom,
          topEdge,
        };
      });
      expect(layout).toEqual({
        html: ["hidden", "none"],
        page: ["hidden", "none"],
        documentScrolls: false,
        contentScrolls: true,
        root: "absolute",
        tabBar: "static",
        tabBarBottom: 844,
        topEdge: null,
      });
    } finally {
      await page.context().close();
    }
  });

  test("turns off pinch zoom in content and dialogs, and keeps fields at 16 px", async () => {
    const page = await open();
    try {
      await page.evaluate(() => {
        void ui.dialogCore.open(() => {
          const button = document.createElement("button");
          button.textContent = "Inside";
          return button;
        });
      });
      await page.locator("dialog").waitFor();
      const touch = await page.evaluate(() => {
        // An application's own single-class rule claims a gesture, as a drag handle does.
        const style = document.createElement("style");
        style.textContent = ".grip { touch-action: none; }";
        document.head.append(style);
        const grip = document.createElement("span");
        grip.className = "grip";
        document.querySelector(".k2b-mobile-shell__body")!.append(grip);
        return {
          row: getComputedStyle(document.querySelector(".row")!).touchAction,
          dialog: getComputedStyle(document.querySelector("dialog button")!).touchAction,
          grip: getComputedStyle(grip).touchAction,
          input: getComputedStyle(document.querySelector("input")!).fontSize,
        };
      });
      expect(touch).toEqual({ row: "pan-x pan-y", dialog: "pan-x pan-y", grip: "none", input: "16px" });
    } finally {
      await page.context().close();
    }
  });

  test("toasts sit above the tab bar, and a persistent toast keeps the last row reachable", async () => {
    const page = await open();
    try {
      const before = await geometry(page);
      const footer = await page.locator(".k2b-tab-bar").boundingBox();
      expect(before.footerHeight).toBe(`${footer!.height}px`);
      const free = await lastRowBottom(page);
      expect(free).toBeLessThanOrEqual(before.footerTop);

      await page.evaluate(() => void ui.toast("Saved"));
      await page.waitForTimeout(400);
      const timed = await geometry(page);
      expect(timed.cards).toHaveLength(1);
      expect(timed.cards[0]!.bottom).toBeLessThanOrEqual(timed.footerTop);
      expect(timed.cards[0]!.bottom).toBeGreaterThan(timed.footerTop - 48);
      expect(timed.inset).toBe("0px");

      await page.evaluate(() => void ui.toast("You're offline", { duration: 0 }));
      await page.waitForTimeout(400);
      const sticky = await geometry(page);
      const covered = Math.min(...sticky.cards.map((card) => card.top));
      expect(Number.parseFloat(sticky.inset)).toBeCloseTo(sticky.bodyBottom - covered, 0);
      expect(await lastRowBottom(page)).toBeLessThanOrEqual(covered + 1);

      await page.evaluate(() => ui.toast.dismissAll());
      await page.waitForTimeout(400);
      expect((await geometry(page)).inset).toBe("0px");
    } finally {
      await page.context().close();
    }
  });

  test("running progress and a custom slot keep the last row reachable too", async () => {
    const page = await open();
    try {
      await page.evaluate(() => {
        ui.kept = ui.toast("Uploading", { progress: "indeterminate" });
      });
      await page.waitForTimeout(400);
      const running = await geometry(page);
      const covered = Math.min(...running.cards.map((card) => card.top));
      expect(Number.parseFloat(running.inset)).toBeCloseTo(running.bodyBottom - covered, 0);
      expect(await lastRowBottom(page)).toBeLessThanOrEqual(covered + 1);

      // Ending the progress gives the toast its timer back, so it no longer pads the content.
      await page.evaluate(() => ui.kept?.update("Uploaded", { progress: null, duration: 60_000 }));
      await page.waitForTimeout(400);
      expect((await geometry(page)).inset).toBe("0px");
      await page.evaluate(() => ui.toast.dismissAll());
      await page.waitForTimeout(400);

      await page.evaluate(() => {
        const panel = document.createElement("div");
        panel.style.height = "120px";
        panel.textContent = "3 files";
        ui.toast.custom(panel);
      });
      await page.waitForTimeout(400);
      const custom = await geometry(page);
      const panelTop = Math.min(...custom.cards.map((card) => card.top));
      expect(Number.parseFloat(custom.inset)).toBeCloseTo(custom.bodyBottom - panelTop, 0);
      expect(await lastRowBottom(page)).toBeLessThanOrEqual(panelTop + 1);
    } finally {
      await page.context().close();
    }
  });

  test("a modal dialog takes the bottom edge back, so toasts move to the top", async () => {
    const page = await open();
    try {
      await page.evaluate(() => void ui.dialogCore.open(() => document.createTextNode("Dialog")));
      await page.locator("dialog").waitFor();
      await page.evaluate(() => void ui.toast("Link copied", { duration: 0 }));
      await page.waitForTimeout(400);
      const { cards, inset } = await geometry(page);
      expect(cards[0]!.top).toBeLessThan(100);
      expect(inset).toBe("0px");
    } finally {
      await page.context().close();
    }
  });
});
