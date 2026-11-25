import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";

// A segmented control takes the width of its options: each option is as wide as its label plus its padding, so a long
// label is never squeezed against the edge of its segment or cut. Only `stretch` fills the width and gives every option
// the same share (#4165).
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "segmented-widths.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { SegmentedControl } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = ["Members", "Dialog", "Confirm", "Undo", "Error"].map((label) => ({ value: label.toLowerCase(), label }));
const control = (extra) => createComponent(SegmentedControl, { value: "members", onValueChange: () => {}, ariaLabel: "State", options, ...extra });
for (const [name, extra] of [["auto", {}], ["block", {}], ["small", { size: "sm" }], ["stretch", { stretch: true }]]) {
  const cell = document.getElementById(name);
  render(() => control(extra), cell);
}
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the segmented widths fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Each control: its width against its place, and for each option the room between its label and its edges. */
const measure = () =>
  ["auto", "block", "small", "stretch"].map((name) => {
    const cell = document.getElementById(name)!;
    const control = cell.querySelector<HTMLElement>(".k2b-segmented-control")!;
    const options = [...control.querySelectorAll<HTMLElement>(".k2b-segmented-control__option")].map((option) => {
      const box = option.getBoundingClientRect();
      const label = option.querySelector("span")!.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(option).lineHeight);
      return {
        width: box.width,
        room: Math.min(label.left - box.left, box.right - label.right),
        whole: option.scrollWidth <= option.clientWidth && label.height <= lineHeight + 0.5,
      };
    });
    return {
      name,
      place: cell.getBoundingClientRect().width,
      width: control.getBoundingClientRect().width,
      content: options.reduce((sum, option) => sum + option.width, 0),
      options,
    };
  });

for (const width of [390, 1440])
  test(`${width} px: options of mixed length keep their labels whole, clear of their edges; only stretch fills`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 600 } });
    const errors = pageErrors(page);
    try {
      await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style>
        <style>*,*::before,*::after{transition:none!important}
        body{margin:0;padding:16px} #auto{display:inline-flex} #block,#small,#stretch{display:block;margin-top:16px}</style></head>
        <body class="k2b-ui"><div id="auto"></div><div id="block"></div><div id="small"></div><div id="stretch"></div></body></html>`);
      await page.addScriptTag({ content: script });
      await page.locator("#stretch .k2b-segmented-control").waitFor();
      await settled(page);
      const found = await page.evaluate(measure);
      for (const control of found) {
        // the label keeps the option's padding on both sides: at least 8 px, never the edge; stretch gives equal shares
        // instead, so it is for labels that fit them
        for (const option of control.name === "stretch" ? [] : control.options) {
          expect({ control: control.name, whole: option.whole }).toEqual({ control: control.name, whole: true });
          expect(option.room, `${control.name} room`).toBeGreaterThanOrEqual(8);
        }
        if (control.name === "stretch") {
          expect(Math.abs(control.width - control.place)).toBeLessThan(1);
          const widths = control.options.map((option) => option.width);
          expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
        } else {
          // as wide as its options and the track around them, not as its place
          expect(control.width - control.content).toBeLessThan(20);
          if (control.name !== "auto") expect(control.width).toBeLessThan(control.place - 1);
          const widths = control.options.map((option) => option.width);
          expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(8);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
