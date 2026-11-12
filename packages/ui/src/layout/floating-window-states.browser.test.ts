import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Minimize, maximize and the phone sheet are geometry and focus, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "floating-window-states.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { FloatingWindow } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const area = document.getElementById("area");
window.changes = [];
window.openWindow = (title, options = {}) => {
  const host = document.createElement("div");
  document.body.append(host);
  let dispose;
  dispose = render(() => createComponent(FloatingWindow, {
    title,
    status: "Saved",
    initialWidth: 520,
    initialHeight: 420,
    area: () => area,
    resolveScope: () => document.body,
    onClose: () => {
      dispose();
      host.remove();
    },
    onStateChange: (state) => window.changes.push([title, state]),
    ...options,
    get children() {
      const field = document.createElement("textarea");
      field.setAttribute("aria-label", title + " text");
      return field;
    },
  }), host);
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the floating window fixture.");
const script = await build.outputs[0]!.text();

declare global {
  interface Window {
    openWindow: (title: string, options?: Record<string, unknown>) => void;
    changes: [string, string][];
  }
}
type Box = { x: number; y: number; width: number; height: number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, height: number): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>body{margin:0}#area{position:fixed;inset:20px 20px 20px 80px;border-radius:12px}` +
      `#content{position:absolute;left:100px;top:60px;width:200px;height:40px}</style></head>` +
      `<body class="k2b-ui"><main id="area"><button id="content">Behind</button></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await settled(page);
  return page;
};
const frame = (page: Page, title: string) =>
  page.locator(".k2b-floating-window", { has: page.locator(".k2b-floating-window__title > span").getByText(title, { exact: true }) });
const box = async (page: Page, selector: string, title?: string): Promise<Box> => {
  const target = title ? frame(page, title) : page.locator(selector);
  const rect = await target.first().evaluate((element) => element.getBoundingClientRect().toJSON());
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
};
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "");

describe("@k2b/ui FloatingWindow states", () => {
  test("minimize keeps the content alive and restores the window to its place; minimized windows line up without overlap", async () => {
    const page = await open(1440, 900);
    try {
      const behind = await box(page, "#content");
      await page.evaluate(() => window.openWindow("Workbench order"));
      const field = page.getByLabel("Workbench order text");
      await field.fill("Oak, 2.4 m");
      await settled(page);
      const before = await box(page, "", "Workbench order");

      await frame(page, "Workbench order").getByRole("button", { name: "Minimize" }).click();
      await settled(page);
      const bar = await box(page, "", "Workbench order");
      expect(bar.height).toBe(42);
      expect(await field.count()).toBe(1);
      expect(await field.isVisible()).toBe(false);
      expect(await focusedLabel(page)).toBe("Restore Workbench order");
      expect(await frame(page, "Workbench order").getByRole("button", { name: "Minimize" }).count()).toBe(0);

      await page.getByRole("button", { name: "Restore Workbench order" }).click();
      await settled(page);
      expect(await box(page, "", "Workbench order")).toEqual(before);
      expect(await field.inputValue()).toBe("Oak, 2.4 m");
      expect(await focusedLabel(page)).toBe("Workbench order text");

      // Two docked windows and one minimized one share the bottom row of the area.
      await page.evaluate(() => {
        window.openWindow("Plane repair", { placement: "dock", defaultState: "minimized" });
        window.openWindow("Course plan", { placement: "dock", defaultState: "minimized" });
      });
      await frame(page, "Workbench order").getByRole("button", { name: "Minimize" }).click();
      await settled(page);
      const bars = await Promise.all(["Workbench order", "Plane repair", "Course plan"].map((title) => box(page, "", title)));
      const area = await box(page, "#area");
      const sorted = [...bars].sort((a, b) => b.x - a.x);
      expect(sorted[0]!.x + sorted[0]!.width).toBe(area.x + area.width - 16);
      for (const bar of bars) {
        expect(bar.height).toBe(42);
        expect(bar.y + bar.height).toBe(area.y + area.height - 12);
      }
      for (let index = 1; index < sorted.length; index += 1)
        expect(sorted[index]!.x + sorted[index]!.width).toBeLessThanOrEqual(sorted[index - 1]!.x);
      // The window that opened first stays at the end of the row.
      expect(bars[0]).toEqual(sorted[0]!);

      expect(await box(page, "#content")).toEqual(behind);
      expect(await page.evaluate(() => window.changes)).toEqual([
        ["Workbench order", "minimized"],
        ["Workbench order", "normal"],
        ["Workbench order", "minimized"],
      ]);
    } finally {
      await page.close();
    }
  });

  test("maximize dims the area, keeps Tab inside, and Escape restores the window with the focus inside", async () => {
    const page = await open(1440, 900);
    try {
      const behind = await box(page, "#content");
      await page.evaluate(() => window.openWindow("Oak planks"));
      await settled(page);
      const before = await box(page, "", "Oak planks");
      const window_ = frame(page, "Oak planks");

      await window_.getByRole("button", { name: "Maximize" }).click();
      await settled(page);
      const area = await box(page, "#area");
      expect(await box(page, ".k2b-floating-window-scrim")).toEqual(area);
      const maximized = await box(page, "", "Oak planks");
      expect(maximized.x - area.x).toBe(Math.max(24, Math.round(area.width * 0.05)));
      expect(maximized.y - area.y).toBe(24);
      expect(maximized.width).toBe(area.width - 2 * (maximized.x - area.x));
      expect(await window_.getAttribute("aria-modal")).toBe("true");
      expect(await focusedLabel(page)).toBe("Restore size");

      for (let step = 0; step < 6; step += 1) {
        await page.keyboard.press("Tab");
        expect(await window_.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      await page.getByLabel("Oak planks text").focus();
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await box(page, "", "Oak planks")).toEqual(before);
      expect(await page.locator(".k2b-floating-window-scrim").count()).toBe(0);
      expect(await window_.getAttribute("aria-modal")).toBe("false");
      expect(await focusedLabel(page)).toBe("Oak planks text");

      // The button restores too and keeps the focus on itself.
      await window_.getByRole("button", { name: "Maximize" }).click();
      await window_.getByRole("button", { name: "Restore size" }).click();
      await settled(page);
      expect(await box(page, "", "Oak planks")).toEqual(before);
      expect(await focusedLabel(page)).toBe("Maximize");

      // A click on the scrim restores as well.
      await window_.getByRole("button", { name: "Maximize" }).click();
      await page.mouse.click(area.x + 4, area.y + area.height / 2);
      await settled(page);
      expect(await box(page, "", "Oak planks")).toEqual(before);
      expect(await box(page, "#content")).toEqual(behind);
    } finally {
      await page.close();
    }
  });

  test("on a phone the window is a full-screen sheet with only the close control", async () => {
    const page = await open(390, 844);
    try {
      await page.evaluate(() => window.openWindow("New message with a very long subject that does not fit"));
      await settled(page);
      const sheet = frame(page, "New message with a very long subject that does not fit");
      expect(await box(page, "", "New message with a very long subject that does not fit")).toEqual({
        x: 0,
        y: 0,
        width: 390,
        height: 844,
      });
      expect(await sheet.getByRole("button", { name: "Minimize" }).count()).toBe(0);
      expect(await sheet.getByRole("button", { name: "Maximize" }).count()).toBe(0);
      expect(await sheet.getByRole("button", { name: "Close window" }).count()).toBe(1);
      expect(await sheet.getAttribute("aria-modal")).toBe("true");
      // The title stays on one line.
      const title = await sheet.locator(".k2b-floating-window__title > span").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        cut: element.scrollWidth > element.clientWidth,
      }));
      expect(title.cut).toBe(true);
      expect(title.height).toBeLessThan(24);
      await sheet.getByLabel("New message with a very long subject that does not fit text").focus();
      await page.keyboard.press("Escape");
      expect(await page.locator(".k2b-floating-window").count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
