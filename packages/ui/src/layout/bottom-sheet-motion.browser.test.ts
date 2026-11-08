import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The sheet's motion is geometry over time; only a real engine shows what each frame paints.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "bottom-sheet-motion.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { BottomSheet, Button, bottomSheetOptions, bottomSheetAdaptiveOptions, dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.dismissed = 0;
window.openSheet = ({ detents = true, rows = 40 } = {}) => {
  void dialogCore.open((close, context) => {
    context.setDismissHandler(() => { window.dismissed += 1; close(); });
    return createComponent(BottomSheet, {
      detents,
      onDismiss: context.requestDismiss,
      get children() { return [
        createComponent(BottomSheet.Header, { title: "Move to" }),
        createComponent(BottomSheet.Body, { get children() {
          const list = document.createElement("div");
          list.dataset.list = "";
          for (let index = 0; index < rows; index++) {
            const row = document.createElement("button");
            row.type = "button";
            row.textContent = "Folder " + index;
            row.style.cssText = "display:block;width:100%;height:44px";
            list.append(row);
          }
          return list;
        } }),
        createComponent(BottomSheet.Footer, { get children() { return [
          createComponent(Button, { children: "Cancel", variant: "secondary", onClick: () => close() }),
          createComponent(Button, { children: "Move", onClick: () => close() }),
        ]; } }),
      ]; },
    });
  }, bottomSheetAdaptiveOptions);
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
};
// A menu sheet over the open sheet: the same dialog element shows the next level of the stack.
window.openChild = () => {
  void dialogCore.open((close, context) => createComponent(BottomSheet, {
    onDismiss: context.requestDismiss,
    get children() { return [
      createComponent(BottomSheet.Header, { title: "Sort by" }),
      createComponent(BottomSheet.Body, { get children() {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.child = "";
        button.textContent = "Name";
        button.onclick = () => close();
        return button;
      } }),
    ]; },
  }), bottomSheetOptions);
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sheet motion fixture.");
const script = await build.outputs[0]!.text();

type SheetWindow = Window & {
  openSheet: (options?: { detents?: boolean; rows?: number }) => Promise<void>;
  openChild: () => Promise<void>;
  dismissed: number;
};
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions = phone): Promise<Page> => {
  const page = await (await browser.newContext(options)).newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};

/** The sheet's place: its top on screen, its layout height, and the visible height above the bottom edge. */
const place = (page: Page) =>
  page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>("dialog[open]")!;
    const box = frame.getBoundingClientRect();
    const footer = frame.querySelector(".k2b-panel-dialog__footer")!.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      height: frame.offsetHeight,
      visible: Math.round(innerHeight - box.top),
      footerBottom: Math.round(footer.bottom),
      detent: frame.dataset.sheetDetent,
    };
  });

describe("BottomSheet motion on a phone", () => {
  for (const detents of [true, false])
    test(`opens with one fixed height and slides straight onto ${detents ? "half height" : "its content's height"}, frame by frame at 4x CPU slowdown`, async () => {
      const page = await open();
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Performance.enable");
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        // Sample every frame from the call on: layout height, painted top, and the transform the engine computed.
        // settled: the unsettled frames of the opening motion are the subject.
        await page.evaluate((detents) => {
          const samples: { height: number; top: number; translate: number }[] = [];
          Object.assign(window, { samples });
          const sample = () => {
            const frame = document.querySelector<HTMLElement>("dialog[open]");
            if (frame) {
              const matrix = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
              samples.push({ height: frame.offsetHeight, top: frame.getBoundingClientRect().top, translate: matrix.m42 });
            }
            if (samples.length < 120) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          void (window as unknown as SheetWindow).openSheet({ detents, rows: detents ? 40 : 6 });
        }, detents);
        const layoutCount = async () =>
          (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "LayoutCount")!.value;
        await page.waitForFunction(() => (window as unknown as { samples: unknown[] }).samples.length >= 3);
        const layoutsAfterOpen = await layoutCount();
        await page.waitForFunction(() =>
          document
            .getAnimations()
            .filter((animation) => animation.timeline === document.timeline)
            .every((animation) => animation.playState !== "running"),
        );
        const layoutsAfterMotion = await layoutCount();
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await settled(page);
        const samples = await page.evaluate(
          () => (window as unknown as { samples: { height: number; top: number; translate: number }[] }).samples,
        );
        const rest = await place(page);
        // The guard for "opens taller, then snaps smaller": one layout height in every frame.
        expect(new Set(samples.map((sample) => sample.height))).toEqual(new Set([rest.height]));
        // Monotonic: the sheet only rises, and never above its rest (no overshoot, no settle).
        for (let index = 1; index < samples.length; index++) expect(samples[index]!.top).toBeLessThanOrEqual(samples[index - 1]!.top);
        expect(Math.min(...samples.map((sample) => sample.top))).toBeGreaterThanOrEqual(rest.top - 0.5);
        // What is painted is what the transform says: no scrolling ancestor swallows the slide.
        const layoutTop = 844 - rest.height;
        for (const sample of samples) expect(Math.abs(sample.top - (layoutTop + sample.translate))).toBeLessThanOrEqual(0.5);
        expect(samples[0]!.top).toBeGreaterThan(rest.top);
        // The motion itself lays nothing out.
        expect(layoutsAfterMotion - layoutsAfterOpen).toBe(0);
        if (detents) expect(rest).toMatchObject({ visible: 422, detent: "half", footerBottom: 844 });
        else expect(rest).toMatchObject({ visible: rest.height, footerBottom: 844 });
      } finally {
        await cdp.detach();
        await page.context().close();
      }
    }, 60_000);

  test("the handle is a button: a press goes to full height, ArrowDown back to half, and the footer stays on the edge", async () => {
    const page = await open({ ...phone, reducedMotion: "reduce" });
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet());
      await settled(page);
      const handle = page.locator(".k2b-bottom-sheet__handle");
      expect(await handle.getAttribute("aria-label")).toBe("Expand to full height");
      await handle.focus();
      await page.keyboard.press("Enter");
      await settled(page);
      const full = await place(page);
      expect(full).toMatchObject({ visible: full.height, detent: "full", footerBottom: 844 });
      expect(await handle.getAttribute("aria-label")).toBe("Shrink to half height");
      await page.keyboard.press("ArrowDown");
      await settled(page);
      expect(await place(page)).toMatchObject({ visible: 422, detent: "half", footerBottom: 844 });
      // The wheel in the list at half height grows the sheet first.
      const list = (await page.locator("[data-list]").boundingBox())!;
      await page.mouse.move(list.x + 50, 600);
      await page.mouse.wheel(0, 120);
      await page.waitForFunction(() => document.querySelector<HTMLElement>("dialog[open]")?.dataset.sheetDetent === "full");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a drag on the handle follows the pointer; a slow release returns, a flick down closes", async () => {
    const page = await open({ ...phone, hasTouch: false, isMobile: false });
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet());
      await settled(page);
      const start = await place(page);
      const handle = (await page.locator(".k2b-bottom-sheet__handle").boundingBox())!;
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 60, { steps: 6 });
      await settled(page);
      // settled: the sheet follows the pointer while it is held.
      expect((await place(page)).top - start.top).toBe(60);
      // fixed wait: a pointer that rests carries no speed into the release.
      await page.waitForTimeout(150);
      await page.mouse.up();
      await settled(page);
      expect(await place(page)).toMatchObject({ top: start.top, detent: "half" });
      // A flick down closes through the owner's dismiss handler.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 120, { steps: 3 });
      await page.mouse.up();
      await page.waitForFunction(() => (window as unknown as SheetWindow).dismissed === 1 && !document.querySelector("dialog[open]"));
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a finger in a scrolled list scrolls it first; at its top, pulling down drags the sheet", async () => {
    const page = await open({ ...phone, reducedMotion: "reduce" });
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet());
      await settled(page);
      await page.locator(".k2b-bottom-sheet__handle").press("ArrowUp");
      await settled(page);
      const body = page.locator(".k2b-panel-dialog__body");
      await body.evaluate((element) => {
        element.scrollTop = 200;
      });
      const swipe = async (from: number, to: number) => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: from }] });
        for (let step = 1; step <= 6; step++)
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: from + ((to - from) * step) / 6 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const before = await place(page);
      await swipe(500, 600);
      await settled(page);
      expect(await body.evaluate((element) => element.scrollTop)).toBeLessThan(200);
      expect((await place(page)).top).toBe(before.top);
      await body.evaluate((element) => {
        element.scrollTop = 0;
      });
      // fixed wait: past the 100 ms in which a finger that just scrolled keeps scrolling.
      await page.waitForTimeout(150);
      await swipe(300, 600);
      await settled(page);
      // A slow pull past the middle between full and half height lands on half height.
      expect(await place(page)).toMatchObject({ visible: 422, detent: "half" });
    } finally {
      await cdp.detach();
      await page.context().close();
    }
  }, 30_000);

  test("a menu sheet over a sheet with detents keeps its own height, and the sheet below returns to half height", async () => {
    const page = await open({ ...phone, reducedMotion: "reduce" });
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet());
      await settled(page);
      await page.evaluate(() => (window as unknown as SheetWindow).openChild());
      await settled(page);
      const child = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>("dialog[open]")!;
        return {
          detents: frame.hasAttribute("data-sheet-detents"),
          visible: Math.round(innerHeight - frame.getBoundingClientRect().top),
          height: frame.offsetHeight,
        };
      });
      expect(child.detents).toBe(false);
      expect(child.visible).toBe(child.height);
      expect(child.height).toBeLessThan(300);
      await page.locator("[data-child]").click();
      await page.waitForFunction(() => !document.querySelector("[data-child]"));
      await settled(page);
      expect(await place(page)).toMatchObject({ visible: 422, detent: "half", footerBottom: 844 });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a quick pull that rests before the release returns instead of closing", async () => {
    const page = await open({ ...phone, hasTouch: false, isMobile: false });
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet({ detents: false, rows: 6 }));
      await settled(page);
      const start = await place(page);
      const handle = (await page.locator(".k2b-bottom-sheet__handle").boundingBox())!;
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 30, { steps: 1 });
      // fixed wait: longer than the 80 ms after which a resting pointer carries no speed.
      await page.waitForTimeout(200);
      await page.mouse.up();
      await settled(page);
      expect(await page.evaluate(() => (window as unknown as SheetWindow).dismissed)).toBe(0);
      expect((await place(page)).top).toBe(start.top);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("from 48rem an adaptive sheet opens as the centred dialog, without the sheet's slide", async () => {
    const page = await open({ viewport: { width: 1194, height: 834 } });
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet({ detents: true, rows: 6 }));
      // settled: the first frames of the opening are the subject.
      const motion = await page.evaluate(() =>
        document
          .querySelector("dialog[open]")!
          .getAnimations()
          .map((animation) => (animation instanceof CSSAnimation ? animation.animationName : "script")),
      );
      expect(motion).toEqual(["k2b-sheet-dialog-enter"]);
      await settled(page);
      const box = await page.evaluate(() => {
        const rect = document.querySelector("dialog[open]")!.getBoundingClientRect();
        return { centre: Math.round(rect.top + rect.height / 2), fitsContent: rect.height < 834 * 0.9 };
      });
      expect(Math.abs(box.centre - 417)).toBeLessThanOrEqual(1);
      expect(box.fitsContent).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("without detents the sheet rests at its content's height, and from 48rem it stays a centred dialog", async () => {
    const page = await open({ ...phone, reducedMotion: "reduce" });
    try {
      await page.evaluate(() => (window as unknown as SheetWindow).openSheet({ detents: false, rows: 3 }));
      await settled(page);
      const rest = await place(page);
      expect(rest.visible).toBe(rest.height);
      expect(rest.height).toBeLessThan(422);
      expect(await page.locator(".k2b-bottom-sheet__handle").getAttribute("aria-label")).toBe("Close");
      // No blur behind a sheet, only the dim.
      expect(await page.evaluate(() => getComputedStyle(document.querySelector("dialog[open]")!, "::backdrop").backdropFilter)).toBe(
        "none",
      );
      await page.setViewportSize({ width: 1194, height: 834 });
      await settled(page);
      const dialog = await page.evaluate(() => {
        const box = document.querySelector("dialog[open]")!.getBoundingClientRect();
        return {
          centre: Math.round(box.top + box.height / 2),
          filter: getComputedStyle(document.querySelector("dialog[open]")!, "::backdrop").backdropFilter,
        };
      });
      expect(Math.abs(dialog.centre - 417)).toBeLessThanOrEqual(1);
      expect(dialog.filter).toBe("blur(8px)");
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
