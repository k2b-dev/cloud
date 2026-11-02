import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appColorStyle } from "@k2b/cloud/ssr/app-color";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

// The "Needs attention" row and the editor's notice are layout, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailIncomingAutomationAttention.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-incoming-automations-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Incoming automation harness build failed");
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

/** `MAIL_INCOMING_SCREENSHOTS=<dir>` keeps light screenshots of each state for review. */
const screenshotDir = process.env.MAIL_INCOMING_SCREENSHOTS?.trim();
const keep = async (page: Page, name: string) => {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
};

const open = async (context: BrowserContextOptions) => {
  const page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors = pageErrors(page);
  await page.goto(server.url.href);
  await page.evaluate(() => window.mountIncomingAutomations("de"));
  await page.locator("[data-incoming-automations]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return Object.assign(page, { errors });
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe("Mail incoming automations that need attention", () => {
  for (const [device, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`the row says what to do, cannot be switched on, and its editor repeats the step on ${device}`, async () => {
      const page = await open(context);
      try {
        // One notice above the list says what to do; the row marks the automation without clipping its badge.
        await page.getByText("„Lieferungen in Space Logistik“ braucht dich.").waitFor();
        await page
          .getByText("Bitte Spaces-Zugriff bestätigen: Automatisierung bearbeiten, Spaces-Ziele erneut auswählen und speichern.", {
            exact: false,
          })
          .waitFor();
        const badge = page.locator("table").getByText("Prüfung erforderlich");
        await badge.waitFor();
        expect(await badge.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
        const cell = await badge.locator("xpath=ancestor::td[1]").boundingBox();
        const box = await badge.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(cell!.x + cell!.width);
        // Switching on waits for the confirmation; the other automation keeps its switch.
        const switches = page.locator('input[type="checkbox"]');
        expect(await switches.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).disabled))).toEqual([false, true]);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await keep(page, `needs-attention-list-${device}`);

        await page.getByRole("button", { name: "Automatisierung bearbeiten", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Prüfung erforderlich").waitFor();
        await dialog.getByText("Spaces-Ziele erneut auswählen", { exact: false }).waitFor();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        // The footer hint never runs under the buttons: on a phone the buttons move below it.
        const hintBox = await dialog.getByText("Zur Prüfung inaktiv gespeichert.").boundingBox();
        const cancelBox = await dialog.getByRole("button", { name: "Abbrechen" }).boundingBox();
        expect(hintBox!.x + hintBox!.width <= cancelBox!.x || hintBox!.y + hintBox!.height <= cancelBox!.y).toBe(true);
        await keep(page, `needs-attention-editor-${device}`);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 40_000);
  }
});
