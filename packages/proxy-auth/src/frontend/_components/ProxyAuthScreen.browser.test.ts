import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// Proxy Auth on v2, from invented clients: the screen keeps the v2 layout rules at desktop, tablet and phone width with
// normal, worst-case and no data; a client opens beside the list, and creating, editing and deleting ask and report.
// `CLOUD_PROXY_AUTH_V2_SHOTS=<dir>` also saves a light screenshot per data set and width.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_PROXY_AUTH_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "ProxyAuthScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-proxy-auth-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Proxy Auth harness build failed");
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
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const document = (state: string) =>
  `<!doctype html><html lang="de" class="light" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const tablet: View = { width: 1024, height: 800, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const open = async (view: View, address: string, state = "normal") => {
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
  const calls: string[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/proxy-auth") return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(state) });
    if (url.pathname === "/api/accounts/entities")
      return route.fulfill({
        json: {
          items: [
            { kind: "group", group: { id: "g-ops", name: "Betrieb" } },
            { kind: "group", group: { id: "g-lead", name: "Leitung" } },
          ],
        },
      });
    if (url.pathname.startsWith("/api/proxy-auth")) {
      calls.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({ json: route.request().method() === "POST" ? { clientId: "pa_new" } : { message: "ok" } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>elsewhere</title>" });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("Proxy Auth on v2", () => {
  test("the screen keeps the v2 rules at 1440, 1024 and 390 px, with normal, worst-case and no data", async () => {
    const cases: [string, string, View][] = [
      ["normal", "", desktop],
      ["normal", "", tablet],
      ["normal", "", phone],
      ["worst", "", desktop],
      ["worst", "", phone],
      ["empty", "", desktop],
      ["normal", "?tab=setup", desktop],
      ["normal", "?tab=setup", phone],
      ["normal", "?client=00000000-0000-4000-8000-000000000003", desktop],
      ["worst", "?client=00000000-0000-4000-8000-00000000000a", phone],
    ];
    for (const [state, search, view] of cases) {
      const name = `proxy-auth${search.includes("client=") ? "-record" : search.includes("tab=setup") ? "-setup" : ""}-${state}-${view.width}`;
      const { context, tab, errors } = await open(view, `/admin/proxy-auth${search}`, state);
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, problems: outline.includes("Problems (") ? outline : "" }).toEqual({ name, problems: "" });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 300_000);

  test("a new client needs a name and a group, then shows its verify address once", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/proxy-auth");
    try {
      await tab.getByRole("button", { name: "Neuer Client" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      expect(await dialog.innerText()).toContain("Gib einen Namen ein");
      await dialog.getByRole("textbox", { name: "Clientname" }).fill("Wiki");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      expect(await dialog.innerText()).toContain("Wähle mindestens eine Gruppe");
      await dialog.getByRole("option", { name: "Betrieb" }).click();
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.getByText("https://cloud.example.test/proxy-auth/verify/pa_new").waitFor();
      expect(calls).toEqual(["POST /api/proxy-auth"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a client opens beside the list; deleting asks first", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/proxy-auth");
    try {
      await tab.getByRole("link", { name: /Grafana/ }).click();
      await tab.waitForURL(/client=/);
      await tab.waitForSelector('body[data-ready="true"]');
      expect(await tab.getByText("https://cloud.example.test/proxy-auth/verify/pa_grafana").isVisible()).toBe(true);
      await tab.getByRole("button", { name: "Löschen" }).click();
      await tab.getByRole("alertdialog").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
