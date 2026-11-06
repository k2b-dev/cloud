import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// A native checkbox paints its own corners and computes to a 0px radius, so only a real engine shows the difference.
const ui = await Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)).text();
const base = await Bun.file(new URL("../../../ui/dist/base.css", import.meta.url)).text();

let browser: Browser;
let harness: string;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./task-marker.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the editor harness.");
  harness = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const box = (page: Page, selector: string, checked: boolean) =>
  page.evaluate(
    ({ selector, checked }) => {
      const input = [...document.querySelectorAll<HTMLInputElement>(selector)].find((element) => element.checked === checked)!;
      const style = getComputedStyle(input);
      const { width, height } = input.getBoundingClientRect();
      return { appearance: style.appearance, radius: style.borderRadius, width, height };
    },
    { selector, checked },
  );

const expectSameRoundedBox = async (page: Page, selector: string) => {
  const checked = await box(page, selector, true);
  expect(checked).toEqual(await box(page, selector, false));
  expect(checked.appearance).toBe("none");
  expect(checked.radius).toBe("4px");
};

describe.each(["light", "dark"])("checked and open checkboxes share one box (%s)", (theme) => {
  test("editor task list", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${ui}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: harness });
    await page.waitForFunction(() => document.querySelectorAll(".custom-list-task-marker").length === 2);
    await expectSameRoundedBox(page, ".custom-list-task-marker");
    await page.close();
  });

  test("@k2b/ui base stylesheet", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html data-theme="${theme}"><head><style>${base}</style></head><body><ul><li><input type="checkbox" checked aria-label="Done"></li><li><input type="checkbox" aria-label="Open"></li></ul></body></html>`,
    );
    await page.locator("input:checked").waitFor();
    await expectSameRoundedBox(page, "input");
    await page.close();
  });
});
