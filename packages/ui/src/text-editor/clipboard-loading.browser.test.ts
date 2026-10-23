import { afterAll, beforeAll, expect, test } from "bun:test";
import { basename } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import type {} from "../../test/clipboard-grid.fixture";
import type {} from "../../test/text-editor-browser-harness";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let sanitizerPath: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL("../../test/text-editor-browser-harness.ts", import.meta.url).pathname,
      new URL("../../test/clipboard-grid.fixture.ts", import.meta.url).pathname,
    ],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    splitting: true,
  });
  if (!build.success) throw new AggregateError(build.logs);
  const scripts = new Map<string, string>();
  let entry = "";
  let gridEntry = "";
  for (const output of build.outputs) {
    const path = `/${basename(output.path)}`;
    const source = await output.text();
    scripts.set(path, source);
    if (output.kind === "entry-point") {
      if (path.includes("clipboard-grid")) gridEntry = path;
      else entry = path;
    }
    if (source.includes("function createDOMPurify")) sanitizerPath = path;
  }
  expect(sanitizerPath).toBeDefined();
  expect(sanitizerPath).not.toBe(entry);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const source = scripts.get(path);
      return source !== undefined
        ? new Response(source, { headers: { "content-type": "application/javascript" } })
        : new Response(
            `<!doctype html><html><body><div id="root"></div><script type="module" src="${path === "/grid" ? gridEntry : entry}"></script></body></html>`,
            {
              headers: { "content-type": "text/html" },
            },
          );
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const paste = (page: Page, html = "<b>pasted</b>") =>
  page.evaluate((html) => {
    const data = new DataTransfer();
    data.setData("text/plain", "pasted");
    if (html) data.setData("text/html", html);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, html);

for (const outcome of ["apply", "peer-edit", "selection-change", "read-only", "load-failure"] as const) {
  test(`deferred HTML paste: ${outcome}`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const request = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(`**${sanitizerPath}`, async (route) => {
      requested();
      await blocked;
      if (outcome === "load-failure") await route.abort();
      else await route.continue();
    });
    try {
      await page.goto(server.url.href);
      const cell = page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]');
      await cell.click();
      await page.keyboard.press("End");
      await paste(page);
      await request;
      expect(await page.evaluate(() => window.sharedEditorHarness.text())).not.toContain("pasted");
      if (outcome === "peer-edit") await page.evaluate(() => window.sharedEditorHarness.remote(0, "peer "));
      if (outcome === "selection-change") await page.keyboard.press("Home");
      if (outcome === "read-only") await page.evaluate(() => window.sharedEditorHarness.readOnly(true));
      release();
      if (outcome === "apply") {
        await page.waitForFunction(() => window.sharedEditorHarness.text().includes("Paperpasted"));
        expect(await page.evaluate(() => window.sharedEditorHarness.errors())).toEqual([]);
      } else {
        await page.waitForFunction(() => window.sharedEditorHarness.errors().includes("recovery:pasted"));
        expect(await page.evaluate(() => window.sharedEditorHarness.text())).not.toContain("pasted");
        if (outcome === "peer-edit") expect(await page.evaluate(() => window.sharedEditorHarness.text())).toStartWith("peer ");
      }
      expect(errors).toEqual([]);
    } finally {
      release();
      await context.close();
    }
  });
}

test("plain paste does not request the HTML sanitizer", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  try {
    await page.goto(server.url.href);
    await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
    await page.keyboard.press("End");
    await paste(page, "");
    expect(await page.evaluate(() => window.sharedEditorHarness.text())).toContain("Paperpasted");
    expect(requests).not.toContain(sanitizerPath);
  } finally {
    await context.close();
  }
});

test("public tableGrid composition lazily loads its HTML paste parser", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(new URL("grid", server.url).href);
    await page.locator('.k2b-ste-cell[data-r="1"][data-c="0"]').click();
    await page.keyboard.press("End");
    await paste(page);
    await page.waitForFunction(() => window.clipboardGrid.text().includes("Paperpasted"));
    expect(await page.evaluate(() => window.clipboardGrid.errors())).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
