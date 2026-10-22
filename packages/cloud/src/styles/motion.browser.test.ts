import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";

// Every Cloud page loads the root stylesheet: @k2b/ui stops the motion inside
// .k2b-ui, and Cloud's own CSS stops the page's view transitions.
const workspaceRoot = resolve(import.meta.dir, "../../../..");
const sizes = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true },
};
const states = {
  normal: { reducedMotion: "no-preference", attribute: false },
  host: { reducedMotion: "no-preference", attribute: true },
  OS: { reducedMotion: "reduce", attribute: false },
} as const;
let css: string;
let browser: Browser;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(workspaceRoot, "styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const [size, options] of Object.entries(sizes)) {
  describe(`${browserName} Cloud page motion on ${size}`, () => {
    for (const [state, preference] of Object.entries(states)) {
      test(`${state} preference ${state === "normal" ? "animates" : "makes motion and view transitions instant"}`, async () => {
        const page = await browser.newPage({ ...options, reducedMotion: preference.reducedMotion });
        try {
          await page.setContent(`<!doctype html><html${preference.attribute ? ' data-k2b-motion="reduced"' : ""}><head>
            <meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
            <body class="k2b-ui"><button class="k2b-button" data-variant="primary">Save</button></body></html>`);
          const motion = await page.evaluate(async () => {
            const button = document.querySelector(".k2b-button")!;
            const transition = document.startViewTransition(() => {
              button.textContent = "Saved";
            });
            await transition.ready;
            // animation-settle: all timelines - Count view-transition pseudo-elements.
            const viewTransition = document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect instanceof KeyframeEffect &&
                  animation.effect.pseudoElement?.startsWith("::view-transition-"),
              ).length;
            await transition.finished;
            return {
              viewTransition,
              button: getComputedStyle(button)
                .transitionDuration.split(",")
                .map((value) => value.trim()),
            };
          });
          if (state === "normal") {
            expect(motion.viewTransition).toBeGreaterThan(0);
            expect(motion.button.some((duration) => Number.parseFloat(duration) > 0)).toBe(true);
          } else {
            expect(motion.viewTransition).toBe(0);
            expect(motion.button.every((duration) => duration === "0s")).toBe(true);
          }
        } finally {
          await page.close();
        }
      });
    }
  });
}
