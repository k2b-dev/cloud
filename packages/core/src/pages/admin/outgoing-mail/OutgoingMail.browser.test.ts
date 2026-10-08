import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdminMailApp, AdminMailProfile } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../ui/test/browser";
import type { OutgoingMailState } from "./OutgoingMail.island";

// The outgoing mail page must stay flat and fit a phone: its tables scroll inside themselves, never the page.
const root = mkdtempSync(join(tmpdir(), "core-outgoing-mail-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: OutgoingMail, AccessDialog } = await import("./OutgoingMail.island.tsx");
const { MessageDialog } = await import("./SendLog.tsx");
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
  log: {
    filter: {},
    retention: { contentDays: 90, recordDays: 365 },
    page: {
      items: [
        {
          id: "0b1f4d43-34c9-4f0e-9a39-6c4c7b2c5f10",
          appId: "invoices",
          profile: "billing",
          to: ["a-very-long-recipient-address-for-layout@customer-domain.example.org", "grace@example.org"],
          subject: "Invoice 2026-104 for the order placed on 6 October with a long subject line",
          attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 48213, sha256: "ab".repeat(32) }],
          status: "sent",
          failures: [{ recipient: "grace@example.org", reason: "550 5.1.1 Mailbox unavailable", at: "2026-10-07T10:00:01.000Z" }],
          attempts: 1,
          ref: { scope: "invoice", id: "2026-104" },
          response: "250 2.0.0 OK queued as 4F2A1",
          createdAt: "2026-10-07T10:00:00.000Z",
          sentAt: "2026-10-07T10:00:01.000Z",
        },
        {
          id: "7d0c1c55-3f43-4f6b-a2a3-1d1f3f0c9e21",
          appId: "files",
          profile: "noreply",
          to: ["ada@example.org"],
          subject: "Shared folder",
          attachments: [],
          status: "queued",
          error: "451 4.7.1 Try again later",
          failures: [],
          attempts: 2,
          createdAt: "2026-10-07T09:58:00.000Z",
        },
      ],
      page: 1,
      perPage: 25,
      total: 2,
      hasNext: true,
      nextCursor: "next",
    },
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

const open = async (
  view: View,
  dark: boolean,
  locale: string,
  content: () => JSX.Element = () => createComponent(OutgoingMail, { initial: state }),
  frame = "",
) => {
  const body = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return content();
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
      `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div class="app-rows"><div style="${frame}">${body}</div></div></main></div></body></html>`,
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
              tables: 3,
            });
            expect(layout.headings).toHaveLength(4);
          } finally {
            await tab.close();
          }
        }
  }, 60_000);

  // The dialog is centered, so any height change moves every control in it.
  test("the access dialog keeps one height through every mode and selection", async () => {
    const app = (mode: AdminMailApp["mode"], profiles: string[]): AdminMailApp => ({
      appId: "invoices",
      name: "Invoices",
      registered: true,
      declared: true,
      mode,
      profiles,
    });
    const modes = [
      { mode: "default", app: app("default", []) },
      { mode: "selected", app: app("selected", ["billing"]) },
      { mode: "none", app: app("selected", []) },
    ];
    const dialog = (value: AdminMailApp) => () =>
      createComponent(AccessDialog, { app: value, profiles: state.profiles, close: () => {}, onSaved: () => {} });
    // Same width as a prompt dialog: 28rem, or the phone width minus its margins.
    const frame = "width: min(calc(100vw - 2rem), 28rem); padding: 1rem";
    for (const view of [phone, desktop])
      for (const locale of ["en", "de"]) {
        const layouts = [];
        for (const entry of modes) {
          const tab = await open(view, false, locale, dialog(entry.app), frame);
          try {
            const layout = await tab.evaluate(() => {
              const form = document.querySelector("form")!;
              const top = form.getBoundingClientRect().top;
              return {
                children: Array.from(form.children).map((child) => {
                  const box = child.getBoundingClientRect();
                  return [Math.round(box.top - top), Math.round(box.height)];
                }),
                visibleHints: Array.from(document.querySelectorAll<HTMLElement>("[data-access-hint]"))
                  .filter((hint) => getComputedStyle(hint).visibility === "visible")
                  .map((hint) => hint.dataset.accessHint),
                checked: Array.from(form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).map((box) => box.checked),
              };
            });
            expect(layout.visibleHints).toEqual([entry.mode]);
            layouts.push({ width: view.width, locale, children: layout.children, checked: layout.checked });
          } finally {
            await tab.close();
          }
        }
        // Default shows the default profile as used; selected shows the grant; none shows nothing.
        expect(layouts.map((layout) => layout.checked)).toEqual([
          [true, false],
          [false, true],
          [false, false],
        ]);
        for (const layout of layouts.slice(1)) expect(layout.children).toEqual(layouts[0]!.children);
      }
  }, 60_000);

  test("a send log entry fits a phone and a desktop without horizontal overflow", async () => {
    const entry = state.log.page.items[0]!;
    // A queued batch member carries the most footer actions.
    const queued = { ...entry, status: "queued" as const, batchId: "6f1c7a52-8f35-4d6f-9a3e-1b2c3d4e5f60" };
    for (const record of [entry, queued])
      for (const view of [phone, desktop])
        for (const dark of [false, true]) {
          const dialog = () => createComponent(MessageDialog, { record, appName: "Invoices", close: () => {}, onChanged: () => {} });
          const tab = await open(view, dark, "de", dialog, "width: min(calc(100vw - 2rem), 40rem)");
          try {
            const layout = await tab.evaluate(() => ({
              overflow: document.documentElement.scrollWidth - window.innerWidth,
              text: document.body.textContent ?? "",
            }));
            expect({ width: view.width, dark, overflow: Math.max(0, layout.overflow) }).toEqual({ width: view.width, dark, overflow: 0 });
            expect(layout.text).toContain("Inhalt anzeigen");
            expect(layout.text).toContain("550 5.1.1 Mailbox unavailable");
          } finally {
            await tab.close();
          }
        }
  }, 60_000);
});
