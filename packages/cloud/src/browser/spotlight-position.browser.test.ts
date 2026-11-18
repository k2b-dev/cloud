import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

const ui = resolve(import.meta.dir, "../../../ui");
const entry = resolve(import.meta.dir, "spotlight-position.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
      import { onCleanup } from "solid-js";
      import { dialogCore } from "@k2b/ui";
      import { attachSpotlightPosition } from "./spotlight-position";
      window.openSearch = () => void dialogCore.open((close, context) => {
        const host = document.createElement("section");
        host.style.width = "400px";
        host.innerHTML = '<h2 data-search-grip="top">Search</h2><input aria-label="Search"><div data-results style="height:60px"></div>';
        let cleanup;
        queueMicrotask(() => { cleanup = attachSpotlightPosition(host, context, () => ({ homeHint: "Back to center", releaseHint: "Release to center" })); });
        onCleanup(() => cleanup?.());
        return host;
      }, { panelClassName: "k2b-dialog cloud-search-dialog", initialFocus: "none" });
    `,
  },
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [
    {
      name: "worktree-ui",
      setup(builder) {
        builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(ui, "dist/browser/index.js") }));
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Could not build the Spotlight motion fixture");
const script = await build.outputs[0]!.text();
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("Spotlight's real position observer preserves a normal content fold through later size reports", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  try {
    await page.setContent(`<html><head><style>${css}
      .cloud-global-search__home,.cloud-global-search__chip{position:absolute;pointer-events:none}
    </style></head><body class="k2b-ui"></body></html>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => Reflect.get(window, "openSearch")());
    await page.waitForSelector("[data-k2b-dialog-live]", { state: "attached" });
    await settled(page);
    // settled: a held normal-motion fold is advanced through several real ResizeObserver waves.
    const result = await page.evaluate(async () => {
      const dialog = document.querySelector("dialog")!;
      const before = dialog.offsetHeight;
      const folds: Animation[] = [];
      const animate = dialog.animate.bind(dialog);
      dialog.animate = (...args) => {
        const animation = animate(...args);
        animation.pause();
        folds.push(animation);
        return animation;
      };
      const frames = async () => {
        for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
      };
      document.querySelector<HTMLElement>("[data-results]")!.style.height = "180px";
      await frames();
      const fold = folds[0]!;
      const states: AnimationPlayState[] = [];
      for (const share of [0.2, 0.5, 0.9]) {
        fold.currentTime = Number(fold.effect!.getComputedTiming().endTime) * share;
        await frames();
        states.push(fold.playState);
      }
      if (fold.playState !== "idle") fold.finish();
      await frames();
      return { states, before, height: dialog.offsetHeight, movable: document.querySelector("section")!.getAttribute("data-movable") };
    });
    expect(result.movable).toBe("true");
    expect(result.states).toEqual(["paused", "paused", "paused"]);
    expect(result.height - result.before).toBeCloseTo(120, 0);
    await settled(page);
  } finally {
    await page.close();
  }
});
