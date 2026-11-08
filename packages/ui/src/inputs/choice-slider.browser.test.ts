import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/choice-slider.browser-harness";

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/choice-slider.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "choice-slider-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "ChoiceSlider harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}
      .column { display: inline-grid; gap: 12px; width: 340px; vertical-align: top; margin: 12px; }
      .column[data-column="lg"] { width: 390px; }
    </style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector('[data-case="lg-no-knob"] [role="slider"]');
  await settled(page);
  return page;
};

const track = (page: Page, name: string) => page.locator(`[data-case="${name}"] [role="slider"]`);

/** Every box of a case, and the element after it, so a state change that moves anything shows. */
const boxes = (page: Page, name: string) =>
  page.evaluate((name) => {
    const section = document.querySelector(`[data-case="${name}"]`)!;
    const selectors = [".k2b-choice-slider", ".k2b-choice-slider__line", ".k2b-choice-slider__track", ".k2b-choice-slider__rail", ".after"];
    return selectors.map((selector) => {
      const rect = section.querySelector(selector)!.getBoundingClientRect();
      return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  }, name);

const stopX = async (page: Page, name: string, index: number) => {
  const box = (await track(page, name).boundingBox())!;
  return { x: box.x + (box.width * index) / 3, y: box.y + box.height / 2 };
};

for (const size of ["md", "lg"] as const) {
  test(`${size}: the fill ends exactly at the thumb's centre for every level`, async () => {
    const page = await open();
    try {
      const slider = track(page, `${size}-normal`);
      await slider.focus();
      await page.keyboard.press("Home");
      for (let level = 0; level < 4; level += 1) {
        if (level > 0) await page.keyboard.press("ArrowRight");
        await settled(page);
        expect(await slider.getAttribute("aria-valuenow")).toBe(String(level + 1));
        const { fillEnd, thumbCentre, rail, fill } = await slider.evaluate((element) => {
          const fill = element.querySelector(".k2b-choice-slider__fill")!.getBoundingClientRect();
          const thumb = element.querySelector(".k2b-choice-slider__thumb")!.getBoundingClientRect();
          const rail = element.querySelector(".k2b-choice-slider__rail")!.getBoundingClientRect();
          return { fillEnd: fill.right, thumbCentre: thumb.left + thumb.width / 2, rail, fill };
        });
        expect(Math.abs(fillEnd - thumbCentre)).toBeLessThan(0.5);
        // One rail, and the fill starts with it and sits on it.
        expect(fill.left).toBeCloseTo(rail.left, 1);
        expect(fill.top).toBeCloseTo(rail.top, 1);
        expect(fill.height).toBeCloseTo(rail.height, 1);
      }
    } finally {
      await page.close();
    }
  });

  test(`${size}: no box moves while dragging, on an unavailable level, with a warning or without a thumb`, async () => {
    const page = await open();
    try {
      // Dragging previews another level and fills the thumb; nothing around it moves.
      const before = await boxes(page, `${size}-normal`);
      const start = await stopX(page, `${size}-normal`, 1);
      const end = await stopX(page, `${size}-normal`, 3);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      await settled(page);
      expect(await track(page, `${size}-normal`).getAttribute("data-dragging")).toBe("");
      expect(await track(page, `${size}-normal`).getAttribute("aria-valuenow")).toBe("4");
      const thumbFill = await track(page, `${size}-normal`).evaluate(
        (element) => getComputedStyle(element.querySelector(".k2b-choice-slider__thumb")!).backgroundColor,
      );
      expect(thumbFill).not.toBe("rgb(255, 255, 255)");
      // A pointer drag focuses the track without the keyboard focus ring.
      expect(
        await track(page, `${size}-normal`).evaluate((element) => [document.activeElement === element, element.matches(":focus-visible")]),
      ).toEqual([true, false]);
      expect(await boxes(page, `${size}-normal`)).toEqual(before);
      await page.mouse.up();
      await settled(page);
      expect(await track(page, `${size}-normal`).getAttribute("data-dragging")).toBeNull();
      expect(await boxes(page, `${size}-normal`)).toEqual(before);

      // Pressing an unavailable level shows its reason in the same line.
      const unavailable = await boxes(page, `${size}-unavailable`);
      const blocked = await stopX(page, `${size}-unavailable`, 2);
      await page.mouse.move(blocked.x, blocked.y);
      await page.mouse.down();
      await settled(page);
      expect(await page.locator(`[data-case="${size}-unavailable"] .k2b-choice-slider__line`).getAttribute("data-tone")).toBe("warning");
      expect(await boxes(page, `${size}-unavailable`)).toEqual(unavailable);
      await page.mouse.up();
      await settled(page);

      // A warning and a missing thumb keep the geometry of the normal slider.
      const shape = (list: Awaited<ReturnType<typeof boxes>>) =>
        list.map(({ selector, width, height, y }) => ({ selector, width, height, y: y - list[0]!.y }));
      expect(await track(page, `${size}-warning`).locator(".k2b-choice-slider__thumb").getAttribute("data-tone")).toBe("warning");
      expect(shape(await boxes(page, `${size}-warning`))).toEqual(shape(before));
      expect(await track(page, `${size}-no-knob`).locator(".k2b-choice-slider__thumb").isHidden()).toBe(true);
      expect(shape(await boxes(page, `${size}-no-knob`))).toEqual(shape(before));
    } finally {
      await page.close();
    }
  });
}

for (const theme of ["light", "dark"] as const)
  test(`${theme}: the resting rail keeps 3:1 against the surface, and the thumb is surface-coloured with a primary edge`, async () => {
    const page = await open();
    try {
      if (theme === "dark") await page.evaluate(() => document.body.setAttribute("data-theme", "dark"));
      await settled(page);
      const colours = await track(page, "md-normal").evaluate((element) => {
        const style = (selector: string) => getComputedStyle(element.querySelector(selector)!);
        return {
          rail: style(".k2b-choice-slider__rail").backgroundColor,
          surface: getComputedStyle(element.querySelector(".k2b-choice-slider__stop:not([data-on])")!).backgroundColor,
          // Every surface a slider may sit on, read through a probe so the theme resolves the tokens.
          surfaces: ["--k2b-surface", "--k2b-surface-muted", "--k2b-surface-elevated", "--k2b-surface-canvas"].map((token) => {
            const probe = document.body.appendChild(document.createElement("div"));
            probe.style.background = `var(${token})`;
            const colour = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return colour;
          }),
          thumb: style(".k2b-choice-slider__thumb").backgroundColor,
          edge: style(".k2b-choice-slider__thumb").boxShadow,
          fill: style(".k2b-choice-slider__fill").backgroundColor,
        };
      });
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const channels = (colour: string) => colour.match(/\d+/g)!.slice(0, 3).map(Number);
      const rail = luminance(channels(colours.rail));
      const contrast = (colour: string) => {
        const surface = luminance(channels(colour));
        return (Math.max(rail, surface) + 0.05) / (Math.min(rail, surface) + 0.05);
      };
      expect(colours.surfaces.map(contrast).every((ratio) => ratio >= 3)).toBe(true);
      // The thumb takes the surface colour (white in light mode), like the stops on the grey rail.
      expect(colours.thumb).toBe(colours.surface);
      if (theme === "light") expect(colours.thumb).toBe("rgb(255, 255, 255)");
      expect(colours.edge).toContain(colours.fill);
      expect(colours.edge).toContain("inset");
    } finally {
      await page.close();
    }
  });
