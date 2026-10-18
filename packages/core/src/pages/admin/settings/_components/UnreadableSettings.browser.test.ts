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
import type { SettingFieldDef } from "./CoreSettingsForm.island";

// #1303: the unreadable notice and badge come from the server render, fit a phone, and read in light and dark.
const root = mkdtempSync(join(tmpdir(), "core-unreadable-settings-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: CoreSettingsForm } = await import("./CoreSettingsForm.island.tsx");
const { buildFontAssets } = await import("../../../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

const entry = (key: string, label: string, value: string, unreadable: boolean): SettingFieldDef => ({
  key,
  label,
  description: "Shown in the header, emails and the browser title.",
  kind: "string",
  value,
  default: "Cloud",
  resetValue: "Cloud",
  valueSource: unreadable ? "default" : "custom",
  resetValueSource: "default",
  isCustom: true,
  unreadable,
  group: "app",
});
const entries = [
  entry("app.name", "Cloud name", "Cloud", true),
  entry("app.contact_email", "Contact address for administrators and support requests", "team@example.org", true),
  entry("app.url", "Public address", "https://cloud.example.org", false),
];

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
        return createComponent(CoreSettingsForm, { title: "General", subtitle: "", icon: "ti ti-settings", entries });
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

describe("unreadable settings in a browser", () => {
  test("the notice lists each unreadable setting with its reset inside the card on a phone and a desktop", async () => {
    for (const view of [phone, desktop])
      for (const dark of [false, true])
        for (const locale of ["en", "de"]) {
          const tab = await open(view, dark, locale);
          try {
            const layout = await tab.evaluate(() => {
              const notice = document.querySelector<HTMLElement>('.k2b-notice-card[data-tone="warning"]')!;
              const card = notice.getBoundingClientRect();
              const rows = Array.from(notice.querySelectorAll<HTMLElement>("li[data-setting]"));
              return {
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                settings: rows.map((row) => row.dataset.setting),
                resetsInside: rows.map((row) => {
                  const box = row.querySelector("button")!.getBoundingClientRect();
                  return box.width > 0 && box.left >= card.left && box.right <= card.right;
                }),
                // The badge is one short line, like the source chip it replaces.
                badges: Array.from(document.querySelectorAll<HTMLElement>(".k2b-status-badge")).map(
                  (badge) => badge.getBoundingClientRect().height < 28,
                ),
              };
            });
            expect({ width: view.width, dark, locale, ...layout, overflow: Math.max(0, layout.overflow) }).toEqual({
              width: view.width,
              dark,
              locale,
              overflow: 0,
              settings: ["app.name", "app.contact_email"],
              resetsInside: [true, true],
              badges: [true, true],
            });
            if (process.env.SHOTS)
              await tab.screenshot({
                path: `${process.env.SHOTS}/core-${view.width}-${dark ? "dark" : "light"}-${locale}.png`,
                fullPage: true,
              });
          } finally {
            await tab.close();
          }
        }
  }, 90_000);
});
