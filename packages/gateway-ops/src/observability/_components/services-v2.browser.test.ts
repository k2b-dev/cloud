import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// The service pages of Observability on v2, from invented fixtures: each keeps the v2 layout rules at desktop, tablet
// and phone width, and the deeds that change data (dead letters, manual runs, diagnostics access) ask, send once and
// report. `CLOUD_SERVICES_V2_SHOTS=<dir>` also saves a light screenshot per screen and width plus `evidence.json`.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_SERVICES_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "services-v2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-services-v2-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Services harness build failed");
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

const html = (screen: string, worst: boolean) =>
  `<!doctype html><html lang="de" class="light" data-screen="${screen}" data-worst="${worst}" data-locale="de"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { name: string; width: number; height: number; touch: boolean };
const desktop: View = { name: "1440", width: 1440, height: 900, touch: false };
const tablet: View = { name: "1024", width: 1024, height: 768, touch: false };
const phone: View = { name: "390", width: 390, height: 844, touch: true };

type Api = (route: Route, url: URL) => Promise<void> | void;

const open = async (view: View, screen: string, address: string, options: { worst?: boolean; api?: Api } = {}) => {
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
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname.startsWith("/api/"))
      return options.api ? options.api(route, url) : route.fulfill({ status: 404, json: { message: "Not found" } });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: html(screen, options.worst ?? false) });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors };
};

const SCREENS = [
  ["nats", "/admin/observability/nats?state=problems&stream=MAIL_DLQ"],
  ["access", "/admin/observability/nats/access"],
  ["sync", "/admin/observability/nats/sync?storeApp=mail&store=outbox&kind=queue&message=m-1"],
  ["valkey", "/admin/observability/valkey?depth=2"],
  ["postgres", "/admin/observability/postgres?schema=mail&sort=rows.desc"],
  ["metrics", "/admin/observability/metrics?type=gauge"],
  ["telemetry", "/admin/observability/telemetry?only=errors&route=/app/mail/api/send"],
  ["browser", "/admin/observability/telemetry?view=browser"],
  ["workflows", "/admin/observability/workflows?run=6f1c2d3e-0000-4000-8000-000000000001"],
] as const;

describe("the service pages of Observability on v2", () => {
  test("every screen and its worst case keep the v2 rules at 1440, 1024 and 390 px", async () => {
    const evidence: Record<string, { elements: number; loaders: number }> = {};
    const findings: string[] = [];
    for (const view of [desktop, tablet, phone]) {
      for (const [screen, address] of SCREENS) {
        for (const worst of [false, true]) {
          const { context, tab, errors } = await open(view, screen, address, { worst });
          try {
            const outline = await describeV2Page(tab, "#root");
            const problems = outline.includes("Problems (") ? outline.slice(outline.indexOf("Problems (")) : "";
            const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
            const where = `${screen}${worst ? " worst" : ""} @${view.name}`;
            if (problems) findings.push(`${where}: ${problems}`);
            for (const problem of layout.problems) findings.push(`${where}: ${problem}`);
            if (!worst && view === desktop) {
              evidence[screen] = await tab.evaluate(() => ({
                elements: document.querySelectorAll("#root *").length,
                loaders: document.querySelectorAll('[data-k2-part="Loading"]').length,
              }));
              expect(evidence[screen]?.loaders).toBe(0);
            }
            if (shots && view !== tablet) await tab.screenshot({ path: join(shots, `${screen}${worst ? "-worst" : ""}-${view.name}.png`) });
            for (const error of errors) findings.push(`${where}: ${error}`);
          } finally {
            await context.close();
          }
        }
      }
    }
    if (shots) writeFileSync(join(shots, "evidence.json"), JSON.stringify(evidence, null, 2));
    expect(findings).toEqual([]);
  }, 600_000);

  test("a dead letter is deleted only after the question, once, and leaves the list", async () => {
    const deletes: string[] = [];
    const { context, tab, errors } = await open(desktop, "sync", "/admin/observability/nats/sync", {
      api: (route, url) => {
        if (route.request().method() === "DELETE") deletes.push(url.pathname);
        return route.fulfill({ json: { success: true } });
      },
    });
    try {
      await tab.locator('[data-k2-part="Table"]').first().getByRole("button", { name: "Aktionen" }).first().click();
      await tab.getByRole("menuitem", { name: "Dead Letter löschen" }).click();
      const dialog = tab.getByRole("alertdialog");
      await dialog.waitFor();
      expect(deletes).toEqual([]);
      await dialog.getByRole("button", { name: "Dead Letter löschen" }).click();
      await tab.getByText("Dead Letter gelöscht").waitFor();
      expect(deletes).toEqual(["/api/gateway/sync/dead-letters/mail/queue/outbox/m-1"]);
      expect(await tab.getByText("handler_failed — SMTP 451: greylisted").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Run now retries an unclear acceptance with the same request and never claims success before the result", async () => {
    const requestIds: string[] = [];
    let reads = 0;
    const { context, tab, errors } = await open(desktop, "sync", "/admin/observability/nats/sync", {
      api: (route, url) => {
        if (route.request().method() === "POST" && url.pathname.endsWith("/run-now")) {
          requestIds.push(route.request().postDataJSON().requestId);
          if (requestIds.length === 1) return route.abort("connectionreset");
          return route.fulfill({ json: { runId: "retained-run" } });
        }
        reads++;
        return route.fulfill({ json: { completed: reads > 1, error: null } });
      },
    });
    try {
      const run = tab.getByRole("button", { name: "Jetzt ausführen" }).first();
      const agree = async () => {
        const dialog = tab.getByRole("alertdialog");
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Jetzt ausführen" }).click();
      };
      await run.click();
      await agree();
      await tab.getByText("Annahme unklar").waitFor();
      await run.click();
      await agree();
      await tab.waitForFunction(() => document.body.innerText.includes("Angenommen"));
      expect(requestIds).toHaveLength(2);
      expect(requestIds[1]).toBe(requestIds[0]!);
      expect(await tab.locator('[data-k2-part="Chip"][data-status="ok"]', { hasText: "Abgeschlossen" }).count()).toBe(0);
      await tab.getByRole("button", { name: "Ergebnis prüfen" }).first().click();
      await tab.locator('[data-k2-part="Chip"][data-status="ok"]', { hasText: "Abgeschlossen" }).first().waitFor();
      expect(requestIds).toHaveLength(2);
      expect(errors.filter((error) => !error.includes("Failed to fetch"))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("diagnostics access keeps pasted content, saves from the head and forgets the secret afterwards", async () => {
    const puts: { url: string; body: unknown }[] = [];
    for (const view of [desktop, phone]) {
      const { context, tab, errors } = await open(view, "access", "/admin/observability/nats/access", {
        api: (route, url) => {
          if (route.request().method() === "PUT") puts.push({ url: url.pathname, body: route.request().postDataJSON() });
          return route.fulfill({ json: { success: true } });
        },
      });
      try {
        const access = tab.getByRole("textbox", { name: /^Systemzugang/ });
        expect(await access.getAttribute("spellcheck")).toBe("false");
        const content = "-----BEGIN NATS USER JWT-----\nsynthetic fixture\n------END NATS USER JWT------";
        await access.fill(content);
        await tab.getByRole("button", { name: "Speichern" }).last().click();
        // the head says "Gespeichert"; on the phone the head keeps only the save button
        await tab.waitForFunction(() => (document.querySelectorAll("textarea")[1] as HTMLTextAreaElement | undefined)?.value === "");
        expect(puts.at(-1)).toEqual({
          url: "/api/gateway/settings/gateway.nats_admin_access",
          body: { value: content, replaceUnreadable: false },
        });
        expect(await access.inputValue()).toBe("");
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);
});
