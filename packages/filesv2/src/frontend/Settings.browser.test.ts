import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// #1303: the unreadable configuration notice and its reset fit a phone and read in light and dark.
// The history retention field and its day unit fit as well.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the settings use app classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./Settings.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-files-settings-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Files settings harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const desktop: BrowserContextOptions = { viewport: { width: 1366, height: 768 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, theme: "light" | "dark", lang: string) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://files-settings.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, lang) });
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://files-settings.test/");
  await tab.waitForFunction(() => !!document.querySelector('.k2b-notice-card[data-tone="warning"]'));
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

describe("Files settings with an unreadable configuration in a browser", () => {
  test("the notice and its reset stay inside the page on a phone and a desktop", async () => {
    for (const [device, options] of [
      ["desktop", desktop],
      ["phone", phone],
    ] as const)
      for (const theme of ["light", "dark"] as const)
        for (const lang of ["en", "de"]) {
          const { context, tab } = await open(options, theme, lang);
          try {
            const layout = await tab.evaluate(() => {
              const notice = document.querySelector<HTMLElement>('.k2b-notice-card[data-tone="warning"]')!;
              const card = notice.getBoundingClientRect();
              const reset = notice.querySelector("button")!.getBoundingClientRect();
              const form = document.querySelector("form")!;
              const retention = document.querySelector<HTMLInputElement>('input[name="activity-retention-days"]')!;
              const field = retention.closest<HTMLElement>(".k2b-field")!.getBoundingClientRect();
              const unit = retention.parentElement!.textContent ?? "";
              return {
                overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                first: form.firstElementChild === notice,
                resetInside: reset.width > 0 && reset.left >= card.left && reset.right <= card.right && reset.bottom <= card.bottom,
                // Touch targets on a phone stay at least 32px high.
                resetHeight: reset.height >= 32,
                retentionInside: field.width > 0 && field.left >= 0 && field.right <= window.innerWidth,
                retentionValue: retention.value,
                retentionUnit: /days|Tage/.test(unit),
              };
            });
            expect({ device, theme, lang, ...layout }).toEqual({
              device,
              theme,
              lang,
              overflow: 0,
              first: true,
              resetInside: true,
              resetHeight: true,
              retentionInside: true,
              retentionValue: "365",
              retentionUnit: true,
            });
            if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-${device}-${theme}-${lang}.png` });
          } finally {
            await context.close();
          }
        }
  }, 90_000);
});
