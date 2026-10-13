import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import type { PageOptions } from "../../src/_internal/define-app";
import type { RailSnapshot } from "../../src/contracts/rail-preferences";
import type { User } from "../../src/contracts/shared";
import type { LayoutAnnouncementsState } from "../../src/server/middleware/settings";
import type { RuntimeContext } from "../../src/ssr/runtime";

const appRoot = import.meta.dir;
const outdir = mkdtempSync(join(tmpdir(), "cloud-island-props-csp-"));
const { plugin } = createConfig({ rootDir: appRoot, componentRoots: [] });
Bun.plugin(plugin());
const { defineApp } = await import("../../src/_internal/define-app");
const rail = await import("../../src/services/rail-snapshot");
const settings = await import("../../src/server/middleware/settings");
const help = await import("../../src/ssr/help");
const { defaultRailPreferences } = await import("../../src/contracts/rail-preferences");
const { default: CspPage } = await import("./src/CspPage");
const app = defineApp({
  id: "csp-props",
  name: "CSP props",
  icon: "ti ti-bug",
  description: "JSON props CSP probe",
  baseUrl: "http://csp-props:3000",
  routes: ["/"],
  appRoot,
});
const ui = resolve(appRoot, "../../../ui/dist");
const policy =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'";
type Environment = {
  Variables: {
    runtime: RuntimeContext;
    user: User | undefined;
    page: PageOptions;
    railPreferences: RailSnapshot;
    announcements: LayoutAnnouncementsState;
    settings: { app: { name: string } };
  };
};
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  spies.push(
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    spyOn(help, "getLayoutHelp").mockReturnValue(null),
  );
  const islands = await Bun.build({ entrypoints: [join(appRoot, "src/props.ts")], plugins: [app.plugin()], outdir });
  if (!islands.success) throw new AggregateError(islands.logs, "Could not build the islands.");
  const css = await Bun.build({ entrypoints: [resolve(appRoot, "../../src/styles/global.css")], plugins: [tailwind] });
  if (!css.success) throw new AggregateError(css.logs, "Could not compile the global stylesheet.");
  const globalCss = await css.outputs[0]!.text();
  const routesApp = new Hono<Environment>()
    .use("*", async (c, next) => {
      c.header("Content-Security-Policy", policy);
      await next();
    })
    .get("/_ssr/*", (c) => new Response(Bun.file(join(outdir, "_ssr", basename(c.req.path)))))
    .get("/public/global.css", (c) => c.body(globalCss, 200, { "content-type": "text/css" }))
    .get("/public/tabler-icons.css", () => new Response(Bun.file(join(ui, "tabler.css"))))
    .get("/public/:file{tabler-icons-.+\\.woff2}", (c) => new Response(Bun.file(join(ui, c.req.param("file")))))
    .use("*", async (c, next) => {
      c.set("runtime", {
        apps: [
          {
            id: "csp-props",
            name: "CSP props",
            icon: "ti ti-bug",
            description: "Props probe",
            routes: ["/"],
            nav: { href: "/", section: "primary", requiresAuth: false },
          },
        ],
      });
      c.set("settings", { app: { name: "Cloud" } });
      c.set("announcements", {
        banners: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            version: 4,
            kind: "banner",
            tone: "info",
            title: "CSP banner",
            bodyHtml: "<p>Shell mount probe</p>",
            publishedAt: "2026-10-01T10:00:00Z",
            expiresAt: null,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
            createdBy: null,
            updatedBy: null,
          },
        ],
        announcements: [],
        latestAnnouncementVersion: 0,
        cookieState: { seenAnnouncementVersion: 0, dismissedBannerVersions: [] },
      });
      await next();
    })
    .get("/", ...app.ssr<Environment>((c) => () => createComponent(CspPage, { c })));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routesApp.fetch });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  for (const spy of spies) spy.mockRestore();
  rmSync(outdir, { recursive: true, force: true });
});

test(`rich props and the Cloud shell mount under CSP in ${browserName}`, async () => {
  const context = await browser.newContext({ timezoneId: "UTC" });
  await context.addInitScript(() => {
    const violations: { violatedDirective: string; blockedURI: string; sourceFile: string; lineNumber: number; sample: string }[] = [];
    Reflect.set(globalThis, "cspViolations", violations);
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push({
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        sample: event.sample,
      }),
    );
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const response = await page.goto(server.url.href);
    expect(response?.headers()["content-security-policy"]).toBe(policy);
    await page.locator("[data-rich-props][data-mounted]").waitFor();
    const text = (name: string) => page.locator(`[data-rich-props] [data-${name}]`).textContent();
    expect(await text("date")).toBe(String(new Date("2026-10-01T12:34:56Z").getTime()));
    expect(await text("map")).toBe(JSON.stringify([["k", { label: "shared" }]]));
    expect(await text("set")).toBe('["a","b"]');
    expect(await text("shared")).toBe("true");
    expect(await text("undefined")).toBe("true");
    expect(await text("text")).toBe('</script>"&');
    // Dismissing the SSR banner proves ShellRuntime installed its browser handler.
    await page.locator('[data-cloud-announcement-dismiss="4"]').click();
    await page.locator(".cloud-announcement").waitFor({ state: "detached" });
    expect(await page.locator("[data-ssr-error]").count()).toBe(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(globalThis, "cspViolations"))).toEqual([]);
    // Run last: this deliberately rejected eval may itself emit a CSP violation.
    expect(
      await page.evaluate(() => {
        try {
          (0, eval)("1");
          return "allowed";
        } catch (error) {
          return error instanceof Error ? error.name : String(error);
        }
      }),
    ).toBe("EvalError");
  } catch (error) {
    console.error({ pageErrors: errors, cspViolations: await page.evaluate(() => Reflect.get(globalThis, "cspViolations")) });
    throw error;
  } finally {
    await context.close();
  }
}, 60_000);
