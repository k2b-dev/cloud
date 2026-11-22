import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Escape closes a dialog from the moment it opens (#3916). A browser may close a modal dialog on a close request
// without a `cancel` event, such as Escape without a recent user activation (close watchers); the dialog must then
// stay closed, unless its own guard or `cancelBehavior: "ignore"` keeps it.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dialog-escape.fixture.ts");
const fixture = `
import { dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.results = [];
window.dialogCoreClose = () => dialogCore.close();
window.openPlain = () => {
  void dialogCore
    .open((close) => {
      const body = document.createElement("div");
      body.innerHTML = '<a href="#one">Invented app</a><button type="button">Done</button>';
      return body;
    }, { initialFocus: (dialog) => dialog.querySelector("a[href]") })
    .then((value) => window.results.push(value === undefined ? "dismissed" : value));
};
window.openKept = () => {
  void dialogCore.open(() => {
    const body = document.createElement("button");
    body.textContent = "Must answer";
    return body;
  }, { cancelBehavior: "ignore" });
};
window.guarded = 0;
window.openGuarded = () => {
  void dialogCore.open((close, context) => {
    context.setDismissHandler(() => {
      window.guarded++;
    });
    const body = document.createElement("button");
    body.textContent = "Unsaved";
    return body;
  });
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog Escape fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><main id="app"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};
type Fixture = { openPlain: () => void; openKept: () => void; openGuarded: () => void; results: string[]; guarded: number };
const call = (page: Page, name: "openPlain" | "openKept" | "openGuarded") =>
  page.evaluate((name) => (window as unknown as Fixture)[name](), name);

// What a close watcher does when it skips the cancel event: the frame closes natively, and nothing else happens.
const closeWithoutCancel = (page: Page) => page.evaluate(() => document.querySelector("dialog")!.close());

describe("Escape closes a dialog from the moment it opens", () => {
  test("a close request the browser carries out without a cancel event dismisses the dialog for good", async () => {
    const page = await load();
    try {
      await call(page, "openPlain");
      await page.locator("dialog[open]").waitFor();
      await closeWithoutCancel(page);
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as Fixture).results)).toEqual(["dismissed"]);
    } finally {
      await page.close();
    }
  });

  test("a close without a cancel event keeps a dialog that must be answered, and asks a guard", async () => {
    const page = await load();
    try {
      await call(page, "openKept");
      await page.locator("dialog[open]").waitFor();
      await closeWithoutCancel(page);
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      await page.evaluate(() => (window as unknown as { dialogCoreClose: () => void }).dialogCoreClose());
      await settled(page);
      await call(page, "openGuarded");
      await page.locator("dialog[open]").waitFor();
      await closeWithoutCancel(page);
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as Fixture).guarded)).toBe(1);
    } finally {
      await page.close();
    }
  });

  test("opened without a user activation, as after a lazy load: Escape closes it and it stays closed", async () => {
    const page = await load();
    try {
      // No click before: the page has no user activation, so the browser may close without a cancel event.
      await call(page, "openPlain");
      await page.locator("dialog[open]").waitFor();
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as Fixture).results)).toEqual(["dismissed"]);
    } finally {
      await page.close();
    }
  });

  test("Escape pressed in the same moment the dialog opens closes it", async () => {
    const page = await load();
    try {
      // A click on the page gives it a user activation, as the click on a launcher button does.
      await page.mouse.click(5, 5);
      await call(page, "openPlain");
      // No wait for initial focus or a frame: the key comes right after the open.
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as Fixture).results)).toEqual(["dismissed"]);
    } finally {
      await page.close();
    }
  });

  test("a dialog that must be answered stays open on Escape, also without a user activation", async () => {
    const page = await load();
    try {
      await call(page, "openKept");
      await page.locator("dialog[open]").waitFor();
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  test("a guarded dialog asks its guard on Escape and stays open, also without a user activation", async () => {
    const page = await load();
    try {
      await call(page, "openGuarded");
      await page.locator("dialog[open]").waitFor();
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as Fixture).guarded)).toBe(1);
    } finally {
      await page.close();
    }
  });
});
