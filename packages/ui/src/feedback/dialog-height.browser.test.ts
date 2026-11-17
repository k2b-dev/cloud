import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser, settled as settle } from "../../test/browser";

// An open dialog follows its content's height: the frame folds from the height the eye sees to the new one, its top
// edge stays, and new content fades in. Heights over time need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dialog-height.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { BottomSheet, bottomSheetOptions, bottomSheetAdaptiveOptions, Button, dialogCore, PanelDialog, RichSelect, panelDialogFixedOptions, panelDialogOptions } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.holdMotion = () => {
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) { const animation = animate.apply(this, args); animation.pause(); return animation; };
};
window.openPicker = () => {
  const host = document.createElement("div"); document.body.append(host);
  return render(() => createComponent(RichSelect, { label: "Many targets", value: null, onValueChange: () => {},
    items: Array.from({ length: 20 }, (_, index) => ({ value: String(index), label: "Target " + index })) }), host);
};
window.openSheet = (adaptive = false, detents = false) => void dialogCore.open(() => createComponent(BottomSheet, { get detents() { return detents; }, get children() { return [
  createComponent(BottomSheet.Header, { title: "Filter" }),
  createComponent(BottomSheet.Body, { get children() {
    const body = document.createElement("div");
    body.dataset.content = "";
    body.textContent = "Status";
    return body;
  } }),
]; } }), adaptive ? bottomSheetAdaptiveOptions : bottomSheetOptions);
window.openForm = (fixed = false, top = false, previewMode) => void dialogCore.open((close, context) => {
  window.placeAt = (x, y) => context.setPosition(x === null ? null : { x, y });
  window.setModal = context.setModal;
  const [saving, setSaving] = createSignal(false);
  window.setSaving = setSaving;
  return createComponent(PanelDialog, { get children() { return [
  createComponent(PanelDialog.Header, { title: "Edit project", close: () => close() }),
  createComponent(PanelDialog.Body, { get children() {
    const body = document.createElement("div");
    body.dataset.content = "";
    body.innerHTML = "<label>Name <input aria-label='Name' value='Summer fest'></label>";
    if (previewMode) {
      const preview = document.createElement("div"); preview.dataset.preview = "";
      preview.innerHTML = "<p>" + "<span>x</span>".repeat(499) + "</p>";
      if (previewMode === "overlay") { preview.style.cssText = "position:absolute;inset:0;overflow-y:scroll;height:100%;width:100%"; body.style.position = "relative"; }
      body.append(preview);
    }
    return body;
  } }),
  createComponent(PanelDialog.Footer, { get children() {
    return createComponent(Button, { get loading() { return saving(); }, children: "Save" });
  } }),
]; } });
}, fixed ? panelDialogFixedOptions : { ...panelDialogOptions, initialFocus: "none", panelClassName: panelDialogOptions.panelClassName + (top ? " top-anchored" : "") });
/** A notice of this many lines below the field, as a failed save adds one. */
window.addNotice = (lines = 3) => {
  const notice = document.createElement("p");
  notice.dataset.notice = "";
  notice.style.margin = "0";
  notice.style.lineHeight = "20px";
  notice.textContent = "Not saved. ".repeat(lines * 8);
  notice.style.height = lines * 20 + "px";
  notice.style.overflow = "hidden";
  document.querySelector("dialog > :last-child [data-content]").append(notice);
};
window.removeNotices = () => { for (const notice of document.querySelectorAll("[data-notice]")) notice.remove(); };
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog height fixture for the browser.");
const script = await build.outputs[0]!.text();

type HeightWindow = Window & {
  holdMotion: () => void;
  openPicker: () => void;
  openForm: (fixed?: boolean, top?: boolean, previewMode?: "flow" | "overlay") => void;
  openSheet: (adaptive?: boolean, detents?: boolean) => void;
  placeAt: (x: number | null, y?: number) => void;
  setModal: (modal: boolean) => void;
  setSaving: (saving: boolean) => void;
  addNotice: (lines?: number) => void;
  removeNotices: () => void;
};
type Sample = { top: number; bottom: number; height: number; footerBottom: number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

const load = async (
  options: BrowserContextOptions = desktop,
  fixed = false,
  sheet = false,
  previewMode?: "flow" | "overlay",
): Promise<Page> => {
  const page = await (await browser.newContext(options)).newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ({ fixed, sheet, previewMode }) => {
      const motion = window as unknown as HeightWindow;
      if (sheet) motion.openSheet();
      else motion.openForm(fixed, false, previewMode);
    },
    { fixed, sheet, previewMode },
  );
  await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await settle(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page;
};

/** Runs a change and samples the frame every frame until it rests. */
const watch = (page: Page, change: "add" | "remove" | "failed-save", lines = 3) =>
  page.evaluate(
    ([change, lines]) =>
      new Promise<{ before: Sample; immediately: Sample; samples: Sample[]; frameMotion: number; noticeFade: string | null }>((resolve) => {
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
          const footer = dialog.querySelector(".k2b-panel-dialog__footer");
          return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            footerBottom: footer?.getBoundingClientRect().bottom ?? rect.bottom,
          };
        };
        // WebKit's first frames can arrive after a whole fold's duration. Hold animations as they start, so even
        // that first sample sees the fold and its fade; seek through the whole curve before finishing the held clocks.
        const animate = Element.prototype.animate;
        const held: Animation[] = [];
        Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
          const animation = animate.apply(this, args);
          animation.pause();
          held.push(animation);
          return animation;
        };
        const before = box();
        if (change === "remove") motion.removeNotices();
        else {
          if (change === "failed-save") motion.setSaving(false);
          motion.addNotice(Number(lines));
        }
        const immediately = box();
        // The frame measures itself after layout and before the paint of this frame; read in the frame after it.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              Element.prototype.animate = animate;
              const frameMotion = folds().length;
              // The notice's fade starts at 0 after a delay, read from the animation itself rather than at some moment.
              const notice = dialog.querySelector<HTMLElement>("[data-notice]");
              const fade = notice?.getAnimations()[0]?.effect;
              const noticeFade =
                fade instanceof KeyframeEffect
                  ? `${fade.getKeyframes()[0]?.opacity} after ${Number(fade.getTiming().delay) > 0 ? "a delay" : "none"}`
                  : null;
              const samples: Sample[] = [box()];
              for (let step = 1; step <= 20; step++) {
                for (const animation of folds())
                  animation.currentTime = (Number(animation.effect?.getComputedTiming().endTime) * step) / 20;
                samples.push(box());
              }
              for (const animation of held) animation.finish();
              let still = 0;
              const sample = () => {
                samples.push(box());
                // Done after two frames in a row without motion: a change may start a new fold in the frame after another ended.
                const moving = dialog
                  .getAnimations()
                  .some((animation) => animation.timeline === document.timeline && animation.playState === "running");
                still = moving ? 0 : still + 1;
                if (still < 2) requestAnimationFrame(sample);
                else resolve({ before, immediately, samples, frameMotion, noticeFade });
              };
              requestAnimationFrame(sample);
            }),
          ),
        );
      }),
    [change, lines] as const,
  );

describe(`${browserName} the frame follows its content`, () => {
  for (const previewMode of ["flow", "overlay"] as const)
    test(`500 replaced ${previewMode} preview nodes with unchanged height cause no frame measurements or observer churn`, async () => {
      const page = await load(desktop, false, false, previewMode);
      try {
        const cost = await page.evaluate(async () => {
          const dialog = document.querySelector("dialog")!;
          const preview = document.querySelector("[data-preview]")!;
          const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
          const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
          const computed = window.getComputedStyle;
          const observe = ResizeObserver.prototype.observe;
          const unobserve = ResizeObserver.prototype.unobserve;
          let layoutReads = 0,
            observations = 0;
          Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            ...height,
            get() {
              if (this === dialog) layoutReads++;
              return height.get!.call(this);
            },
          });
          Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
            ...width,
            get() {
              if (this === dialog) layoutReads++;
              return width.get!.call(this);
            },
          });
          window.getComputedStyle = (...args) => {
            if (args[0] === dialog) layoutReads++;
            return computed(...args);
          };
          ResizeObserver.prototype.observe = function (...args) {
            observations++;
            return observe.apply(this, args);
          };
          ResizeObserver.prototype.unobserve = function (...args) {
            observations++;
            return unobserve.apply(this, args);
          };
          const start = performance.now();
          try {
            for (let key = 0; key < 10; key++) {
              preview.innerHTML = "<p>" + (key % 2 ? "<span>x</span>" : "<span>y</span>").repeat(499) + "</p>";
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
              );
            }
            return {
              layoutReadsPerKey: layoutReads / 10,
              observerCallsPerKey: observations / 10,
              elapsedMsPerKey: (performance.now() - start) / 10,
            };
          } finally {
            Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
            Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
            window.getComputedStyle = computed;
            ResizeObserver.prototype.observe = observe;
            ResizeObserver.prototype.unobserve = unobserve;
          }
        });
        console.info(`${browserName} O5 ${previewMode} cost: ${JSON.stringify(cost)}`);
        expect(cost.layoutReadsPerKey).toBe(0);
        expect(cost.observerCallsPerKey).toBe(0);
      } finally {
        await page.context().close();
      }
    });

  test("a failed save folds its notice when Button loading clears", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as HeightWindow).setSaving(true));
      await page.waitForSelector('button[aria-busy="true"]');
      const result = await watch(page, "failed-save");
      expect(result.frameMotion).toBe(1);
      expect(result.noticeFade).toBe("0 after a delay");
    } finally {
      await page.context().close();
    }
  });

  test("window and visual viewport resizes keep the top, clamping only when necessary", async () => {
    const page = await load();
    try {
      await watch(page, "add");
      const top = await page.locator("dialog").evaluate((dialog) => dialog.getBoundingClientRect().top);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settle(page);
      expect(await page.locator("dialog").evaluate((dialog) => dialog.getBoundingClientRect().top)).toBeCloseTo(top, 0);
      await page.evaluate(() => window.visualViewport?.dispatchEvent(new Event("resize")));
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settle(page);
      expect(await page.locator("dialog").evaluate((dialog) => dialog.getBoundingClientRect().top)).toBeCloseTo(top, 0);
      await page.setViewportSize({ width: 1280, height: 400 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await settle(page);
      const box = await page.locator("dialog").boundingBox();
      expect(box!.y).toBeLessThan(top);
      expect(box!.y + box!.height).toBeLessThanOrEqual(400);
      await page.evaluate(() => {
        // The host's keyboard inset has already capped the frame. Visual viewport geometry differs from layout.
        document.querySelector<HTMLDialogElement>("dialog")!.style.maxHeight = "250px";
        Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 300 });
        Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, value: 70 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))),
      );
      await settle(page);
      const visible = await page.locator("dialog").boundingBox();
      expect(visible!.y).toBeGreaterThanOrEqual(70);
      expect(visible!.y + visible!.height).toBeLessThanOrEqual(370);
    } finally {
      await page.context().close();
    }
  });

  test("a focused text field holds height until focus leaves the level's text fields", async () => {
    const page = await load();
    try {
      await watch(page, "add");
      await page.getByRole("textbox", { name: "Name" }).focus();
      await settle(page);
      const shrink = await watch(page, "remove");
      expect(shrink.frameMotion).toBe(0);
      expect(shrink.samples.at(-1)!.height).toBe(shrink.before.height);
      await page.getByRole("button", { name: "Save", exact: true }).focus();
      await page.waitForFunction((height) => document.querySelector("dialog")!.offsetHeight < height - 50, shrink.before.height);
      await settle(page);
    } finally {
      await page.context().close();
    }
  });

  test("RichSelect phone search keeps its focused field still while filtering rows", async () => {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    try {
      await page.setContent(
        `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as unknown as HeightWindow).openPicker());
      await page.getByRole("combobox", { name: "Many targets" }).click();
      await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
      await settle(page);
      const search = page.getByRole("searchbox", { name: "Search", exact: true });
      await search.focus();
      await settle(page);
      const result = await search.evaluate(async (input) => {
        const dialog = document.querySelector("dialog")!;
        const before = input.getBoundingClientRect().top;
        const tops: number[] = [];
        (input as HTMLInputElement).value = "Target 19";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        for (let frame = 0; frame < 6; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          tops.push(input.getBoundingClientRect().top);
        }
        return { before, tops, focused: input === document.activeElement, folding: dialog.hasAttribute("data-k2b-frame-motion") };
      });
      expect(result.focused).toBe(true);
      expect(result.folding).toBe(false);
      for (const top of result.tops) expect(top).toBeCloseTo(result.before, 0);
    } finally {
      await page.context().close();
    }
  });

  test("moved content and content around or inside the focus never fade out", async () => {
    const page = await load();
    try {
      const fades = await page.evaluate(async () => {
        (window as unknown as HeightWindow).holdMotion();
        const dialog = document.querySelector("dialog")!;
        const content = dialog.querySelector<HTMLElement>("[data-content]")!;
        const label = content.querySelector("label")!;
        const moved = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer > button")!;
        const wrapper = document.createElement("div");
        content.append(wrapper);
        wrapper.append(label);
        wrapper.append(moved);
        label.contentEditable = "true";
        label.tabIndex = 0;
        label.focus();
        const child = document.createElement("span");
        label.append(child);
        (window as unknown as HeightWindow).addNotice();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        return [wrapper, label, child, moved].map((element) => element.getAnimations().length);
      });
      expect(fades).toEqual([0, 0, 0, 0]);
    } finally {
      await page.context().close();
    }
  });

  test("an existing connected control moved during growth is not newly arrived content", async () => {
    const page = await load();
    try {
      const fades = await page.evaluate(async () => {
        (window as unknown as HeightWindow).holdMotion();
        const dialog = document.querySelector("dialog")!;
        const save = dialog.querySelector<HTMLElement>(".k2b-panel-dialog__footer > button")!;
        dialog.querySelector<HTMLElement>(".k2b-panel-dialog__header button")!.focus();
        dialog.querySelector("[data-content]")!.append(save);
        (window as unknown as HeightWindow).addNotice();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        return save.getAnimations().length;
      });
      expect(fades).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("a child's height animation finishes before the frame folds once to the final height", async () => {
    const page = await load();
    try {
      const result = await page.evaluate(async () => {
        const dialog = document.querySelector("dialog")!;
        const content = dialog.querySelector<HTMLElement>("[data-content]")!;
        const animate = dialog.animate.bind(dialog);
        let folds = 0;
        dialog.animate = (...args) => {
          folds++;
          const animation = animate(...args);
          animation.pause();
          return animation;
        };
        const child = document.createElement("div");
        child.style.height = "100px";
        const animation = child.animate([{ height: "0px" }, { height: "100px" }], { duration: 280 });
        animation.pause();
        animation.currentTime = 140;
        content.append(child);
        const frames = () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await frames();
        const during = dialog.hasAttribute("data-k2b-frame-motion");
        animation.finish();
        await animation.finished;
        await frames();
        return { during, folds };
      });
      expect(result).toEqual({ during: false, folds: 1 });
    } finally {
      await page.context().close();
    }
  });

  test("setModal preserves the position a completed fold established", async () => {
    const page = await load();
    try {
      await watch(page, "add");
      const top = await page.locator("dialog").evaluate((dialog) => dialog.getBoundingClientRect().top);
      for (const modal of [false, true]) {
        await page.evaluate((modal) => (window as unknown as HeightWindow).setModal(modal), modal);
        await settle(page);
        expect(await page.locator("dialog").evaluate((dialog) => dialog.getBoundingClientRect().top)).toBeCloseTo(top, 0);
      }
    } finally {
      await page.context().close();
    }
  });

  for (const detents of [false, true])
    test(`an adaptive desktop fold releases top before becoming a phone sheet (detents ${detents})`, async () => {
      const page = await (await browser.newContext(desktop)).newPage();
      try {
        await page.setContent(
          `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await page.evaluate((detents) => (window as unknown as HeightWindow).openSheet(true, detents), detents);
        await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
        await settle(page);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await watch(page, "add");
        expect(await page.locator("dialog").evaluate((dialog) => dialog.style.top)).not.toBe("");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
            ),
        );
        await settle(page);
        const geometry = await page.locator("dialog").evaluate((dialog) => ({
          top: dialog.style.top,
          bottom: dialog.getBoundingClientRect().bottom - new DOMMatrixReadOnly(getComputedStyle(dialog).transform).m42,
          detents: dialog.hasAttribute("data-sheet-detents"),
        }));
        expect(geometry.detents).toBe(detents);
        expect(geometry.top).toBe("");
        expect(geometry.bottom).toBeCloseTo(844, 0);
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
            ),
        );
        await settle(page);
        const back = await page.locator("dialog").evaluate((dialog) => {
          const rect = dialog.getBoundingClientRect();
          return { top: dialog.style.top, center: rect.top + rect.height / 2 };
        });
        expect(back.top).toBe("");
        expect(back.center).toBeCloseTo(400, 0);
      } finally {
        await page.context().close();
      }
    });

  for (const reset of [false, true])
    test(`setPosition during a fold wins over its stale completion (reset ${reset})`, async () => {
      const page = await load();
      try {
        const result = await page.evaluate(async (reset) => {
          const dialog = document.querySelector("dialog")!;
          const animate = dialog.animate.bind(dialog);
          dialog.animate = (...args) => {
            const animation = animate(...args);
            animation.pause();
            return animation;
          };
          (window as unknown as HeightWindow).addNotice();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          );
          const animation = dialog
            .getAnimations()
            .find(
              (animation) =>
                animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some((frame) => "height" in frame),
            )!;
          animation.currentTime = Number(animation.effect?.getComputedTiming().endTime) / 2;
          const stale = animation.onfinish;
          (window as unknown as HeightWindow).placeAt(reset ? null : 90, 120);
          const before = dialog.getBoundingClientRect().top;
          stale?.call(animation, new Event("finish") as AnimationPlaybackEvent);
          return {
            state: animation.playState,
            before,
            after: dialog.getBoundingClientRect().top,
            inline: dialog.style.top,
            fixed: dialog.style.position,
          };
        }, reset);
        expect(result.state).toBe("idle");
        expect(result.after).toBe(result.before);
        expect(result.inline).toBe(reset ? "" : "120px");
        expect(result.fixed).toBe(reset ? "" : "fixed");
      } finally {
        await page.context().close();
      }
    });

  test("an intrinsic size arriving before the first ResizeObserver report is measured without a fold", async () => {
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.setContent(`<html><head><style>${css}</style></head><body class="k2b-ui"></body></html>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(async () => {
        const image = new Image();
        image.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"/>');
        await image.decode();
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          if (this instanceof HTMLDialogElement && this.hasAttribute("data-k2b-frame-motion"))
            this.dataset.earlyFolds = String(Number(this.dataset.earlyFolds ?? 0) + 1);
          return animate.apply(this, args);
        };
        const observe = ResizeObserver.prototype.observe;
        let first = true;
        ResizeObserver.prototype.observe = function (...args) {
          if (
            first &&
            args[0] === document.querySelector("dialog > .k2b-panel-dialog-viewport") &&
            document.querySelector<HTMLDialogElement>("dialog")!.style.height
          ) {
            first = false;
            // follow() has held the old frame but has not observed mutations yet: reproduce an intrinsic-size
            // change in that gap, before the first size delivery establishes its baseline.
            document.querySelector("[data-content]")!.append(image);
          }
          return observe.apply(this, args);
        };
        (window as unknown as HeightWindow).openForm();
      });
      await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))),
      );
      await settle(page);
      const heights = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        const held = dialog.offsetHeight;
        dialog.style.removeProperty("height");
        return { held, natural: dialog.offsetHeight, folds: Number(dialog.dataset.earlyFolds ?? 0) };
      });
      expect(heights.held).toBe(heights.natural);
      expect(heights.folds).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("a first size report delivered after a morph still starts the follow-up fold", async () => {
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.setContent(`<html><head><style>${css}</style></head><body class="k2b-ui"></body></html>`);
      await page.evaluate(() => {
        const NativeObserver = ResizeObserver;
        let held = false;
        const deliveries = new Map<ResizeObserver, () => void>();
        window.ResizeObserver = class extends NativeObserver {
          constructor(callback: ResizeObserverCallback) {
            let frameObserver = false;
            const latest = new Map<Element, ResizeObserverEntry>();
            super((entries, observer) => {
              frameObserver ||= entries.some(({ target }) => target.parentElement instanceof HTMLDialogElement);
              if (!held || !frameObserver) {
                callback(entries, observer);
                return;
              }
              for (const entry of entries) latest.set(entry.target, entry);
              deliveries.set(observer, () => callback([...latest.values()], observer));
            });
          }
        };
        Object.assign(window, {
          holdSizeReports: () => {
            held = true;
          },
          releaseSizeReports: () => {
            held = false;
            for (const deliver of deliveries.values()) deliver();
            deliveries.clear();
          },
        });
      });
      await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as unknown as HeightWindow).openForm());
      await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
      await settle(page);
      const folds = await page.evaluate(async () => {
        const motion = window as unknown as HeightWindow & { holdSizeReports: () => void; releaseSizeReports: () => void };
        motion.holdSizeReports();
        motion.holdMotion();
        motion.openForm();
        const frames = () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await frames();
        motion.addNotice();
        await frames();
        const dialog = document.querySelector("dialog")!;
        let folds = 0;
        const animate = dialog.animate.bind(dialog);
        dialog.animate = (...args) => {
          folds++;
          return animate(...args);
        };
        const animations = dialog
          .getAnimations({ subtree: true })
          .filter(
            (animation) => animation.timeline === document.timeline && Number.isFinite(animation.effect?.getComputedTiming().endTime),
          );
        const morph = animations.find(
          (animation) =>
            animation.effect instanceof KeyframeEffect &&
            animation.effect.target === dialog &&
            animation.effect.getKeyframes().some((keyframe) => "width" in keyframe),
        )!;
        const ending = morph.onfinish;
        morph.onfinish = (event) => {
          ending?.call(morph, event);
          // Deliver the merged first size report after the morph ends, before its scheduled measurement frame.
          motion.releaseSizeReports();
        };
        for (const animation of animations) animation.finish();
        await frames();
        return folds;
      });
      expect(folds).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  test("a notice grows the frame downwards; its top edge stays and the notice fades in", async () => {
    const page = await load();
    try {
      const grow = await watch(page, "add");
      expect(grow.immediately.height).toBe(grow.before.height);
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
            // Wait for the scheduled fold, then seek to its midpoint: the second notice arrives halfway through it,
            // independently of observer delivery and however late the next frame comes.
            const halfway = () => {
              const fold = dialog
                .getAnimations()
                .find(
                  (animation) =>
                    animation.timeline === document.timeline &&
                    animation.effect instanceof KeyframeEffect &&
                    animation.effect.getKeyframes().some((keyframe) => "height" in keyframe),
                );
              if (!fold) {
                requestAnimationFrame(halfway);
                return;
              }
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
            };
            motion.addNotice();
            requestAnimationFrame(halfway);
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
      expect(Math.abs(tall.samples[0]!.top - tall.before.top)).toBeLessThan(1);
      for (let index = 1; index < tall.samples.length; index++)
        expect(Math.abs(tall.samples[index]!.top - tall.samples[index - 1]!.top)).toBeLessThan(40);
      for (const sample of tall.samples) {
        expect(sample.bottom).toBeLessThanOrEqual(room + 0.5);
        expect(sample.footerBottom).toBeLessThanOrEqual(room + 0.5);
      }
      expect(tall.samples.at(-1)!.top).toBeLessThan(tall.before.top);
      expect(
        await page.locator(".k2b-panel-dialog__footer").evaluate((footer) => footer.getBoundingClientRect().bottom),
      ).toBeLessThanOrEqual(room);
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
        // settled: the held entrance and its centred first rest are the subject, before any entrance can finish.
        const folded = await page.evaluate(
          (kind) =>
            new Promise<{ moving: boolean; folded: boolean; centered: boolean }>((resolve) => {
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
                  else {
                    Element.prototype.animate = animate;
                    for (const animation of dialog.getAnimations()) animation.cancel();
                    const rect = dialog.getBoundingClientRect();
                    resolve({ moving, folded, centered: kind === "sheet" || Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 1 });
                  }
                };
                requestAnimationFrame(sample);
              };
              ready();
            }),
          kind,
        );
        expect(folded).toEqual({ moving: true, folded: false, centered: true });
      } finally {
        await page.context().close();
      }
    }
  });

  test("a frame whose stylesheet anchors its top keeps that edge and its footer in view", async () => {
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.setContent(`<html><head><style>${css}
        .k2b-ui .k2b-dialog.top-anchored { top: 72px; transform: translateX(-50%); max-height: calc(100dvh - 96px); }
        </style></head><body class="k2b-ui"></body></html>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as unknown as HeightWindow).openForm(false, true));
      await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
      await settle(page);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const grow = await watch(page, "add", 30);
      expect(grow.frameMotion).toBeGreaterThan(0);
      for (const sample of grow.samples) {
        expect(sample.top).toBeCloseTo(72, 0);
        expect(sample.footerBottom).toBeLessThanOrEqual(800);
      }
    } finally {
      await page.context().close();
    }
  });

  test("a sheet at rest grows from its bottom edge", async () => {
    const page = await load({ viewport: { width: 390, height: 844 } }, false, true);
    try {
      const grow = await watch(page, "add");
      expect(grow.frameMotion).toBeGreaterThan(0);
      expect(grow.immediately.height).toBe(grow.before.height);
      expect(grow.samples.at(-1)!.height - grow.before.height).toBeCloseTo(60, 0);
      for (const sample of grow.samples) expect(sample.bottom).toBeCloseTo(grow.before.bottom, 0);
    } finally {
      await page.context().close();
    }
  });

  test("busy content, including the frame that clears busy, takes its height without a fold", async () => {
    const page = await load();
    try {
      const result = await page.evaluate(async () => {
        const dialog = document.querySelector("dialog")!;
        const content = dialog.querySelector<HTMLElement>("[data-content]")!;
        const motion = window as unknown as HeightWindow;
        const frames = () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const folding = () => dialog.hasAttribute("data-k2b-frame-motion");
        const before = dialog.getBoundingClientRect();
        content.setAttribute("aria-busy", "true");
        motion.addNotice();
        await frames();
        const busy = { folded: folding(), height: dialog.offsetHeight, top: dialog.getBoundingClientRect().top };
        motion.addNotice();
        content.removeAttribute("aria-busy");
        await frames();
        return {
          before: { height: before.height, top: before.top },
          busy,
          loaded: { folded: folding(), height: dialog.offsetHeight, top: dialog.getBoundingClientRect().top },
        };
      });
      expect(result.busy.folded).toBe(false);
      expect(result.loaded.folded).toBe(false);
      expect(result.busy.height - result.before.height).toBeCloseTo(60, 0);
      expect(result.loaded.height - result.before.height).toBeCloseTo(120, 0);
      expect(result.busy.top).toBeCloseTo(result.before.top, 0);
      expect(result.loaded.top).toBeCloseTo(result.before.top, 0);
      // Once loading has settled, ordinary edits fold again.
      await settle(page);
      expect((await watch(page, "add")).frameMotion).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  });

  test("content and loading never report a ResizeObserver loop or leave a stretched frame folding", async () => {
    const page = await load();
    try {
      await page.evaluate(() => {
        const errors: string[] = [];
        Object.assign(window, { frameErrors: errors });
        window.addEventListener("error", (event) => errors.push(event.message));
        // A child stretched by the frame used to feed the frame's own height back into its observer.
        const level = document.querySelector<HTMLElement>("dialog > :last-child")!;
        level.style.height = "100%";
      });
      for (let round = 0; round < 2; round++) {
        await watch(page, "add");
        await watch(page, "remove");
      }
      await page.evaluate(() => {
        const content = document.querySelector("[data-content]")!;
        content.setAttribute("aria-busy", "true");
        (window as unknown as HeightWindow).addNotice();
        content.removeAttribute("aria-busy");
      });
      await settle(page);
      expect(await page.evaluate(() => Reflect.get(window, "frameErrors"))).toEqual([]);
      expect(await page.locator("dialog").getAttribute("data-k2b-frame-motion")).toBeNull();
    } finally {
      await page.context().close();
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
