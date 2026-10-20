import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { launchBrowser, storedCookie } from "../../../ui/test/browser";

const root = mkdtempSync(join(tmpdir(), "cloud-theme-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { ssr } = defineApp({
  id: "theme-probe",
  name: "Theme probe",
  icon: "ti ti-sun-moon",
  description: "Theme bootstrap probe",
  baseUrl: "http://theme-probe:3000",
  routes: [],
  pwa: {},
});
const app = new Hono().get(
  "/pwa/theme-probe",
  ...ssr((c) => {
    if (c.req.query("fixed")) c.get("page").theme = "light";
    return () => "Theme probe";
  }),
);
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: app.fetch });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const open = async (scheme: "light" | "dark", preference?: "light" | "dark" | "system", fixed = false) => {
  const context = await browser.newContext({ colorScheme: scheme });
  if (preference) await context.addCookies([{ name: "theme", value: preference, url: server.url.href }]);
  await context.addInitScript(() => {
    requestAnimationFrame(() => {
      document.documentElement.dataset.firstTheme = document.documentElement.className;
    });
    window.addEventListener("cloud:theme-preference", () => {
      document.documentElement.dataset.themeEvents = String(Number(document.documentElement.dataset.themeEvents ?? 0) + 1);
    });
  });
  const page = await context.newPage();
  // Only the document is needed: the inline head script owns first paint and media changes.
  await page.route("**/public/**", (route) => route.fulfill({ status: 204 }));
  await page.route("**/_ssr/**", (route) => route.fulfill({ status: 204 }));
  await page.goto(`${server.url}pwa/theme-probe${fixed ? "?fixed=1" : ""}`);
  await page.waitForFunction(() => document.documentElement.dataset.firstTheme !== undefined);
  return { context, page };
};

describe("theme before first paint", () => {
  for (const scheme of ["light", "dark"] as const)
    for (const preference of [undefined, "system", "light", "dark"] as const)
      test(`${preference ?? "no cookie"} with a ${scheme} device`, async () => {
        const { context, page } = await open(scheme, preference);
        try {
          const expected = preference === "light" || preference === "dark" ? preference : scheme;
          expect(await page.locator("html").getAttribute("data-first-theme")).toBe(expected);
          expect(await page.locator("html").getAttribute("class")).toBe(expected);
          const cookie = await storedCookie(page, "color-scheme");
          expect(cookie?.value).toBe(scheme);
          expect(cookie?.path).toBe("/");
          expect(cookie?.sameSite).toBe("Lax");
          expect(cookie?.secure).toBe(false);
        } finally {
          await context.close();
        }
      });
});

describe("live system appearance changes", () => {
  for (const preference of [undefined, "system", "light", "dark"] as const)
    test(`${preference ?? "no cookie"} keeps its preference and reports the scheme`, async () => {
      const { context, page } = await open("light", preference);
      try {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForFunction(() => document.documentElement.dataset.themeEvents === "1");
        expect(await page.locator("html").getAttribute("class")).toBe(preference === "light" ? "light" : "dark");
        expect((await storedCookie(page, "color-scheme"))?.value).toBe("dark");
        await page.emulateMedia({ colorScheme: "light" });
        await page.waitForFunction(() => document.documentElement.dataset.themeEvents === "2");
        expect(await page.locator("html").getAttribute("class")).toBe(preference === "dark" ? "dark" : "light");
        expect((await storedCookie(page, "theme"))?.value).toBe(preference);
      } finally {
        await context.close();
      }
    });

  test("a fixed display ignores the preference and device changes entirely", async () => {
    const { context, page } = await open("dark", "dark", true);
    try {
      expect(await page.locator("html").getAttribute("data-first-theme")).toBe("light");
      await page.emulateMedia({ colorScheme: "light" });
      await page.emulateMedia({ colorScheme: "dark" });
      // Allow the media events a rendering opportunity before checking their absence.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.locator("html").getAttribute("class")).toBe("light");
      expect(await page.locator("html").getAttribute("data-theme-events")).toBeNull();
      expect(await storedCookie(page, "color-scheme")).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
