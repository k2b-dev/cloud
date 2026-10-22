import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Real entry classes from Button, BottomSheet, and toast; the shipped CSS owns
// their motion. A real engine is needed for animation and pseudo-element state.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const markup = `
  <button class="k2b-button" data-variant="primary">Save</button>
  <i class="k2b-spin">Loading</i>
  <dialog class="k2b-dialog k2b-bottom-sheet-frame"><div class="k2b-bottom-sheet-viewport">Sheet</div></dialog>
  <div data-k2b-toast-container><div class="k2b-toast" data-k2b-toast data-tone="success">Saved</div></div>
  <progress class="k2b-toast__progress"></progress>
  <div class="k2b-gesture-menu" data-swipe="right"><span class="k2b-gesture-menu__swipe"></span></div>
  <span class="k2b-chart-group-controls__loading" data-loading></span>`;
const sizes = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true },
};
const states = {
  normal: { reducedMotion: "no-preference", attribute: false },
  host: { reducedMotion: "no-preference", attribute: true },
  OS: { reducedMotion: "reduce", attribute: false },
} as const;
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const [size, options] of Object.entries(sizes)) {
  describe(`${browserName} motion on ${size}`, () => {
    for (const [state, preference] of Object.entries(states)) {
      test(`${state} preference ${state === "normal" ? "keeps entry motion" : "makes all motion instant"}`, async () => {
        const page = await browser.newPage({ ...options, reducedMotion: preference.reducedMotion });
        try {
          await page.setContent(`<!doctype html><html${preference.attribute ? ' data-k2b-motion="reduced"' : ""}><head>
            <meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
            <body class="k2b-ui">${markup}</body></html>`);
          const entry = await page.evaluate(async () => {
            const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            // Establish the toast's closed style, then use its real open state.
            await frame();
            document.querySelector(".k2b-toast")!.setAttribute("data-open", "true");
            document.querySelector("dialog")!.showModal();
            // Read the started motion in the same task: getAnimations() flushes
            // style, and a short entry cannot end before it is read.
            const toast = document.querySelector(".k2b-toast");
            // animation-settle: all timelines - Count fixture motion; there are no navigation labels.
            const started = document.getAnimations().map((animation) => ({
              name: animation instanceof CSSAnimation ? animation.animationName : "",
              toast: animation.effect instanceof KeyframeEffect && animation.effect.target === toast,
              length: Number(animation.effect?.getComputedTiming().activeDuration ?? 0),
            }));
            const sampled = [".k2b-button", ".k2b-spin", ".k2b-bottom-sheet-frame", ".k2b-toast"];
            const durations = sampled.map((selector) =>
              getComputedStyle(document.querySelector(selector)!)
                .transitionDuration.split(",")
                .map((value) => value.trim()),
            );
            await frame();
            // animation-settle: all timelines - Verify reduced motion stops all fixture animations.
            const running = document.getAnimations().filter((animation) => animation.playState === "running").length;
            // Presentation swaps, not only timing: a muted full track instead of a
            // frozen segment, and the swipe icon above the content that stays put.
            const progress = getComputedStyle(document.querySelector(".k2b-toast__progress")!).backgroundImage;
            const swipe = getComputedStyle(document.querySelector(".k2b-gesture-menu__swipe")!).zIndex;
            // A delay that debounces a loader is not motion: it outlasts reduced motion.
            const loader = getComputedStyle(document.querySelector(".k2b-chart-group-controls__loading")!);
            const debounce = { delay: loader.transitionDelay, duration: loader.transitionDuration };
            return { started, durations, running, progress, swipe, debounce };
          });
          const moving = entry.started.filter((animation) => animation.length > 0);
          if (state === "normal") {
            expect(entry.durations[0]!.some((duration) => Number.parseFloat(duration) > 0)).toBe(true);
            expect(moving.some((animation) => animation.name === "k2b-spin")).toBe(true);
            expect(moving.some((animation) => animation.name === "k2b-bottom-sheet-enter")).toBe(true);
            expect(moving.some((animation) => animation.toast)).toBe(true);
            expect(entry.progress).toContain("linear-gradient");
            expect(entry.swipe).toBe("auto");
            expect(entry.debounce).toEqual({ delay: "0.2s", duration: "0.15s" });
          } else {
            expect(entry.debounce).toEqual({ delay: "0.2s", duration: "0s" });
            expect(entry.progress).toBe("none");
            expect(entry.swipe).toBe("1");
            expect(entry.durations.every((durations) => durations.every((duration) => duration === "0s"))).toBe(true);
            expect(moving).toEqual([]);
            expect(entry.running).toBe(0);
          }
        } finally {
          await page.close();
        }
      });
    }
  });
}
