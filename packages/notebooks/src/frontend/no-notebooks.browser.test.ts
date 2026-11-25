import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";

// Notebooks without any notebook, in a real browser: the first notebook is created from the head (wide, blank and from a
// template) and from the floating main action (phone). The test stands in for the server and the API.
const ui = resolve(import.meta.dir, "../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_NOTEBOOKS_EMPTY_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "no-notebooks.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-no-notebooks-test",
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
  if (!build.success) throw new AggregateError(build.logs, "No-notebooks harness build failed");
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
  css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const tablet: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };

const page = () =>
  `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type Seen = { created: unknown[]; fromTemplate: { templateId: string; body: unknown }[]; opened: string[] };

const open = async (view: View) => {
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
  const seen: Seen = { created: [], fromTemplate: [], opened: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/app/notebooks") return route.fulfill({ contentType: "text/html; charset=utf-8", body: page() });
    if (url.pathname.startsWith("/app/notebooks/")) {
      seen.opened.push(url.pathname);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Notizbuch</title>" });
    }
    if (url.pathname === "/api/notebooks" && method === "POST") {
      seen.created.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: "Neu001" } });
    }
    const template = url.pathname.match(/^\/api\/notebooks\/templates\/([^/]+)$/);
    if (template && method === "POST") {
      seen.fromTemplate.push({ templateId: template[1]!, body: route.request().postDataJSON() });
      return route.fulfill({ status: 201, json: { id: "Neu002" } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}/app/notebooks`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `notebooks-empty-v2-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

describe("Notebooks without a notebook on v2", () => {
  test("create: a blank notebook from the head, with its name and description, opens the new notebook", async () => {
    const { context, tab, errors, seen } = await open(wide);
    try {
      await tab.getByText("Du kannst noch kein Notizbuch öffnen. Erstelle das erste.").waitFor();
      await expectClean(tab);
      await shoot(tab, "light-1440");
      await tab.getByRole("button", { name: "Neues Notizbuch" }).first().click();
      const dialog = tab.getByRole("dialog", { name: "Neues Notizbuch" });
      await dialog.waitFor();
      // a blank notebook needs a name: the dialog says so at the field and sends nothing
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await dialog.getByText("Gib dem Notizbuch einen Namen.").waitFor();
      expect(seen.created).toEqual([]);
      await dialog.getByRole("textbox", { name: "Name" }).fill("Werkstatt");
      await dialog.getByRole("textbox", { name: /Beschreibung/ }).fill("Aufträge und Teile");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.waitForURL(`${origin}/app/notebooks/Neu001`);
      expect(seen.created).toEqual([{ name: "Werkstatt", description: "Aufträge und Teile" }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("create: a notebook from a template takes the template's name when none is typed", async () => {
    const { context, tab, errors, seen } = await open(tablet);
    try {
      await expectClean(tab);
      await tab.getByRole("button", { name: "Neues Notizbuch" }).first().click();
      const dialog = tab.getByRole("dialog", { name: "Neues Notizbuch" });
      await dialog.getByRole("radio", { name: "Rezepte" }).check();
      // the chosen template's description stands at the choice; a template has no description field
      await dialog.getByText("Zutaten, Schritte und Bilder.").waitFor();
      expect(await dialog.getByRole("textbox", { name: /Beschreibung/ }).count()).toBe(0);
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.waitForURL(`${origin}/app/notebooks/Neu002`);
      expect(seen.fromTemplate).toEqual([{ templateId: "recipe", body: {} }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("open on phone: the floating main action creates the first notebook", async () => {
    const { context, tab, errors, seen } = await open(phone);
    try {
      await expectClean(tab);
      await shoot(tab, "light-390");
      await tab.locator(".k2-fab").tap();
      const dialog = tab.getByRole("dialog", { name: "Neues Notizbuch" });
      await dialog.getByRole("textbox", { name: "Name" }).fill("Unterwegs");
      await dialog.getByRole("button", { name: "Erstellen" }).tap();
      await tab.waitForURL(`${origin}/app/notebooks/Neu001`);
      expect(seen.created).toEqual([{ name: "Unterwegs" }]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
