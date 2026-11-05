import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

const entry = resolve(import.meta.dir, "number-input-fraction-pad.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { NumberInput } from ${JSON.stringify(resolve(import.meta.dir, "../../dist/browser/index.js"))};
const [value, setValue] = createSignal(321.4);
let changes = 0;
render(() => createComponent(NumberInput, {
  label: "Price", locale: "de", step: 0.01, value,
  onValueChange: (next) => {
    changes++;
    document.body.dataset.changes = String(changes);
    setValue(next);
  },
}), document.getElementById("root"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not build the NumberInput padding fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("blur pads the price while typing preserves raw text, caret and field width", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<div id="root" style="width:400px"></div><button>Leave</button>');
    await page.addStyleTag({ path: resolve(import.meta.dir, "../../dist/styles.css") });
    await page.addScriptTag({ content: script });
    const field = page.getByRole("spinbutton", { name: "Price" });
    expect(await field.inputValue()).toBe("321,40");
    const width = (await field.boundingBox())!.width;
    await field.fill("321,4");
    await field.evaluate((node: HTMLInputElement) => node.setSelectionRange(3, 3));
    await page.keyboard.press("ArrowLeft");
    expect(await field.inputValue()).toBe("321,4");
    expect(await field.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(2);
    expect((await field.boundingBox())!.width).toBe(width);
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    expect(await field.inputValue()).toBe("321,40");
    expect(await page.locator("body").getAttribute("data-changes")).toBe("1");
    expect((await field.boundingBox())!.width).toBe(width);
  } finally {
    await context.close();
  }
});
