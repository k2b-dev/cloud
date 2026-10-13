import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/toolbar.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "toolbar-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Toolbar harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const page = await browser.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${css}.k2b-ui .k2b-toolbar .hidden-group {display:none}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector('#first[tabindex="0"]');
  return page;
};
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id);
const stops = (page: Page) => page.locator('[aria-label="Horizontal"] [tabindex="0"]').count();

test("one tab stop enters at the first control and leaves in one Tab", async () => {
  const page = await open();
  try {
    expect(await stops(page)).toBe(1);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("first");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("after");
  } finally {
    await page.close();
  }
});

test("arrows wrap, Home/End jump, hidden and disabled controls are skipped", async () => {
  const page = await open();
  try {
    await page.locator("#first").focus();
    for (const [key, id] of [
      ["ArrowRight", "unavailable"],
      ["ArrowRight", "menu"],
      ["End", "last"],
      ["ArrowRight", "first"],
      ["ArrowLeft", "last"],
      ["Home", "first"],
    ]) {
      await page.keyboard.press(key!);
      expect(await focused(page)).toBe(id!);
      expect(await stops(page)).toBe(1);
    }
    await page.locator("#last").focus();
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("last");
  } finally {
    await page.close();
  }
});

test("open Dropdown menu keys keep their own focus", async () => {
  const page = await open();
  try {
    await page.locator("#menu").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
    expect(await stops(page)).toBe(1);
  } finally {
    await page.close();
  }
});

test("vertical and RTL orientations, modifiers and text-entry keys", async () => {
  const page = await open();
  try {
    await page.locator("#top").focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("bottom");
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("top");
    await page.keyboard.press("ArrowUp");
    expect(await focused(page)).toBe("bottom");
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("bottom");
    await page.locator('[aria-label="Horizontal"]').evaluate((root) => {
      root.setAttribute("dir", "rtl");
    });
    await page.locator("#first").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await focused(page)).toBe("unavailable");
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await focused(page)).toBe("unavailable");
    for (const id of ["text", "textarea", "select", "editable"]) {
      await page.locator(`#${id}`).focus();
      await page.keyboard.press("ArrowRight");
      expect(await focused(page)).toBe(id);
    }
    await page.locator("#checkbox").focus();
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("text");
  } finally {
    await page.close();
  }
});

test("subtree mutations choose a remaining control when the tab stop disappears", async () => {
  const page = await open();
  try {
    await page.locator("#last").focus();
    await page.locator("#last").evaluate((button) => button.setAttribute("disabled", ""));
    await page.waitForSelector('#first[tabindex="0"]');
    await page.locator(".hidden-group").evaluate((group) => group.setAttribute("style", "display:flex"));
    await page.locator("#first").focus();
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("hidden");
    await page.locator("#hidden").evaluate((button) => button.remove());
    await page.waitForSelector('#first[tabindex="0"]');
    expect(await stops(page)).toBe(1);
  } finally {
    await page.close();
  }
});
