import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

// Native dialog focus, popovers, and Escape must cooperate in the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "combobox-dialog.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { prompts, Combobox } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.openComboboxDialog = () => void prompts.dialog(
  () => createComponent(Combobox, {
    label: "Add people",
    debounceMs: 0,
    fetchData: async () => [
      { id: "alice", label: "Alice" },
      { id: "bob", label: "Bob" },
    ],
    onSelect: () => {},
  }),
  { title: "Manage access" },
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the combobox dialog fixture for the browser.");
const script = await build.outputs[0]!.text();

declare global {
  interface Window {
    openComboboxDialog: () => void;
  }
}

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.openComboboxDialog());
    // The dialog applies initial focus in the next animation frame.
    await page.waitForFunction(() => document.activeElement?.matches('dialog[open] input[role="combobox"]'), undefined, { timeout: 2_000 });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};

describe("@k2b/ui Combobox focus and Escape inside a dialog", () => {
  test("opening a dialog focuses its search field without opening the list, and one Escape closes the dialog", async () => {
    const page = await open();
    try {
      expect(await page.getByRole("combobox").getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator(":popover-open").count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "hidden", timeout: 2_000 });
    } finally {
      await page.close();
    }
  });

  test("with focus outside the dialog, one Escape still closes it", async () => {
    const page = await open();
    try {
      // Escape with focus outside the field was ruled out as the WebKit cause.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "hidden", timeout: 2_000 });
    } finally {
      await page.close();
    }
  });

  test("with the list open, Escape closes only the list, and the next Escape closes the dialog", async () => {
    const page = await open();
    try {
      const input = page.getByRole("combobox");
      await input.click();
      await page.getByRole("option").first().waitFor({ state: "visible", timeout: 2_000 });
      await page.keyboard.press("Escape");
      expect(await input.getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator(":popover-open").count()).toBe(0);
      expect(await page.locator("dialog[open]").isVisible()).toBe(true);
      expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "hidden", timeout: 2_000 });
    } finally {
      await page.close();
    }
  });

  test("typing and Arrow Down still open the list", async () => {
    const page = await open();
    try {
      const input = page.getByRole("combobox");
      await page.keyboard.press("ArrowDown");
      await page.getByRole("option").first().waitFor({ state: "visible", timeout: 2_000 });
      expect(await input.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      expect(await input.getAttribute("aria-expanded")).toBe("false");
      await page.keyboard.type("a");
      await page.getByRole("option").first().waitFor({ state: "visible", timeout: 2_000 });
      expect(await input.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await page.close();
    }
  });
});
