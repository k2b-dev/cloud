import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider, SettingsPage } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../../ui/test/browser";
import type { SignInLocationPhase } from "./SignInLocations";
import { bundledStatus, emptyStatus, staleStatus, uploadedStatus } from "./sign-in-locations-fixture";

// Every transient state of the block replaces text in fixed places: rows and actions never move.
const root = mkdtempSync(join(tmpdir(), "core-sign-in-locations-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SignInLocations } = await import("./SignInLocations.tsx");
const { buildFontAssets } = await import("../../../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

let browser: Browser;
let css: string;
beforeAll(async () => {
  const styles = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
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

const file = new File([new Uint8Array(1)], "dbip-city-lite-2026-11.mmdb.gz");
const phases: [GeoIpAdminStatus | null, SignInLocationPhase][] = [
  [bundledStatus, { kind: "idle" }],
  [bundledStatus, { kind: "uploading", percent: 32 }],
  [bundledStatus, { kind: "checking" }],
  [bundledStatus, { kind: "upload-error", code: "geoip_invalid", file }],
  [bundledStatus, { kind: "upload-error", code: "geoip_request_too_large", file }],
  [bundledStatus, { kind: "upload-error", code: "geoip_upload_busy", file }],
  [uploadedStatus, { kind: "uploaded", type: "city" }],
  [uploadedStatus, { kind: "resetting", type: "city" }],
  [uploadedStatus, { kind: "reset-error", type: "city" }],
  [bundledStatus, { kind: "reset", type: "city", bundled: true }],
  [bundledStatus, { kind: "reconciling" }],
  [bundledStatus, { kind: "unknown-outcome" }],
  [staleStatus, { kind: "idle" }],
  [emptyStatus, { kind: "idle" }],
  [null, { kind: "load-error" }],
  [null, { kind: "loading" }],
];

const statusName = (status: GeoIpAdminStatus | null) =>
  status === bundledStatus
    ? "bundled"
    : status === uploadedStatus
      ? "uploaded"
      : status === staleStatus
        ? "stale"
        : status
          ? "empty"
          : "unknown";

const open = async (width: number, dark: boolean, locale: string, status: GeoIpAdminStatus | null, phase: SignInLocationPhase) => {
  const body = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SettingsPage, {
          title: "Sign-in",
          icon: "ti ti-users",
          get children() {
            return createComponent(SignInLocations, { initial: status, initialPhase: phase });
          },
        });
      },
    }),
  );
  const phone = width < 600;
  const tab = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
  });
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.setContent(
    `<!doctype html><html lang="${locale}" class="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" data-app-id="core">` +
      `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div class="app-rows"><div>${body}</div></div></main></div></body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

describe("sign-in locations block in a browser", () => {
  test("rows, actions and the status line keep their boxes in every state at 1440, 1194 and 390", async () => {
    for (const width of [1440, 1194, 390])
      for (const locale of ["en", "de"]) {
        const layouts = [];
        for (const [status, phase] of phases) {
          const tab = await open(width, false, locale, status, phase);
          try {
            layouts.push({
              phase: phase.kind,
              status: statusName(status),
              ...(await tab.evaluate(() => {
                const box = (element: Element | null) => {
                  const rect = element?.getBoundingClientRect();
                  return rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
                };
                const status = document.querySelector("[data-geoip-status]");
                return {
                  overflow: document.documentElement.scrollWidth - window.innerWidth,
                  upload: box(document.querySelector("[data-geoip-upload]")),
                  rows: Array.from(document.querySelectorAll("[data-geoip-kind]")).map(box),
                  resets: Array.from(document.querySelectorAll("[data-geoip-kind] button")).map(box),
                  line: box(status),
                  // The status text never hides part of a sentence behind its line clamp.
                  clipped: Array.from(status?.querySelectorAll<HTMLElement>("[class*=line-clamp]") ?? []).some(
                    (line) => line.scrollHeight > line.clientHeight + 1,
                  ),
                };
              })),
            });
          } finally {
            await tab.close();
          }
        }
        for (const layout of layouts)
          expect({ width, locale, phase: layout.phase, overflow: Math.max(0, layout.overflow), clipped: layout.clipped }).toEqual({
            width,
            locale,
            phase: layout.phase,
            overflow: 0,
            clipped: false,
          });
        // Rows keep one line per fact, so every phase and every status keeps every box: nothing moves on success either.
        const start = layouts[0]!;
        for (const layout of layouts)
          expect({
            width,
            locale,
            phase: layout.phase,
            status: layout.status,
            rows: layout.rows,
            resets: layout.resets,
            line: layout.line,
            upload: layout.upload,
          }).toEqual({
            width,
            locale,
            phase: layout.phase,
            status: layout.status,
            rows: start.rows,
            resets: start.resets,
            line: start.line,
            upload: start.upload,
          });
      }
  }, 120_000);
});
