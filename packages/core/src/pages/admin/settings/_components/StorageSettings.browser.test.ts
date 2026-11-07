import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { storageEntries } from "./storage-settings.test-fixture";

const root = mkdtempSync(join(tmpdir(), "core-storage-settings-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CoreSettingsForm } = await import("./CoreSettingsForm.island.tsx");
const { buildFontAssets } = await import("../../../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

let browser: Browser;
let css: string;
beforeAll(async () => {
  const styles = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const built = await Promise.all(styles.map((path) => Bun.build({ entrypoints: [path], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1280, height: 900, touch: false };

const open = async (view: View, dark: boolean, locale: string) => {
  const body = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(CoreSettingsForm, {
          title: "Storage",
          subtitle: "Garage connection and object size limit for applications.",
          icon: "ti ti-database",
          entries: storageEntries,
          showTestStorageAction: true,
        });
      },
    }),
  );
  const tab = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.setContent(
    `<!doctype html><html lang="${locale}" class="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" data-app-id="core">` +
      `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div class="app-rows">${body}</div></main></div></body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

describe("storage settings layout", () => {
  for (const view of [phone, { width: 768, height: 1024, touch: true }, desktop]) {
    for (const dark of [false, true]) {
      test(`connection, secrets, limits and action fit ${view.width}px in ${dark ? "dark" : "light"}`, async () => {
        const tab = await open(view, dark, "en");
        try {
          expect(await tab.locator("body").innerText()).toContain("Test connection");
          expect(await tab.locator('input[type="password"]').count()).toBe(2);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await tab.screenshot({ path: `/tmp/cloud-storage-${view.width}-${dark ? "dark" : "light"}.png`, fullPage: true });
        } finally {
          await tab.close();
        }
      });
    }
  }
});
