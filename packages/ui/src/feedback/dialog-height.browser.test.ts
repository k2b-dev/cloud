import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// An open dialog follows its content's height: the frame folds from the height the eye sees to the new one, its top
// edge stays, and new content fades in. Heights over time need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dialog-height.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { BottomSheet, bottomSheetOptions, dialogCore, PanelDialog, panelDialogFixedOptions, panelDialogOptions } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.openSheet = () => void dialogCore.open(() => createComponent(BottomSheet, { get children() { return [
  createComponent(BottomSheet.Header, { title: "Filter" }),
  createComponent(BottomSheet.Body, { get children() {
    const body = document.createElement("div");
    body.dataset.content = "";
    body.textContent = "Status";
    return body;
  } }),
]; } }), bottomSheetOptions);
window.openForm = (fixed = false) => void dialogCore.open((close, context) => {
  window.placeAt = (x, y) => context.setPosition({ x, y });
  return createComponent(PanelDialog, { get children() { return [
  createComponent(PanelDialog.Header, { title: "Edit project", close: () => close() }),
  createComponent(PanelDialog.Body, { get children() {
    const body = document.createElement("div");
    body.dataset.content = "";
    body.innerHTML = "<label>Name <input aria-label='Name' value='Summer fest'></label>";
    return body;
  } }),
  createComponent(PanelDialog.Footer, { get children() {
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    return save;
  } }),
]; } });
}, fixed ? panelDialogFixedOptions : panelDialogOptions);
/** A notice of this many lines below the field, as a failed save adds one. */
window.addNotice = (lines = 3) => {
  const notice = document.createElement("p");
  notice.dataset.notice = "";
  notice.style.margin = "0";
  notice.style.lineHeight = "20px";
  notice.textContent = "Not saved. ".repeat(lines * 8);
  notice.style.height = lines * 20 + "px";
  notice.style.overflow = "hidden";
  document.querySelector("[data-content]").append(notice);
};
window.removeNotices = () => { for (const notice of document.querySelectorAll("[data-notice]")) notice.remove(); };
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog height fixture for the browser.");
const script = await build.outputs[0]!.text();

type HeightWindow = Window & {
  openForm: (fixed?: boolean) => void;
  openSheet: () => void;
  placeAt: (x: number, y: number) => void;
  addNotice: (lines?: number) => void;
  removeNotices: () => void;
};
type Sample = { top: number; bottom: number; height: number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

const load = async (options: BrowserContextOptions = desktop, fixed = false): Promise<Page> => {
  const page = await (await browser.newContext(options)).newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.evaluate((fixed) => (window as unknown as HeightWindow).openForm(fixed), fixed);
  await settle(page);
  return page;
};

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.timeline === document.timeline)
      .every((animation) => animation.playState !== "running"),
  );

/** Runs a change and samples the frame every frame until it rests. */
const watch = (page: Page, change: "add" | "remove", lines = 3) =>
  page.evaluate(
    ([change, lines]) =>
      new Promise<{ before: Sample; samples: Sample[]; frameMotion: number; noticeFade: string | null }>((resolve) => {
        const motion = window as unknown as HeightWindow;
        const dialog = document.querySelector("dialog")!;
        // A fold is the frame's own animation of its height; a sheet's slide or the dialog's rise is none.
        const folds = () =>
          dialog.getAnimations().filter((animation) => {
            const effect = animation.effect;
            return effect instanceof KeyframeEffect && effect.getKeyframes().some((keyframe) => "height" in keyframe);
          });
        const box = (): Sample => {
          const rect = dialog.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        };
        const before = box();
        if (change === "remove") motion.removeNotices();
        else motion.addNotice(Number(lines));
        // The frame measures itself after layout and before the paint of this frame; read in the frame after it.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const frameMotion = folds().length;
            // The notice's fade starts at 0 after a delay, read from the animation itself rather than at some moment.
            const notice = dialog.querySelector<HTMLElement>("[data-notice]");
            const fade = notice?.getAnimations()[0]?.effect;
            const noticeFade =
              fade instanceof KeyframeEffect
                ? `${fade.getKeyframes()[0]?.opacity} after ${Number(fade.getTiming().delay) > 0 ? "a delay" : "none"}`
                : null;
            const samples: Sample[] = [box()];
            let still = 0;
            const sample = () => {
              samples.push(box());
              // Done after two frames in a row without motion: a change may start a new fold in the frame after another ended.
              const moving = dialog
                .getAnimations()
                .some((animation) => animation.timeline === document.timeline && animation.playState === "running");
              still = moving ? 0 : still + 1;
              if (still < 2) requestAnimationFrame(sample);
              else resolve({ before, samples, frameMotion, noticeFade });
            };
            requestAnimationFrame(sample);
          }),
        );
      }),
    [change, lines] as const,
  );

describe(`${browserName} the frame follows its content`, () => {
  test("a notice grows the frame downwards; its top edge stays and the notice fades in", async () => {
    const page = await load();
    try {
      const grow = await watch(page, "add");
      expect(grow.frameMotion).toBeGreaterThan(0);
      expect(grow.noticeFade).toBe("0 after a delay");
      // The eye sees heights between the old and the new one.
      expect(grow.samples.some((sample) => sample.height > grow.before.height + 1 && sample.height < grow.before.height + 59)).toBe(true);
      for (const sample of grow.samples) expect(Math.abs(sample.top - grow.before.top)).toBeLessThan(1);
      const heights = grow.samples.map((sample) => sample.height);
      for (const [index, height] of heights.entries())
        expect(height).toBeGreaterThanOrEqual((heights[index - 1] ?? grow.before.height) - 0.5);
      expect(heights.at(-1)! - grow.before.height).toBeCloseTo(60, 0);

      const shrink = await watch(page, "remove");
      for (const sample of shrink.samples) expect(Math.abs(sample.top - grow.before.top)).toBeLessThan(1);
      expect(shrink.samples.at(-1)!.height).toBeCloseTo(grow.before.height, 0);
    } finally {
      await page.context().close();
    }
  });

  test("a change during the motion continues from where the frame is", async () => {
    const page = await load();
    try {
      // settled: the frame's heights while the folds run are the subject.
      const twice = await page.evaluate(
        () =>
          new Promise<{ before: number; mid: number; heights: number[] }>((resolve) => {
            const motion = window as unknown as HeightWindow;
            const dialog = document.querySelector("dialog")!;
            const before = dialog.getBoundingClientRect().height;
            let mid = 0;
            // Registered after the frame's own observer, so it runs in the same step, right after the fold started: the
            // second notice arrives halfway through the fold however late the next frames come.
            const halfway = new ResizeObserver(() => {
              const fold = dialog
                .getAnimations()
                .find(
                  (animation) =>
                    animation.timeline === document.timeline &&
                    animation.effect instanceof KeyframeEffect &&
                    animation.effect.getKeyframes().some((keyframe) => "height" in keyframe),
                );
              if (!fold || mid) return;
              halfway.disconnect();
              fold.pause();
              fold.currentTime = Number(fold.effect?.getComputedTiming().endTime) / 2;
              mid = dialog.getBoundingClientRect().height;
              motion.addNotice();
              fold.play();
              const heights: number[] = [];
              let still = 0;
              const sample = () => {
                heights.push(dialog.getBoundingClientRect().height);
                const moving = dialog
                  .getAnimations()
                  .some((animation) => animation.timeline === document.timeline && animation.playState === "running");
                still = moving ? 0 : still + 1;
                if (still < 2) requestAnimationFrame(sample);
                else resolve({ before, mid, heights });
              };
              requestAnimationFrame(sample);
            });
            halfway.observe(dialog.querySelector("[data-content]")!);
            motion.addNotice();
          }),
      );
      // The first fold was halfway when the second notice came; the frame went on from there, never jumping.
      expect(twice.mid).toBeGreaterThan(twice.before + 1);
      expect(twice.mid).toBeLessThan(twice.before + 59);
      for (const [index, height] of twice.heights.entries())
        expect(height).toBeGreaterThanOrEqual((twice.heights[index - 1] ?? twice.mid) - 0.5);
      expect(twice.heights.at(-1)! - twice.before).toBeCloseTo(120, 0);
    } finally {
      await page.context().close();
    }
  });

  test("the frame moves up only when the room below runs out, and then stands still at its largest height", async () => {
    const page = await load({ viewport: { width: 1280, height: 560 } });
    try {
      const tall = await watch(page, "add", 30);
      const room = 560;
      for (const sample of tall.samples) expect(sample.bottom).toBeLessThanOrEqual(room + 0.5);
      const capped = await watch(page, "add", 10);
      // At its largest height the body scrolls and the frame does not move.
      expect(capped.frameMotion).toBe(0);
      expect(capped.samples.at(-1)!.height).toBeCloseTo(capped.before.height, 0);
      const scrolls = await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>(".k2b-panel-dialog__body")!;
        return body.scrollHeight > body.clientHeight;
      });
      expect(scrolls).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  test("a fold cut off just before its end keeps the top edge where the eye sees it", async () => {
    const page = await load();
    try {
      // settled: the frame at the end of an interrupted fold is the subject.
      const tops = await page.evaluate(
        () =>
          new Promise<{ before: number; after: number }>((resolve) => {
            const dialog = document.querySelector("dialog")!;
            const before = dialog.getBoundingClientRect().top;
            (window as unknown as HeightWindow).addNotice();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                // Held 4 ms before its end, so it cannot finish on its own before the change below.
                // animation-settle: all timelines - Moves the frame's own fold; the fixture has no scroll-driven ones.
                for (const animation of dialog.getAnimations()) {
                  animation.pause();
                  animation.currentTime = Number(animation.effect?.getComputedTiming().endTime) - 4;
                }
                // A change that keeps the height: the fold has nothing left to do and stops where it is.
                const notice = dialog.querySelector<HTMLElement>("[data-notice]")!;
                notice.textContent = `${notice.textContent}`;
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({ before, after: dialog.getBoundingClientRect().top })));
              }),
            );
          }),
      );
      expect(Math.abs(tops.after - tops.before)).toBeLessThan(1);
    } finally {
      await page.context().close();
    }
  });

  test("a frame placed by its content keeps its place when the window resizes", async () => {
    const page = await load();
    try {
      await watch(page, "add");
      await page.evaluate(() => (window as unknown as HeightWindow).placeAt(90, 120));
      await settle(page);
      const placed = await page.evaluate(() => document.querySelector("dialog")!.getBoundingClientRect().toJSON() as DOMRect);
      await page.setViewportSize({ width: 1200, height: 760 });
      // The frame takes a resize in the next frame.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await settle(page);
      const after = await page.evaluate(() => document.querySelector("dialog")!.getBoundingClientRect().toJSON() as DOMRect);
      expect({ top: after.top, left: after.left }).toEqual({ top: placed.top, left: placed.left });
    } finally {
      await page.context().close();
    }
  });

  test("content that arrives while the dialog rises or a sheet slides in does not fold", async () => {
    for (const kind of ["dialog", "sheet"] as const) {
      const page = await (await browser.newContext(kind === "sheet" ? { viewport: { width: 390, height: 844 } } : desktop)).newPage();
      try {
        await page.setContent(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
        );
        await page.addScriptTag({ content: script });
        const folded = await page.evaluate(
          (kind) =>
            new Promise<{ moving: boolean; folded: boolean }>((resolve) => {
              const motion = window as unknown as HeightWindow;
              // The frame's own entrance holds still from its first moment, so no late frame lets it end before the
              // notice arrives: a sheet's slide is a Web Animation, the dialog's rise a CSS transition.
              const animate = Element.prototype.animate;
              Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
                const animation = animate.apply(this, args);
                if (this.tagName === "DIALOG" && !this.hasAttribute("data-k2b-frame-motion")) animation.pause();
                return animation;
              };
              if (kind === "sheet") motion.openSheet();
              else motion.openForm();
              const dialog = document.querySelector("dialog")!;
              // animation-settle: all timelines - Holds the frame's own entrance; the fixture has no scroll-driven ones.
              for (const animation of dialog.getAnimations()) animation.pause();
              // The frame follows its content once the level-change module has loaded and made its live region.
              const ready = () => {
                if (!dialog.querySelector("[data-k2b-dialog-live]")) {
                  setTimeout(ready, 10);
                  return;
                }
                // animation-settle: all timelines - Reads the frame's own held entrance; the fixture has no scroll-driven ones.
                const moving = dialog.getAnimations().some((animation) => animation.playState === "paused");
                motion.addNotice();
                let folded = false;
                let frames = 0;
                const sample = () => {
                  folded ||= dialog.dataset.k2bFrameMotion !== undefined;
                  if (++frames < 20) requestAnimationFrame(sample);
                  else resolve({ moving, folded });
                };
                requestAnimationFrame(sample);
              };
              ready();
            }),
          kind,
        );
        expect(folded).toEqual({ moving: true, folded: false });
      } finally {
        await page.context().close();
      }
    }
  });

  test("a fixed frame keeps its size", async () => {
    const page = await load(desktop, true);
    try {
      const fixed = await watch(page, "add");
      expect(fixed.frameMotion).toBe(0);
      expect(fixed.samples.at(-1)!.height).toBeCloseTo(fixed.before.height, 0);
    } finally {
      await page.context().close();
    }
  });

  test("with reduced motion the height changes in one frame and the top edge still stays", async () => {
    const page = await load({ ...desktop, reducedMotion: "reduce" });
    try {
      const grow = await watch(page, "add");
      expect(grow.frameMotion).toBe(0);
      expect(grow.samples[0]!.height - grow.before.height).toBeCloseTo(60, 0);
      expect(Math.abs(grow.samples[0]!.top - grow.before.top)).toBeLessThan(1);
    } finally {
      await page.context().close();
    }
  });
});
