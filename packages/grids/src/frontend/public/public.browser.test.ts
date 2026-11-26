import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// The public document share and the public form on v2, in a real browser: the v2 rules hold at 1440, 1024 and 390 px
// for the plain and the worst case, and a link that no longer works says so without its task. The test stands in for
// the server: the pages answer from invented data.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.GRIDS_PUBLIC_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "public.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-grids-public-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Grids public harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../../cloud")))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  css = [
    "@layer properties, theme, base, components, utilities;",
    await buildCss(resolve(import.meta.dir, "../../../../../styles.css")),
    await buildCss(resolve(import.meta.dir, "../../styles/app.css")),
    readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8"),
  ].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const views: View[] = [
  { width: 1440, height: 900, touch: false, name: "1440" },
  { width: 1024, height: 768, touch: false, name: "1024" },
  { width: 390, height: 844, touch: true, name: "390" },
];

const page = () =>
  `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const open = async (view: View, address: string) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/share/")) return route.fulfill({ contentType: "text/html; charset=utf-8", body: page() });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("the public pages of Grids on v2", () => {
  for (const [name, address] of [
    ["document", "/share/grids/documents/gdl_test"],
    ["document-worst", "/share/grids/documents/gdl_test?worst"],
    ["document-gone", "/share/grids/documents/gone"],
    ["form", "/share/grids/forms/frm_test"],
    ["form-worst", "/share/grids/forms/frm_test?worst"],
    ["form-gone", "/share/grids/forms/gone"],
  ] as const)
    test(`${name} keeps the v2 rules at 1440, 1024 and 390 px`, async () => {
      for (const view of views) {
        const { context, tab, errors } = await open(view, address);
        try {
          await shoot(tab, `grids-public-${name}-light-${view.name}`);
          await tab.mouse.move(0, 0);
          const outline = await describeV2Page(tab, "#root");
          expect(outline.includes("Problems (") ? outline : "").toBe("");
          expect((await measureV2Layout(tab, { root: "[data-k2-workspace]" })).problems).toEqual([]);
          // a link that no longer works offers no download and no form
          if (name.endsWith("-gone")) expect(await tab.locator("a[href*='/download'], form").count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }, 90_000);
});
