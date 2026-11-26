import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { User } from "../contracts/shared";
import type { RuntimeContext } from "./runtime";

// One phone head for every v2 page (design review 26.11.): an admin page on `AdminLayout ui="v2"` names itself and
// leads back to the admin overview, as an app's page does, instead of "Administration" with its menu; the overview keeps
// its title. The shell's search is the one search place, and no head row stands empty. The page is Layout's real
// server HTML with the global stylesheet, at 390 px.
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
const { Bar, Input, Pane, Tabs, Text } = await import("@k2b/ui/v2");
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
const admin: User = { ...person, roles: ["admin"] } as User;
type Env = { Variables: { runtime: RuntimeContext; user: User | undefined; adminCodeApprovals: number | undefined } };
/** An admin page as the Hosts page builds it: views and a search in its head. */
const page = (title: string, detail = false) =>
  app.ssr<Env>(
    (c) => () =>
      createComponent(AdminLayout, {
        c,
        ui: "v2",
        title,
        get children() {
          return createComponent(AdminWorkspace, {
            nav: adminNavigation(c, []),
            get head() {
              return createComponent(Bar, {
                get start() {
                  return createComponent(Tabs, {
                    label: "Ansichten",
                    items: [
                      { label: "Hostgruppen", href: "#groups", current: true },
                      { label: "Ohne Gruppe", href: "#ungrouped" },
                    ],
                  });
                },
                get end() {
                  return createComponent(Input, { type: "search", icon: "search", label: "Hosts durchsuchen" });
                },
              });
            },
            detail: detail || undefined,
            get children() {
              const list = createComponent(Pane, {
                label: title,
                get children() {
                  return createComponent(Text, { children: "Inhalt" });
                },
              });
              if (!detail) return list;
              // an open host: on the phone the detail is the page, and its own way back leads to the list
              return createComponent(Pane.Split, {
                get children() {
                  return [
                    list,
                    createComponent(Pane, {
                      detail: true,
                      label: "host-1",
                      back: { label: title, href: "/admin/hosts" },
                      get head() {
                        return createComponent(Bar, {
                          get start() {
                            return createComponent(Text, { type: "lead", children: "host-1.example" });
                          },
                        });
                      },
                      get children() {
                        return createComponent(Text, { children: "Zuletzt gesehen vor 2 Minuten" });
                      },
                    }),
                  ];
                },
              });
            },
          });
        },
      }),
  );
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [{ ...app.meta, adminHref: "/admin/example", nav: { href: "/app/example", section: "primary" } }] });
    c.set("user", admin);
    c.set("adminCodeApprovals", undefined);
    await next();
  })
  .get("/admin/hosts", ...page("Hosts"))
  .get("/admin/hosts/host-1", ...page("Hosts", true))
  .get("/admin", ...page("Overview"));

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const open = async (path: string): Promise<Page> => {
  const response = await server.request(path);
  expect(response.status).toBe(200);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(await response.text());
  await page.addStyleTag({ content: css });
  await settled(page);
  return page;
};

/** The phone's head: what the bar's row shows left to right, the searches a person sees, and head rows showing nothing. */
const head = (page: Page) =>
  page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 2 && box.height > 2 && getComputedStyle(element).visibility !== "hidden";
    };
    const bar = document.querySelector(".layout-header")!;
    const row = [...bar.querySelectorAll("a[href], button, .layout-header-title")]
      .filter(shown)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "");
    const searches = [...document.querySelectorAll('.k2-ui [data-slot="head"] .k2-input[data-search]')].filter(shown).length;
    const emptyRows = [...document.querySelectorAll('.k2-ui [data-slot="head"]')].filter(
      (slot) =>
        slot.getBoundingClientRect().height > 0 &&
        ![...slot.querySelectorAll("*")].some((part) => shown(part) && part.children.length === 0),
    ).length;
    return { row, searches, emptyRows };
  });

test("an admin page on the phone names itself and leads back to the admin overview; the shell's search is the one", async () => {
  const page = await open("/admin/hosts");
  try {
    expect(await head(page)).toEqual({
      row: ["Back to Admin", "Hosts", "Open global search", "Open help", "Open apps"],
      searches: 0,
      emptyRows: 0,
    });
    expect(await page.getByRole("link", { name: "Back to Admin" }).getAttribute("href")).toBe("/admin");
  } finally {
    await page.close();
  }
}, 30_000);

test("the admin overview keeps its title, with nothing above it", async () => {
  const page = await open("/admin");
  try {
    const { row, searches, emptyRows } = await head(page);
    // its title is the menu of the admin areas, as on every page with navigation of its own
    expect(row[0]).toBe("Admin, Menu");
    expect(row).not.toContain("Back to Admin");
    expect({ searches, emptyRows }).toEqual({ searches: 0, emptyRows: 0 });
  } finally {
    await page.close();
  }
}, 30_000);

test("an open detail on an admin page has one way back, its own, with its title right below it; the shell's way up gives way", async () => {
  const page = await open("/admin/hosts/host-1");
  try {
    const { row } = await head(page);
    expect(row).toEqual(["Open global search", "Open help", "Open apps"]);
    const backs = await page.evaluate(() =>
      [...document.querySelectorAll('[data-k2-part="Back"] a, .layout-header-up')]
        .filter((element) => element.getBoundingClientRect().width > 2)
        .map((element) => element.getAttribute("href")),
    );
    expect(backs).toEqual(["/admin/hosts"]);
    // the detail's title stands right below its way back, on the text edge, whole
    const { back, title } = await page.evaluate(() => {
      const box = (element: Element) => {
        const { left, top, bottom, width } = element.getBoundingClientRect();
        return { left: Math.round(left), top: Math.round(top), bottom: Math.round(bottom), width: Math.round(width) };
      };
      return {
        back: box(document.querySelector('[data-k2-part="Back"] a')!),
        title: box(
          [...document.querySelectorAll('.k2-pane[data-detail] > [data-slot="head"] .k2-bar-start > .k2-text')].find(
            (text) => text.textContent === "host-1.example",
          )!,
        ),
      };
    });
    expect(title.width).toBeGreaterThan(2);
    expect(title.top).toBeGreaterThanOrEqual(back.bottom);
    expect(title.top - back.bottom).toBeLessThan(24);
    expect(Math.abs(title.left - back.left)).toBeLessThanOrEqual(12);
  } finally {
    await page.close();
  }
}, 30_000);
