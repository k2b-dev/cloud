import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { User } from "../contracts/shared";
import type { RuntimeContext } from "./runtime";

// An admin page on v2 as the server sends it (the real `AdminLayout ui="v2"` with one `AdminWorkspace`): on a desk the
// admin bar stands as the v2 sidebar beside the page, with the open page and the open area's section marked; on the
// phone the sidebar leaves (the shell's menu takes it), and both widths keep the v2 layout rules.
registerSsrTestPlugin({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const { default: AdminLayout } = await import("./AdminLayout");
const { default: AdminWorkspace } = await import("./AdminWorkspace");
const { adminNavigation } = await import("./admin-navigation-v2");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { Band, Bar, Pane, Text } = await import("@k2b/ui/v2");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];

const app = defineApp({
  id: "example",
  name: "Beispiel",
  icon: "ti ti-box",
  description: "Admin fixture",
  baseUrl: "http://example:3000",
  routes: ["/app/example"],
});
const admin = { ...person, roles: ["admin"] } as User;
type Env = { Variables: { runtime: RuntimeContext; user: User | undefined } };
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [{ ...app.meta, adminHref: "/admin/example", nav: { href: "/app/example", section: "primary" } }] });
    c.set("user", admin);
    await next();
  })
  .get(
    "/admin/storage",
    ...app.ssr<Env>(
      (c) => () =>
        createComponent(AdminLayout, {
          c,
          ui: "v2",
          title: "Speicher",
          get children() {
            return createComponent(AdminWorkspace, {
              nav: adminNavigation(c, [
                { label: "Standard", icon: "database", href: "/admin/storage" },
                { label: "Archiv", icon: "archive", href: "/admin/storage?bucket=archive", current: true },
              ]),
              get head() {
                return createComponent(Bar, { start: createComponent(Text, { type: "body", children: "Archiv" }) });
              },
              get children() {
                return createComponent(Pane, {
                  label: "Archiv",
                  get children() {
                    return createComponent(Band, {
                      get children() {
                        return createComponent(Text, { children: "Dateien im Archiv" });
                      },
                    });
                  },
                });
              },
            });
          },
        }),
    ),
  );

let browser: Browser;
let css: string;
let v2css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  v2css = await Bun.file(resolve(import.meta.dir, "../../../ui/src/v2/v2.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const open = async (width: number): Promise<Page> => {
  const response = await server.request("/admin/storage?bucket=archive", { headers: { "accept-language": "de" } });
  expect(response.status).toBe(200);
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(await response.text());
  await page.addStyleTag({ content: css });
  await page.addStyleTag({ content: v2css });
  await settled(page);
  return page;
};

const sidebar = (page: Page) =>
  page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-k2-part="Nav"]');
    const box = nav?.getBoundingClientRect();
    const visible = !!nav && !!box && box.width > 0 && box.height > 0 && getComputedStyle(nav).visibility !== "hidden";
    const current = [...document.querySelectorAll('[data-k2-part="Nav.Item"][aria-current="page"]')].map((item) =>
      item.textContent?.trim(),
    );
    const pane = document.querySelector('[data-k2-part="Pane"]')?.getBoundingClientRect();
    return { visible, width: box?.width ?? 0, right: box?.right ?? 0, paneLeft: pane?.left ?? 0, current };
  });

test("on a desk the admin bar is the v2 sidebar beside the page, the open section current", async () => {
  const page = await open(1440);
  try {
    const bar = await sidebar(page);
    expect(bar.visible).toBe(true);
    expect(bar.width).toBeGreaterThanOrEqual(200);
    expect(bar.paneLeft).toBeGreaterThanOrEqual(bar.right - 1);
    expect(bar.current).toEqual(["Archiv"]);
    expect(await page.getByRole("link", { name: "Wartungsmodus" }).isVisible()).toBe(true);
    const layout = await measureV2Layout(page, { root: ".k2-ui" });
    expect(layout.problems).toEqual([]);
    expect(layout.measured.texts).toBeGreaterThan(5);
  } finally {
    await page.close();
  }
});

test("on the phone the sidebar leaves the page and the page keeps the layout rules", async () => {
  const page = await open(390);
  try {
    expect((await sidebar(page)).visible).toBe(false);
    expect((await measureV2Layout(page, { root: ".k2-ui" })).problems).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await page.close();
  }
});
