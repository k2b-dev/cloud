import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appColorStyle } from "@k2b/cloud/ssr/app-color";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { DryRunHarnessOptions } from "./MailWorkflowDryRun.browser-harness";

// Whether counts, dots and rows keep their place while a dry run fills is layout, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailWorkflowDryRun.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-workflow-dry-run-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Workflow dry run harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    return new Response(
      `<!doctype html><html class="light" style="--app-accent:#0f766e;${appColorStyle("#0f766e")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
        '<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** `MAIL_DRY_RUN_SCREENSHOTS=<dir>` keeps light screenshots of each state for review. */
const screenshotDir = process.env.MAIL_DRY_RUN_SCREENSHOTS?.trim();
const keep = async (page: Page, name: string) => {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
};

const open = async (context: BrowserContextOptions, options: DryRunHarnessOptions) => {
  const page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.evaluate((harnessOptions) => window.mountWorkflowDryRun(harnessOptions), options);
  await page.getByRole("button", { name: options.locale === "de" ? "YAML bearbeiten" : "Edit YAML" }).click();
  await page.locator("[data-mail-workflow-dry-run]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return Object.assign(page, { errors });
};

const panel = "[data-mail-workflow-dry-run]";
/**
 * Header, bar, dots, AI line and the footer below the list: a finished run must leave them where the running one had
 * them. The footer stays because the list reserves a row for every mail not checked yet; on a phone a row can wrap to a
 * second line once its text arrives, so there only the parts above the list must hold still.
 */
const fixedParts = (page: Page) =>
  page.locator(panel).evaluate((section) => {
    // Relative to the panel, so scrolling the dialog does not count as a shift.
    const origin = section.getBoundingClientRect();
    return ["header", ".h-1\\.5", ".k2b-dot-strip", "[data-dry-run-ai-line]", ":scope > p:last-child"].map((selector) => {
      const box = section.querySelector(selector)?.getBoundingClientRect();
      return box ? { selector, x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height } : { selector };
    });
  });

const startDryRun = async (page: Page, locale: "en" | "de") => {
  const button = page.getByRole("button", { name: locale === "de" ? /^Probelauf/ : /^Dry run/ }).last();
  await button.click();
};

describe("Workflow dry run in the editor", () => {
  for (const [device, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`fills from the left without moving the counts and keeps the result on ${device}`, async () => {
      const page = await open(context, { locale: "de", answerBatches: 2 });
      try {
        await keep(page, `editor-idle-light-${device}`);
        await startDryRun(page, "de");
        await page.getByText("20 von 50 geprüft").waitFor();
        await page.locator(panel).scrollIntoViewIfNeeded();
        const running = await fixedParts(page);
        expect(await page.locator(`${panel} [data-state="pending"]`).count()).toBe(30);
        await keep(page, `editor-running-light-${device}`);

        await page.evaluate(() => window.releaseDryRun());
        await page.locator(`${panel}[data-mail-workflow-dry-run="done"]`).waitFor();
        const finished = await fixedParts(page);
        if (device === "desktop") expect(finished).toEqual(running);
        else expect(finished.slice(0, 4)).toEqual(running.slice(0, 4));
        expect(await page.locator(`${panel} [data-state="pending"]`).count()).toBe(0);
        expect(await page.locator(`${panel} [role="img"]`).getAttribute("aria-label")).toBe(
          "Letzte 50 Mails: 17 treffen zu, 6 übersprungen, 27 nicht",
        );
        expect(await page.getByText("„Lang“ markieren").first().isVisible()).toBe(true);
        await keep(page, `editor-result-light-${device}`);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("Cancel by keyboard keeps focus in place and keeps what was checked", async () => {
    const page = await open(desktop, { locale: "de", answerBatches: 2 });
    try {
      await startDryRun(page, "de");
      await page.getByText("20 von 50 geprüft").waitFor();
      await page.locator(panel).getByRole("button", { name: "Abbrechen" }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("Abgebrochen bei 20 von 50").waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Neu starten");
      expect(await page.locator(`${panel} li[data-outcome]`).count()).toBe(20);
      expect(await page.locator(`${panel} li[data-dry-run-pending]`).count()).toBe(0);
      await page.locator(panel).scrollIntoViewIfNeeded();
      await keep(page, "editor-canceled-light-desktop");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an invalid rule blocks the dry run and says why", async () => {
    const page = await open(desktop, { locale: "de", answerBatches: 5, invalid: true });
    try {
      await page.locator(panel).getByText("Der Probelauf wartet, bis die Regel gültig ist.").waitFor();
      const button = page.getByRole("button", { name: /^Probelauf/ }).last();
      expect(await button.isDisabled()).toBe(true);
      await page.locator(panel).getByRole("heading").click();
      await page.keyboard.press("p");
      expect(await page.evaluate(() => window.dryRunRequests.length)).toBe(0);
      await page.locator(panel).scrollIntoViewIfNeeded();
      await keep(page, "editor-invalid-light-desktop");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a failed batch keeps what was checked and offers to try again", async () => {
    const page = await open(desktop, { locale: "de", answerBatches: 1, failWith: "Das Postfach antwortet gerade nicht." });
    try {
      await startDryRun(page, "de");
      await page.getByText("Erneut versuchen").waitFor();
      expect(await page.locator(`${panel} li[data-outcome]`).count()).toBe(10);
      await page.locator(`${panel} [role="alert"]`).scrollIntoViewIfNeeded();
      await keep(page, "editor-error-light-desktop");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("P starts the dry run outside text entry and never while typing in the YAML", async () => {
    const page = await open(desktop, { locale: "en", answerBatches: 5 });
    try {
      await page.locator(".k2b-autocomplete-editor, [contenteditable], textarea").first().click();
      await page.keyboard.press("p");
      expect(await page.evaluate(() => window.dryRunRequests.length)).toBe(0);
      await page.getByRole("heading", { name: "Dry run without AI · last 50 mails" }).click();
      await page.keyboard.press("p");
      await page.locator(`${panel}[data-mail-workflow-dry-run="done"]`).waitFor();
      expect(await page.evaluate(() => window.dryRunRequests.length)).toBe(5);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
