import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// Layout stability of the "Code with access" section needs the real layout engine. Set
// CODE_ACCESS_SCREENSHOTS to a directory to also keep light screenshots of each state.
const screenshots = process.env.CODE_ACCESS_SCREENSHOTS;
const accounts = {
  items: [
    { id: "22222222-2222-4222-8222-222222222222", ownerTitle: "info@", appId: "mail", icon: "ti ti-mail", accent: "#0f766e" },
    { id: "33333333-3333-4333-8333-333333333333", ownerTitle: "Einkauf", appId: "grids", icon: "ti ti-layout-grid", accent: "#008f4c" },
  ],
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };

const buildHarness = async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CodeAccessSection.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-code-access-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Code access harness build failed");
  return build.outputs[0]!.text();
};
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  harness = await buildHarness();
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("Missing Tabler WOFF2 file");
  icons = { css: source.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
  if (screenshots) mkdirSync(screenshots, { recursive: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type Handlers = { accounts: (route: Route) => unknown; remove?: (route: Route) => unknown };
const open = async (width: number, handlers: Handlers, query = "") => {
  const tab = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, reducedMotion: "reduce" });
  await tab.clock.setFixedTime(new Date("2026-10-31T12:00:00.000Z"));
  const origin = "https://code-access.test";
  await tab.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/tabler.woff2") return route.fulfill({ path: icons.font });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: icons.css });
    if (path === "/api/resources/code-access/accounts") return handlers.accounts(route);
    if (path === "/api/resources/code-access/remove") return handlers.remove ? handlers.remove(route) : route.abort();
    if (path.startsWith("/api/")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui"><script id="cloud-shell-data" type="application/json">{"appId":"spaces","apps":[]}</script><div id="root"></div></body></html>`,
    });
  });
  await tab.goto(`${origin}/${query}`);
  await tab.addScriptTag({ content: harness });
  await settled(tab);
  return tab;
};
const deferred = () => {
  const pending: Route[] = [];
  return {
    handler: (route: Route) => {
      pending.push(route);
    },
    pending,
  };
};
const snapshot = (tab: Page) =>
  tab.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { y: Math.round(rect.y), height: Math.round(rect.height) } : null;
    };
    const section = document.querySelector("section");
    return {
      dialog: box(document.querySelector("dialog .k2b-dialog__panel")),
      heading: box(section?.querySelector("h3") ?? null),
      rows: Array.from(document.querySelectorAll("[data-code-access-row]")).map(box),
      hint: box(section?.querySelector("p") ?? null),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
const shot = async (tab: Page, name: string) => {
  if (!screenshots) return;
  await settled(tab);
  await tab.screenshot({ path: resolve(screenshots, `${name}.png`) });
};

describe("Code with access in a share dialog", () => {
  for (const width of [390, 1024, 1440]) {
    test(`${width}px: loading, loaded and removing keep every position`, async () => {
      const load = deferred();
      const removal = deferred();
      const tab = await open(width, { accounts: load.handler, remove: removal.handler });
      try {
        await tab.waitForFunction(() => document.querySelector("section")?.getAttribute("aria-busy") === "true");
        const loading = await snapshot(tab);
        await shot(tab, `${width}-loading`);
        expect(loading.rows).toHaveLength(2);
        await load.pending[0]!.fulfill({ json: accounts });
        await tab.waitForFunction(() => document.querySelector("section")?.getAttribute("aria-busy") === null);
        const loaded = await snapshot(tab);
        await shot(tab, `${width}-entries`);
        expect(loaded).toEqual(loading);
        expect(loaded.overflow).toBeLessThanOrEqual(0);
        await tab.getByRole("button", { name: "Zugriff von „Code von info@“ entfernen" }).click();
        await tab.getByRole("dialog", { name: "Zugriff von „Code von info@“ entfernen?" }).waitFor();
        await shot(tab, `${width}-confirm`);
        await tab.getByRole("button", { name: "Zugriff entfernen", exact: true }).click();
        await tab.waitForFunction(() => document.querySelector("[data-code-access-row][aria-busy=true]") !== null);
        expect(await snapshot(tab)).toEqual(loaded);
        await shot(tab, `${width}-removing`);
        expect(removal.pending).toHaveLength(1);
        await removal.pending[0]!.fulfill({ status: 403, json: { code: "FORBIDDEN", message: "Target manager authority required" } });
        await tab.getByRole("alert").waitFor();
        await shot(tab, `${width}-remove-failed`);
        expect((await tab.getByRole("alert").textContent()) ?? "").toContain("Du verwaltest das hier nicht mehr");
        expect((await snapshot(tab)).overflow).toBeLessThanOrEqual(0);
      } finally {
        await tab.close();
      }
    }, 30_000);
  }

  for (const width of [390, 1440]) {
    test(`${width}px: a failed load keeps people and offers a retry in light and dark`, async () => {
      let attempt = 0;
      const tab = await open(width, {
        accounts: (route) => {
          attempt += 1;
          return attempt === 1 ? route.fulfill({ status: 503, body: "" }) : route.fulfill({ json: accounts });
        },
      });
      try {
        await tab.getByRole("alert").waitFor();
        await shot(tab, `${width}-error`);
        for (const dark of [false, true]) {
          await tab.evaluate((enabled) => document.documentElement.classList.toggle("dark", enabled), dark);
          await settled(tab);
          expect((await snapshot(tab)).overflow).toBeLessThanOrEqual(0);
        }
        await tab.evaluate(() => document.documentElement.classList.remove("dark"));
        await tab.getByRole("button", { name: "Erneut versuchen" }).click();
        await tab.getByText("Code von Einkauf").waitFor();
        expect(attempt).toBe(2);
      } finally {
        await tab.close();
      }
    }, 30_000);
  }

  for (const width of [390, 1440]) {
    test(`${width}px compact: the settings-panel editor holds Code rows within its width`, async () => {
      const tab = await open(width, { accounts: (route) => route.fulfill({ json: accounts }) }, "?compact=1");
      try {
        await tab.getByText("Code von Einkauf").waitFor();
        const layout = await snapshot(tab);
        expect(layout.overflow).toBeLessThanOrEqual(0);
        expect(new Set(layout.rows.map((row) => row?.height)).size).toBe(1);
        await shot(tab, `${width}-compact`);
      } finally {
        await tab.close();
      }
    }, 30_000);
  }

  test("1440px: without Code the dialog has no section, and read-only viewers see Code without removal", async () => {
    const none = await open(1440, { accounts: (route) => route.fulfill({ json: accounts }) }, "?code=none");
    try {
      expect(await none.locator("section").count()).toBe(0);
      await shot(none, "1440-empty");
    } finally {
      await none.close();
    }
    const readOnly = await open(1440, { accounts: (route) => route.fulfill({ json: accounts }) }, "?readonly=1");
    try {
      await readOnly.getByText("Code von info@").waitFor();
      expect(await readOnly.locator("section button").count()).toBe(0);
      await shot(readOnly, "1440-readonly");
      await readOnly.evaluate(() => document.documentElement.classList.add("dark"));
      await shot(readOnly, "1440-readonly-dark");
    } finally {
      await readOnly.close();
    }
  }, 30_000);
});
