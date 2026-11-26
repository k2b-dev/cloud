import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { loadShellAssets, type ShellAssets } from "../../../../ui/test/shell-page";

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
let harness: string;
let assets: ShellAssets;
beforeAll(async () => {
  harness = await buildHarness();
  // the shell's own stylesheets, Plex fonts and icons, as the page loads them
  assets = await loadShellAssets({ id: "proxy-auth", css: resolve(import.meta.dir, "../../styles/app.css") });
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const document = (state: string) =>
  `<!doctype html><html lang="de" class="light" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">${assets.head}` +
  `<style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const tablet: View = { width: 1024, height: 800, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

/** `failEntities`: the directory search fails this many times before it answers. */
const open = async (view: View, address: string, state = "normal", failEntities = 0) => {
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
  const bodies: unknown[] = [];
  let entityFailures = failEntities;
  // nothing leaves the test origin
  await context.route("**", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (await assets.serve(route, url)) return;
    if (url.pathname === "/admin/proxy-auth") return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(state) });
    if (url.pathname === "/api/accounts/entities" && entityFailures > 0) {
      entityFailures -= 1;
      return route.fulfill({ status: 503, json: { message: "Unavailable" } });
    }
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
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: route.request().method() === "POST" ? { clientId: "pa_new" } : { message: "ok" } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>elsewhere</title>" });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls, bodies };
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
      await shoot(tab, "neuer-client-dialog-1440");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.getByText("https://cloud.example.test/proxy-auth/verify/pa_new").waitFor();
      await shoot(tab, "client-angelegt-1440");
      expect(calls).toEqual(["POST /api/proxy-auth"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a client opens beside the list; deleting asks first and sends only when agreed", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/proxy-auth");
    try {
      await tab.getByRole("link", { name: /Grafana/ }).click();
      await tab.waitForURL(/client=/);
      await tab.waitForSelector('body[data-ready="true"]');
      expect(await tab.getByText("https://cloud.example.test/proxy-auth/verify/pa_grafana").isVisible()).toBe(true);
      // answering no sends nothing
      await tab.getByRole("button", { name: "Löschen" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
      expect(calls).toEqual([]);
      // answering yes sends the one delete
      await tab.getByRole("button", { name: "Löschen" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
      await tab.waitForURL((url) => !url.search.includes("client="));
      expect(calls).toEqual(["DELETE /api/proxy-auth/00000000-0000-4000-8000-000000000000"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("editing sends the description and the groups, the name stays", async () => {
    const { context, tab, errors, calls, bodies } = await open(desktop, "/admin/proxy-auth?client=00000000-0000-4000-8000-000000000001");
    try {
      await tab.getByRole("button", { name: "Bearbeiten" }).click();
      const dialog = tab.getByRole("dialog");
      expect(await dialog.getByRole("textbox", { name: "Clientname" }).count()).toBe(0);
      await dialog.getByRole("textbox", { name: "Beschreibung" }).fill("Belege und Rechnungen");
      await dialog.getByRole("option", { name: "Betrieb" }).click();
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await tab.waitForFunction(() => !window.document.querySelector('[role="dialog"]'));
      expect(calls).toEqual(["PUT /api/proxy-auth/00000000-0000-4000-8000-000000000001"]);
      expect(bodies[0]).toEqual({ description: "Belege und Rechnungen", allowedGroupIds: ["group-1-0", "g-ops"] });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a client that is gone says so beside the list", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/proxy-auth?client=00000000-0000-4000-8000-00000000dead");
    try {
      expect(await tab.getByText("Diesen Client gibt es nicht mehr.").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a directory search that fails says so and loads again on retry", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/proxy-auth", "normal", 1);
    try {
      await tab.getByRole("button", { name: "Neuer Client" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("button", { name: "Erneut versuchen" }).click();
      await dialog.getByRole("option", { name: "Betrieb" }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
