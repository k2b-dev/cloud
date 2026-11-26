import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { User } from "../contracts/shared";
import type { RuntimeContext } from "./runtime";

// An admin page on v2: `AdminLayout ui="v2"` is the shell, and the page's island returns one `AdminWorkspace` with the
// admin bar from `adminNavigation(c)`. The server's HTML already holds the bar as a v2 `Nav` (the same groups, links and open
// entry as the v1 sidebar), the open area's sections one level in, and the phone menu's entries; the v1 workspace and
// sidebar stay away.
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
const { Bar, Pane, Text } = await import("@k2b/ui/v2");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

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
const page = (sections: Parameters<typeof adminNavigation>[1]) =>
  app.ssr<Env>(
    (c) => () =>
      createComponent(AdminLayout, {
        c,
        ui: "v2",
        title: "Speicher",
        get children() {
          return createComponent(AdminWorkspace, {
            nav: adminNavigation(c, sections),
            get head() {
              return createComponent(Bar, { start: createComponent(Text, { children: "Speicher" }) });
            },
            get children() {
              return createComponent(Pane, {
                label: "Speicher",
                get children() {
                  return createComponent(Text, { children: "Inhalt" });
                },
              });
            },
          });
        },
      }),
  );
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", {
      apps: [{ ...app.meta, adminHref: "/admin/example", nav: { href: "/app/example", section: "primary" } }],
    });
    c.set("user", admin);
    c.set("adminCodeApprovals", 2);
    await next();
  })
  .get("/admin/rail", ...page([]))
  .get(
    "/admin/storage",
    ...page([
      { label: "Standard", icon: "database", href: "/admin/storage" },
      { label: "Archiv", icon: "ti ti-archive", href: "/admin/storage?bucket=archive", current: true, dot: "warn" },
    ]),
  );

const request = async (path: string) => (await server.request(path, { headers: { "accept-language": "de" } })).text();
const navOf = (html: string) => /<nav class="k2-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
const entries = (nav: string) =>
  [...nav.matchAll(/<(?:a|button)[^>]*data-k2-part="Nav\.Item"[^>]*>[\s\S]*?<span class="k2-ni-name">([^<]*)<\/span>/g)].map(
    ([whole, name]) => ({
      name,
      current: whole.includes('aria-current="page"'),
      level: /data-level="(\d)"/.exec(whole)?.[1] ?? "1",
    }),
  );

describe("an admin page on v2", () => {
  test("the server's page holds the admin bar as a v2 Nav with the open page current, inside the v2 scope", async () => {
    const html = await request("/admin/rail");
    expect(html).toMatch(/<main class="[^"]*\bk2-ui\b/);
    expect(html).not.toContain("admin-sidebar");
    const nav = navOf(html);
    expect(nav).toContain('aria-label="Administration"');
    for (const label of ["Einrichten", "Betrieb", "Einstellungen je App"]) expect(nav).toContain(label);
    const items = entries(nav);
    expect(items.map((item) => item.name)).toEqual(expect.arrayContaining(["Übersicht", "Speicher", "App-Leiste", "Code", "Beispiel"]));
    expect(items.filter((item) => item.current).map((item) => item.name)).toEqual(["App-Leiste"]);
    // the waiting Code approvals stay a count on the entry
    expect(nav).toMatch(/Code<\/span><span class="k2-ni-count">2<\/span>/);
  });

  test("an area's sections stand one level in under its entry, and the open section is the current one", async () => {
    const items = entries(navOf(await request("/admin/storage?bucket=archive")));
    const at = items.findIndex((item) => item.name === "Speicher");
    expect(items.slice(at, at + 3)).toEqual([
      { name: "Speicher", current: false, level: "1" },
      { name: "Standard", current: false, level: "2" },
      { name: "Archiv", current: true, level: "2" },
    ]);
    // other areas keep their place without sections
    expect(items.filter((item) => item.level === "2")).toHaveLength(2);
  });

  test("the phone menu comes with the first render and lists the same admin bar", async () => {
    const html = await request("/admin/rail");
    expect(/<div class="layout-shell-content[^"]*"[^>]*>/.exec(html)?.[0]).toContain("data-workspace-navigation");
    const snapshot = /<script type="application\/json" data-cloud-workspace-navigation[^>]*>([^<]*)<\/script>/.exec(html)?.[1];
    const menu = JSON.parse(snapshot ?? "null") as {
      label: string;
      items: { label: string; children?: { label: string; active?: boolean }[] }[];
    };
    expect(menu.label).toBe("Administration");
    const operations = menu.items.find((item) => item.label === "Betrieb");
    expect(operations?.children?.find((child) => child.label === "App-Leiste")?.active).toBe(true);
  });
});
