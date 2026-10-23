import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Route } from "playwright";

type Fixture = (route: Route) => Promise<void>;

import { launchBrowser } from "../../../ui/test/browser";

const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the settings use app classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MachineStorage.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-machine-storage-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Machine storage harness build failed");
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

const open = async (options: BrowserContextOptions, theme: "light" | "dark", lang: string, fixture: Fixture) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://machine-storage.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) return fixture(route);
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, lang) });
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://machine-storage.test/");
  await tab.getByText(lang === "de" ? "Maschinenablagen" : "Machine storage", { exact: true }).waitFor();
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

const owner = { id: "10000000-0000-4000-8000-000000000001", name: "Atlas document processing agent", kind: "agent" as const };
const storage = { id: "20000000-0000-4000-8000-000000000001", baseId: `cloud:users:${owner.id}`, owner, area: "cloud", state: "active" };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const entities = { items: [{ kind: "service_account", serviceAccount: { ...owner, appId: null, resourceType: null, resourceId: null } }] };
describe("Machine storage settings", () => {
  test("loading, failure and retry preserve a working recovery path", async () => {
    const waiting = Promise.withResolvers<void>();
    let failed = true;
    const { context, tab } = await open(desktop, "light", "en", async (route) => {
      await waiting.promise;
      return failed ? json(route, { code: "unavailable", message: "Fixture unavailable" }, 503) : json(route, { items: [], next: null });
    });
    try {
      await tab.getByText("Loading machine storage…", { exact: true }).waitFor();
      if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-loading-desktop-light.png`, fullPage: true });
      waiting.resolve();
      await tab.getByText("Machine storage could not be loaded.", { exact: true }).waitFor();
      if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-error-desktop-light.png`, fullPage: true });
      failed = false;
      await tab.getByRole("button", { name: "Try again", exact: true }).click();
      await tab.getByText("No machine storage", { exact: true }).waitFor();
      expect(await tab.getByRole("button", { name: "Create storage", exact: true }).isDisabled()).toBe(true);
      if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-empty-desktop-light.png`, fullPage: true });
    } finally {
      waiting.resolve();
      await context.close();
    }
  });
  test("choose machine ownership, create, grant a path, and revoke it", async () => {
    let created = false;
    let createAttempts = 0,
      grantAttempts = 0;
    const creating = Promise.withResolvers<void>();
    let grants: {
      id: string;
      principal: { type: "service_account"; serviceAccountId: string };
      permission: string;
      path: string;
      displayName: string;
      serviceAccountKind: "agent";
    }[] = [];
    const { context, tab } = await open(phone, "dark", "en", async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      if (path === "/api/accounts/entities") return json(route, entities);
      if (path.endsWith("/grants") && method === "POST") {
        if (++grantAttempts === 1) return json(route, { code: "unavailable", message: "Grant fixture unavailable" }, 503);
        const input = route.request().postDataJSON();
        expect(input).toEqual({ principal: { type: "service_account", serviceAccountId: owner.id }, path: "reports", permission: "read" });
        grants = [{ ...input, id: "30000000-0000-4000-8000-000000000001", displayName: owner.name, serviceAccountKind: "agent" }];
        return json(route, grants[0]);
      }
      if (method === "DELETE") {
        grants = [];
        return json(route, { deleted: true });
      }
      if (path.endsWith("/grants")) return json(route, { items: grants, next: null });
      if (method === "POST") {
        if (++createAttempts === 1) {
          await creating.promise;
          return json(route, { code: "unavailable", message: "Create fixture unavailable" }, 503);
        }
        expect(route.request().postDataJSON()).toEqual({ ownerId: owner.id, area: "cloud" });
        created = true;
        return json(route, storage);
      }
      return json(route, { items: created ? [storage] : [], next: null });
    });
    try {
      await tab.getByText("No machine storage", { exact: true }).waitFor();
      await tab.getByRole("combobox").first().fill("Atlas");
      await tab.getByRole("option").filter({ hasText: owner.name }).click();
      await tab.getByRole("button", { name: "Create storage", exact: true }).click();
      await tab.locator('button[aria-busy="true"]').waitFor();
      expect(await tab.getByRole("combobox").first().isDisabled()).toBe(true);
      creating.resolve();
      await tab.getByRole("alert").filter({ hasText: "Create fixture unavailable" }).waitFor();
      await tab.getByRole("button", { name: "Create storage", exact: true }).click();
      await tab.getByText("Storage created. Add an explicit grant below.", { exact: true }).waitFor();
      await tab.locator("summary").filter({ hasText: owner.name }).click();
      await tab.getByText("No access granted", { exact: true }).waitFor();
      await tab.getByRole("textbox", { name: "Relative path", exact: true }).fill("reports");
      await tab.getByRole("combobox").last().fill("Atlas");
      await tab.getByRole("option").filter({ hasText: owner.name }).click();
      await tab.getByRole("alert").filter({ hasText: "Grant fixture unavailable" }).waitFor();
      expect(await tab.getByRole("textbox", { name: "Relative path", exact: true }).inputValue()).toBe("reports");
      await tab.getByRole("combobox").last().fill("Atlas");
      await tab.getByRole("option").filter({ hasText: owner.name }).click();
      await tab.getByRole("button", { name: "Revoke", exact: true }).waitFor();
      await tab.getByRole("button", { name: "Revoke", exact: true }).click();
      await tab.getByText("No access granted", { exact: true }).waitFor();
    } finally {
      creating.resolve();
      await context.close();
    }
  });
  test("ownership and grant states fit desktop, tablet and phone in both themes", async () => {
    for (const [device, options] of [
      ["desktop", desktop],
      ["tablet", { viewport: { width: 768, height: 1024 } }],
      ["phone", phone],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        const { context, tab } = await open(options, theme, "en", async (route) =>
          json(
            route,
            new URL(route.request().url()).pathname.endsWith("/grants")
              ? {
                  items: [
                    {
                      id: "30000000-0000-4000-8000-000000000001",
                      principal: { type: "service_account", serviceAccountId: owner.id },
                      displayName: owner.name,
                      serviceAccountKind: "agent",
                      permission: "write",
                      path: "reports/monthly/2026",
                    },
                  ],
                  next: null,
                }
              : {
                  items: [
                    storage,
                    {
                      ...storage,
                      id: "20000000-0000-4000-8000-000000000002",
                      owner: {
                        id: "10000000-0000-4000-8000-000000000002",
                        name: "Meridian scheduled export service account",
                        kind: "standalone",
                      },
                    },
                  ],
                  next: null,
                },
          ),
        );
        try {
          await tab.locator("summary").filter({ hasText: owner.name }).click();
          await tab.getByRole("button", { name: "Revoke", exact: true }).waitFor();
          expect(await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
          if (process.env.SHOTS)
            await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-${device}-${theme}.png`, fullPage: true });
        } finally {
          await context.close();
        }
      }
    }
  }, 90000);
});
