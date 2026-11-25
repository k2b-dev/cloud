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
            return [
              registered && createComponent(V2WorkspaceNavigation, { label: "Ordner", groups }),
              createComponent(Workspace, {
                get sidebar() {
                  return createComponent(Nav, { title: "Ordner", icon: "folder", groups });
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
