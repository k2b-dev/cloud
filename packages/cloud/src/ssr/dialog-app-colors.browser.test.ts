import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser } from "../../../ui/test/browser";
import { appAccentStyle } from "./app-appearance";
import { appColors } from "./app-color";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(resolve(tmpdir(), "cloud-dialog-app-colors-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { default: Layout } = await import("./Layout");
const app = defineApp({
  id: "dialog-app-colors-probe",
  name: "Dialog app colors",
  icon: "ti ti-palette",
  description: "Portalled app color regression",
  baseUrl: "http://dialog-app-colors-probe:3000",
  routes: ["/dialog-app-colors"],
  appearance: { accent: "#0f766e" },
});
const server = new Hono<{ Variables: { runtime: RuntimeContext } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [app.meta] });
    await next();
  })
  .get("/dialog-app-colors", ...app.ssr((c) => () => createComponent(Layout, { c, title: "App colors", children: "App content" })));

let browser: Browser;
let harness: string;
let html: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "dialog-app-colors.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "dialog-app-colors-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build the dialog app colors harness");
  harness = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet");
  const css = await styles.outputs[0]!.text();
  const response = await server.request("/dialog-app-colors", { headers: { "Accept-Language": "en" } });
  expect(response.status).toBe(200);
  // Keep the real shell and body intact. Replace its external stylesheets and remove island/module scripts.
  html = (await response.text())
    .replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, "")
    .replace(/<script\b[^>]*\btype="module"[^>]*>[\s\S]*?<\/script>/g, "")
    .replace("</head>", () => `<style>${css}</style></head>`);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
const defaults = {
  light: { ink: "#2469d4", selected: "#f0f6ff", selectedNav: "#eaf2ff" },
  dark: { ink: "#589aff", selected: "#15243b", selectedNav: "#152742" },
};
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const tabBoxes = (page: Page) =>
  page.getByRole("tab").evaluateAll((tabs) =>
    tabs.map((tab) => {
      const { x, y, width, height } = tab.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
const selectedColors = (page: Page) =>
  page.evaluate(() => {
    const tab = getComputedStyle(document.querySelector('dialog [role="tab"][aria-selected="true"]')!);
    const row = getComputedStyle(document.querySelector('dialog tr[data-selected="true"]')!);
    return { ink: tab.color, selected: row.backgroundColor, selectedNav: tab.backgroundColor };
  });
const assertAppColors = async (page: Page, theme: "light" | "dark") => {
  const colors = await selectedColors(page);
  const expected = appColors("#0f766e")[theme];
  for (const key of ["ink", "selected", "selectedNav"] as const) {
    expect(colors[key], `${theme} ${key}`).toBe(rgb(expected[key]));
    expect(colors[key], `${theme} ${key} differs from platform default`).not.toBe(rgb(defaults[theme][key]));
  }
};

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`portalled settings and rows inherit app colors and preserve local scopes at ${viewport.width}px`, async () => {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", colorScheme: "light" });
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) =>
        route.request().url() === "http://localhost/dialog-app-colors"
          ? route.fulfill({ contentType: "text/html", body: html })
          : route.abort(),
      );
      await page.goto("http://localhost/dialog-app-colors");
      await page.addScriptTag({ content: harness });
      await page.getByRole("button", { name: "Open app settings", exact: true }).click();
      await page.locator("dialog[open] .k2b-settings").waitFor({ state: "visible" });
      const portal = await page.locator("dialog[open]").evaluate((dialog) => {
        const root = dialog.closest("[data-k2b-ui-portal]");
        return { canvas: dialog.closest(".cloud-app-canvas") !== null, underBody: root !== null && document.body.contains(root) };
      });
      expect(portal).toEqual({ canvas: false, underBody: true });

      await page.evaluate((style) => {
        const scope = document.createElement("span");
        scope.id = "local-accent";
        scope.className = "app-accent-scope";
        scope.style.cssText = `${style};background-color:var(--ui-app-selected-nav);color:var(--ui-app-accent-text)`;
        document.body.append(scope);
      }, appAccentStyle("#eab308")!);

      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((theme) => {
          document.documentElement.className = theme;
        }, theme);
        await settle(page);
        await assertAppColors(page, theme);
        const before = await tabBoxes(page);
        expect(before).toHaveLength(2);
        const next = page.getByRole("tab", { name: theme === "light" ? "Files" : "General", exact: true });
        await next.click();
        await settle(page);
        expect(await next.getAttribute("aria-selected")).toBe("true");
        expect(await tabBoxes(page)).toEqual(before);
        await assertAppColors(page, theme);

        const local = await page.locator("#local-accent").evaluate((element) => {
          const style = getComputedStyle(element);
          return { ink: style.color, selectedNav: style.backgroundColor };
        });
        const yellow = appColors("#eab308")[theme];
        const teal = appColors("#0f766e")[theme];
        for (const key of ["ink", "selectedNav"] as const) {
          expect(local[key]).toBe(rgb(yellow[key]));
          expect(local[key]).not.toBe(rgb(teal[key]));
        }
      }
    } finally {
      await context.close();
    }
  }, 20_000);
}
