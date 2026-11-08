import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const entry = resolve(import.meta.dir, "slider-layout.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Slider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
for (const placement of ["control", "label"]) {
  const [value, setValue] = createSignal(0);
  render(() => createComponent(Slider, {
    label: "Contrast", description: "Adjust the difference between light and dark.",
    get value() { return value(); }, onValueChange: setValue,
    min: -100, max: 100, center: true, defaultValue: 0, valuePlacement: placement,
  }), document.getElementById(placement));
}
`;
let browser: Browser;
let script: string;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build Slider layout fixture");
  script = await build.outputs[0]!.text();
  css = await Bun.file(resolve(ui, "dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [1440, 390]) {
  test(`both Slider layouts keep their label and track still when changed and reset at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="padding:24px"><main style="display:grid;grid-template-columns:repeat(${width === 390 ? 1 : 2},minmax(0,1fr));gap:16px"><div id="control"></div><div id="label"></div></main></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.getByRole("slider").last().waitFor();
      await settled(page);
      for (const placement of ["control", "label"]) {
        const field = page.locator(`#${placement}`);
        const slider = field.getByRole("slider", { name: "Contrast", exact: true });
        const boxes = () =>
          field.evaluate((root) => {
            const rect = (selector: string) => {
              const box = root.querySelector(selector)!.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            };
            return { label: rect("label"), track: rect("input"), field: rect(".k2b-field") };
          });
        const original = await boxes();
        const reset = field.getByRole("button", { name: "Reset to 0", includeHidden: true });
        expect(await reset.isVisible()).toBe(false);
        await slider.focus();
        await page.keyboard.press("ArrowRight");
        await settled(page);
        expect(await slider.inputValue()).toBe("1");
        expect(await boxes()).toEqual(original);
        expect(await reset.isVisible()).toBe(true);
        const aligned = await field.evaluate((root) => {
          const label = root.querySelector("label")!.getBoundingClientRect();
          const output = root.querySelector("output")!;
          const value = output.getBoundingClientRect();
          const input = root.querySelector("input")!;
          const track = input.getBoundingClientRect();
          return {
            sameRow: value.top < label.bottom && value.bottom > label.top,
            aboveTrack: value.bottom < track.top,
            blue: getComputedStyle(output).color === getComputedStyle(input).accentColor,
          };
        });
        expect(aligned.sameRow).toBe(placement === "label");
        expect(aligned.aboveTrack).toBe(placement === "label");
        expect(aligned.blue).toBe(true);
        await reset.click();
        await settled(page);
        expect(await slider.inputValue()).toBe("0");
        expect(await boxes()).toEqual(original);
        expect(await slider.evaluate((input) => input === document.activeElement)).toBe(true);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}
