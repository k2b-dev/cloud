import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";

// The attachments page in a real browser: a row opens the preview, its menu deletes after asking (and names the notes
// that still show the file), the search writes the address, and the phone shows the worst case without sideways
// scrolling. The test stands in for the server and the attachments API.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_NOTEBOOKS_ATTACHMENTS_SHOTS;
const PATH = "/app/notebooks/Lager1/attachments";

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "attachments.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-attachments-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Attachments harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../cloud")}/`))).default;
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
  // the sidebar body is still v1 (k2b-ui gap: Nav tree), so the page loads Cloud's and the app's stylesheets beside v2
  const [globalCss, appCss] = await Promise.all([
    buildCss(resolve(import.meta.dir, "../../../../../../styles.css")),
    buildCss(resolve(import.meta.dir, "../../../styles/app.css")),
  ]);
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", globalCss, appCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean };
const wide: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const page = (sample: string, permission: string) =>
  `<!doctype html><html lang="de" class="light" data-sample="${sample}" data-permission="${permission}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui"><main class="k2-ui" id="root"></main><script src="/harness.js"></script></body></html>`;

const open = async (view: View, address: string, options: { sample?: string; permission?: "read" | "write" } = {}) => {
  const context: BrowserContext = await browser.newContext({
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
  const pages: string[] = [];
  const deleted: string[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === PATH) {
      pages.push(url.search);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: page(options.sample ?? "normal", options.permission ?? "write"),
      });
    }
    const usage = url.pathname.match(/^\/api\/notebooks\/Lager1\/attachments\/(\w+)\/usage$/);
    if (usage) return route.fulfill({ json: { count: usage[1] === "Att001" ? 2 : 0 } });
    const one = url.pathname.match(/^\/api\/notebooks\/Lager1\/attachments\/(\w+)$/);
    if (one && route.request().method() === "DELETE") {
      deleted.push(one[1]!);
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  // time from the start of the navigation until the list stands, measured in the page
  const ready = await tab.evaluate(
    () =>
      new Promise<number>((done) => {
        const check = () =>
          document.querySelector('[data-k2-part="List"], [data-k2-part="Empty"]') ? done(performance.now()) : requestAnimationFrame(check);
        check();
      }),
  );
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, pages, deleted, ready };
};

const names = (tab: Page) => tab.locator('[data-k2-part="List"] [data-k2-part="Row"] .k2-row-title').allTextContents();
const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `notebooks-attachments-v2-${name}.png`) });
};
const expectOutlineClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
};

describe("the attachments page on v2", () => {
  test("delete: the row's menu asks first, names the notes that show the file, and the row leaves", async () => {
    const { context, tab, errors, deleted } = await open(wide, PATH);
    try {
      expect(await names(tab)).toHaveLength(5);
      await expectOutlineClean(tab);
      await shoot(tab, "light-1440");
      await tab.getByRole("button", { name: "Aktionen für Lageplan_Halle_2.pdf" }).click();
      await tab.getByRole("menuitem", { name: "Anhang löschen" }).click();
      const question = tab.getByRole("alertdialog");
      await question.getByText(/2 Notizen/).waitFor();
      await question.getByRole("button", { name: "Löschen" }).click();
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 4);
      expect(deleted).toEqual(["Att001"]);
      expect(await names(tab)).not.toContain("Lageplan_Halle_2.pdf");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("search: Enter writes the address and the list shows the matches", async () => {
    const { context, tab, errors, pages } = await open(wide, PATH);
    try {
      const search = tab.getByRole("searchbox", { name: "Anhänge durchsuchen" });
      await search.fill("tour");
      await search.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("search") === "tour");
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 1);
      expect(await names(tab)).toEqual(["Tourenplan.csv"]);
      expect(pages.at(-1)).toBe("?search=tour");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("open on phone: the worst case stays within the phone's width and every row keeps its menu", async () => {
    const { context, tab, errors } = await open(phone, PATH, { sample: "worst" });
    try {
      await expectOutlineClean(tab);
      await shoot(tab, "worst-light-390");
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await tab.getByRole("button", { name: /^Aktionen für / }).count()).toBe(7);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
