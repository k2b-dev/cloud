import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appColorStyle } from "@k2b/cloud/ssr/app-color";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

// Verify the migration warning and recovery action in the real settings layout, including phone overflow.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailIncomingAutomationSettings.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-incoming-automation-test",
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

/** `MAIL_AUTOMATION_SCREENSHOTS=<dir>` keeps light screenshots of each state for review. */
const screenshotDir = process.env.MAIL_AUTOMATION_SCREENSHOTS?.trim();
const keep = async (page: Page, name: string) => {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
};

for (const [width, context] of [
  [1440, desktop],
  [390, phone],
] as const) {
  test(`shows target confirmation and opens recovery at ${width}px`, async () => {
    const page = await (await browser.newContext(context)).newPage();
    const errors = pageErrors(page);
    try {
      await page.goto(server.url.href);
      await page.getByText("Needs attention", { exact: true }).waitFor();
      const edit = page.getByRole("button", { name: "Edit automation", exact: true });
      expect(await edit.isVisible()).toBe(true);
      const hint = page.getByText(/choose its Spaces destinations again, and save/);
      expect(await hint.isVisible()).toBe(true);
      expect(await hint.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const editBox = await edit.boundingBox();
      expect(editBox!.x + editBox!.width).toBeLessThanOrEqual(width);
      expect(await page.locator('input[type="checkbox"]').isDisabled()).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await keep(page, `mail-needs-attention-light-${width}`);
      await edit.click();
      await page.getByText("Edit incoming automation", { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
}
