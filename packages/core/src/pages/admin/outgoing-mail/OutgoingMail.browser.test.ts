import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../ui/test/browser";
import type { OutgoingMailState } from "./OutgoingMail.island";

// The outgoing mail page must stay flat and fit a phone: its tables scroll inside themselves, never the page.
const root = mkdtempSync(join(tmpdir(), "core-outgoing-mail-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: OutgoingMail } = await import("./OutgoingMail.island.tsx");
const { buildFontAssets } = await import("../../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

const profile = (overrides: Partial<AdminMailProfile>): AdminMailProfile => ({
  key: "noreply",
  name: "No-reply",
  fromAddress: "noreply@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "noreply@example.org",
  hasPassword: true,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15 * 1024 * 1024,
  isDefault: true,
  revision: 1,
  createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  updatedBy: null,
  appCount: 3,
  ...overrides,
});
const state: OutgoingMailState = {
  profiles: [
    profile({}),
    profile({
      key: "billing",
      name: "Billing",
      fromAddress: "billing@example.org",
      fromName: "Example Billing",
      smtpHost: "mail.provider.example",
      smtpPort: 465,
      smtpSecure: true,
      isDefault: false,
      dailyRecipientLimit: 500,
    }),
  ],
  apps: {
    defaultProfile: "noreply",
    items: [
      { appId: "core", name: "Core", registered: true, declared: true, mode: "default", profiles: [] },
      { appId: "invoices", name: "Invoices", registered: true, declared: true, mode: "selected", profiles: ["billing", "noreply"] },
      { appId: "files", name: "Files", registered: true, declared: false, mode: "default", profiles: [] },
    ],
  },
};

let browser: Browser;
let css: string;
beforeAll(async () => {
  const styles = [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
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
        return createComponent(OutgoingMail, { initial: state });
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
      `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-screen w-full" data-app-id="core">` +
      `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div class="app-rows">${body}</div></main></div></body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

describe("outgoing mail page in a browser", () => {
  test("fits a phone and a desktop in light and dark without page overflow", async () => {
    for (const view of [phone, desktop])
      for (const dark of [false, true])
        for (const locale of ["en", "de"]) {
          const tab = await open(view, dark, locale);
          try {
            const layout = await tab.evaluate(() => ({
              overflow: document.documentElement.scrollWidth - window.innerWidth,
              tables: document.querySelectorAll("table").length,
              headings: Array.from(document.querySelectorAll("h1, h2")).map((heading) => heading.textContent),
            }));
            expect({ width: view.width, dark, locale, overflow: Math.max(0, layout.overflow), tables: layout.tables }).toEqual({
              width: view.width,
              dark,
              locale,
              overflow: 0,
              tables: 2,
            });
            expect(layout.headings).toHaveLength(3);
          } finally {
            await tab.close();
          }
        }
  }, 60_000);
});
