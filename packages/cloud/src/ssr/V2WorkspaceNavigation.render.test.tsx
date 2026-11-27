import { afterAll, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { User } from "../contracts/shared";
import type { RuntimeContext } from "./runtime";

// A v2 page that registers its sidebar with `V2WorkspaceNavigation`: the real `Layout` (ui "v2") marks its shell in
// the server's HTML, so the phone bar's title is the menu "Name ⌄" in the first render, and the menu's entries come
// with the page.
registerSsrTestPlugin({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const { default: Layout } = await import("./Layout");
const { default: V2WorkspaceNavigation } = await import("./V2WorkspaceNavigation");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { Nav, Pane, Text, Workspace } = await import("@k2b/ui/v2");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

const groups = [{ label: "Ordner", items: [{ label: "Eingang", icon: "inbox", href: "/app/folders?folder=in", current: true }] }];
/** A base with `count` tables, as W4 measured Grids: one group, the table at `open` (from 0) open. */
const tables = (count: number, open = 0) => [
  {
    label: "Tabellen",
    items: Array.from({ length: count }, (_, index) => ({
      label: `Tabelle ${index + 1}`,
      icon: "table",
      href: `/app/folders/tables/t${String(index + 1).padStart(5, "0")}`,
      count: index % 7,
      ...(index === open ? { current: true } : {}),
    })),
  },
];

const app = defineApp({
  id: "folders",
  name: "Ordner",
  icon: "ti ti-folder",
  description: "Phone menu fixture",
  baseUrl: "http://folders:3000",
  routes: ["/app/folders"],
});
type Env = { Variables: { runtime: RuntimeContext; user: User | undefined } };
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [{ ...app.meta, nav: { href: "/app/folders", section: "primary" } }] });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/folders",
    ...app.ssr<Env>(
      (c) => () =>
        createComponent(Layout, {
          c,
          ui: "v2",
          fullPage: true,
          title: "Ordner",
          get children() {
            const registered = c.req.query("menu") !== "0";
            const entries = Number(c.req.query("entries") ?? 0);
            const shown = entries ? tables(entries, Number(c.req.query("open") ?? 1) - 1) : groups;
            return [
              registered && createComponent(V2WorkspaceNavigation, { label: "Ordner", groups: shown }),
              createComponent(Workspace, {
                get sidebar() {
                  return createComponent(Nav, { title: "Ordner", icon: "folder", groups: shown });
                },
                get children() {
                  return createComponent(Pane, {
                    label: "Liste",
                    get children() {
                      return createComponent(Text, { children: "Eingang" });
                    },
                  });
                },
              }),
            ];
          },
        }),
    ),
  );

const shellOf = (html: string) => /<div class="layout-shell-content[^"]*"[^>]*>/.exec(html)?.[0] ?? "";

test("a v2 page with V2WorkspaceNavigation marks its shell, so the phone title is the menu in the first render", async () => {
  const html = await (await server.request("/app/folders")).text();
  expect(shellOf(html)).toContain("data-workspace-navigation");
  const snapshot = /<script type="application\/json" data-cloud-workspace-navigation[^>]*>([^<]*)<\/script>/.exec(html)?.[1];
  expect(JSON.parse(snapshot ?? "null")).toEqual({
    label: "Ordner",
    items: [
      {
        id: "group:0",
        label: "Ordner",
        section: true,
        children: [{ id: "/app/folders?folder=in", label: "Eingang", icon: "ti ti-inbox", active: true, href: "/app/folders?folder=in" }],
      },
    ],
  });
});

test("without it the shell stays unmarked and the phone title stays the app's name", async () => {
  const html = await (await server.request("/app/folders?menu=0")).text();
  expect(shellOf(html)).not.toContain("data-workspace-navigation");
  expect(html).not.toContain("data-cloud-workspace-navigation");
});

// W4: a Grids base with 1000 tables. What the menu adds to the page is bounded, however many entries its Nav has; the
// Nav itself shows them, and the menu reads the rest once its island is alive. Measured 27.11.2026: 125,090 bytes
// before (a snapshot of every entry), 5,024 after (40 entries); the budget leaves room for longer labels and links.
const MENU_BYTES = 6 * 1024;
const snapshotOf = (html: string) =>
  JSON.parse(/<script type="application\/json" data-cloud-workspace-navigation[^>]*>([^<]*)<\/script>/.exec(html)?.[1] ?? "null") as {
    items: { label: string; children?: { label: string; active?: boolean }[] }[];
  };

test("with 1000 entries the page carries the first 40 and the way to the open one, for a menu before the island runs", async () => {
  const snapshot = snapshotOf(await (await server.request("/app/folders?entries=1000&open=500")).text());
  const labels = snapshot.items[0]?.children?.map((entry) => entry.label) ?? [];
  // the group's row counts as one of the 40
  expect(labels.slice(0, 39)).toEqual(Array.from({ length: 39 }, (_, index) => `Tabelle ${index + 1}`));
  expect(labels.slice(39)).toEqual(["Tabelle 500"]);
  expect(snapshot.items[0]?.children?.at(-1)?.active).toBe(true);
});
test("with 1000 entries the menu adds a bounded payload to the page, not one copy of every entry", async () => {
  const page = async (query: string) => (await (await server.request(`/app/folders?${query}`)).text()).length;
  const added = (await page("entries=1000")) - (await page("entries=1000&menu=0"));
  console.log(`V2WorkspaceNavigation with 1000 entries adds ${added} bytes`);
  expect(added).toBeLessThanOrEqual(MENU_BYTES);
});
