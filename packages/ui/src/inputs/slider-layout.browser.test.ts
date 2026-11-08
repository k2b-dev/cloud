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
const [disabled, setDisabled] = createSignal(false);
Object.assign(window, { setSlidersDisabled: setDisabled });
for (const placement of ["control", "label"]) {
  const [value, setValue] = createSignal(0);
  render(() => createComponent(Slider, {
    label: "Contrast", description: "Adjust the difference between light and dark.",
    get value() { return value(); }, onValueChange: setValue,
    min: -100, max: 100, center: true, defaultValue: 0, valuePlacement: placement,
    get disabled() { return disabled(); },
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
  test(`both Slider layouts mute disabled labels, values and fills without moving at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="padding:24px"><div id="control"></div><div id="label"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.getByRole("slider").last().waitFor();
      for (const theme of ["light", "dark"]) {
        await page.locator("body").evaluate((body, theme) => {
          body.dataset.theme = theme;
        }, theme);
        for (const placement of ["control", "label"]) {
          const slider = page.locator(`#${placement}`).getByRole("slider");
          await slider.focus();
          await page.keyboard.press("ArrowRight");
        }
        await settled(page);
        const boxes = () =>
          page.getByRole("slider").evaluateAll((inputs) =>
            inputs.map((input) => {
              const rect = input.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }),
          );
        const before = await boxes();
        await page.evaluate("window.setSlidersDisabled(true)");
        await settled(page);
        for (const placement of ["control", "label"]) {
          const field = page.locator(`#${placement}`);
          expect(await field.getByRole("slider").isDisabled()).toBe(true);
          expect(await field.getByRole("button", { name: "Reset to 0" }).isDisabled()).toBe(true);
          const colours = await field.evaluate((root) => {
            const input = root.querySelector("input")!;
            const style = getComputedStyle(input);
            const probe = document.createElement("span");
            probe.style.color = "var(--k2b-text-muted)";
            root.append(probe);
            const muted = getComputedStyle(probe).color;
            probe.remove();
            return {
              mutedFill: style.backgroundImage.includes(muted),
              blueFill: style.backgroundImage.includes(style.accentColor),
              label: getComputedStyle(root.querySelector("label")!).color,
              output: getComputedStyle(root.querySelector("output")!).color,
              muted,
            };
          });
          expect(colours.mutedFill).toBe(true);
          expect(colours.blueFill).toBe(false);
          expect(colours.label).toBe(colours.muted);
          expect(colours.output).toBe(colours.muted);
        }
        expect(await boxes()).toEqual(before);
        await page.evaluate("window.setSlidersDisabled(false)");
        await settled(page);
        expect(await boxes()).toEqual(before);
        for (const placement of ["control", "label"]) {
          expect(await page.locator(`#${placement}`).getByRole("slider").isEnabled()).toBe(true);
          expect(
            await page
              .locator(`#${placement} output`)
              .evaluate(
                (output) =>
                  getComputedStyle(output).color === getComputedStyle(output.closest(".k2b-field")!.querySelector("input")!).accentColor,
              ),
          ).toBe(true);
        }
      }
    } finally {
      await page.close();
    }
  }, 30_000);

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
            const value = rect("output");
            return { label: rect("label"), track: rect("input"), field: rect(".k2b-field"), valueRight: value.x + value.width };
          });
        const original = await boxes();
        if (placement === "label") {
          expect(original.valueRight).toBe(original.field.x + original.field.width);
          const labelRow = await field.locator(".k2b-field__label-row").boundingBox();
          expect(labelRow!.height).toBe(original.label.height);
          expect(
            await field
              .locator(".k2b-slider__value")
              .evaluate((element) => Array.from(element.querySelectorAll("button, output"), (child) => child.tagName)),
          ).toEqual(["BUTTON", "OUTPUT"]);
        }
        const reset = field.getByRole("button", { name: "Reset to 0", includeHidden: true });
        expect(await reset.isVisible()).toBe(false);
        await slider.focus();
        await page.keyboard.press("ArrowRight");
        await settled(page);
        expect(await slider.inputValue()).toBe("1");
        expect(await boxes()).toEqual(original);
        expect((await boxes()).valueRight).toBe(original.valueRight);
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
        expect((await boxes()).valueRight).toBe(original.valueRight);
        expect(await slider.evaluate((input) => input === document.activeElement)).toBe(true);
      }
      if (width === 1440) {
        // The label row takes the same subgrid slot as a plain label in a mixed field group.
        await page.evaluate(() => {
          const main = document.querySelector("main")!;
          for (const wrapper of Array.from(main.children)) {
            main.appendChild(wrapper.firstElementChild!);
            wrapper.remove();
          }
        });
        await settled(page);
        const fields = await page.locator("main > .k2b-field").evaluateAll((fields) =>
          fields.map((field) => ({
            controlTop: field.querySelector("input")!.getBoundingClientRect().top,
            labelTop: field.querySelector("label")!.getBoundingClientRect().top,
            descriptionTop: field.querySelector(".k2b-field__description")!.getBoundingClientRect().top,
          })),
        );
        expect(fields[1]).toEqual(fields[0]);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}
