import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { ChatAdminView } from "./ChatAdmin.island";

// `/admin/chat` on v2 as the server sends it: the real `AdminLayout ui="v2"` with Chat's admin screen, the admin bar
// beside it on a desk and in the shell's menu on the phone, the state, the three checks and the places that cannot
// notify. Both widths keep the v2 layout rules. With CLOUD_CHAT_V2_SHOTS set to a folder, the pictures stay there.
const shots = process.env.CLOUD_CHAT_V2_SHOTS;
registerSsrTestPlugin({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });

const { defineApp } = await import("@k2b/cloud");
const { AdminLayout, adminNavigation } = await import("@k2b/cloud/ssr");
const { default: ChatAdmin } = await import("./ChatAdmin.island");
const settings = await import("@k2b/cloud/server/middleware/settings");
const help = await import("@k2b/cloud/ssr/help");
const spies = [
  stubRailSnapshot(),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
];

const app = defineApp({
  id: "chat",
  name: "Chat",
  icon: "ti ti-messages",
  description: "Chat admin fixture",
  baseUrl: "http://chat:3000",
  routes: ["/app/chat", "/admin/chat"],
});
const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["admin", "user"],
  provider: "local",
  profile: "user",
  givenname: "Robin",
  sn: "Example",
  displayName: "Robin Example",
  mail: "robin@example.org",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};
const view = (nav: ChatAdminView["nav"]): ChatAdminView => ({
  nav,
  title: "Chat",
  state: "Bereit",
  observed: "geprüft 22:41",
  labels: {
    database: "Datenbank",
    notifications: "Benachrichtigungen aus System-Chats",
    providers: "Orte ohne Benachrichtigung",
    logs: "Logs",
  },
  database: { ready: true, value: "Erreichbar", latency: "4 ms" },
  notifications: { status: "failing", value: "Gestört" },
  providers: [
    { type: "spaces.space", line: "Kein Zugang zum Lesen · geprüft 22:38" },
    { type: "notebooks.notebook", line: "Zu viele Anfragen · geprüft 22:40" },
  ],
});
/** break-ui: everything down, the database silent, and many places with the longest reasons Chat knows. */
const worst = (nav: ChatAdminView["nav"]): ChatAdminView => ({
  ...view(nav),
  state: "Nicht verfügbar",
  database: { ready: false, value: "Nicht erreichbar" },
  notifications: {
    status: "failing",
    value: "Gestört",
    detail: "Die Prüfung der Leserechte war nicht möglich: Die Gesundheitsprüfung hat ihre Kapazität erreicht · geprüft 22:41",
  },
  // One row per kind of place with discussions: a few kinds, never dozens.
  providers: Array.from({ length: 4 }, (_, index) => ({
    type: ["spaces.space", "notebooks.notebook", "files.folder", "grids.base"][index] ?? "spaces.space",
    line: "Die Anwendung hat keinen Zugang, um Inhalte im Namen des Systems zu lesen, und muss in der Administration freigegeben werden · geprüft 22:38",
  })),
});
type Env = { Variables: { runtime: { apps: unknown[] }; user: typeof admin } };
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [{ ...app.meta, adminHref: "/admin/chat", nav: { href: "/app/chat", section: "primary" } }] });
    c.set("user", admin);
    await next();
  })
  .get(
    "/admin/chat",
    ...app.ssr<Env>(
      (c) => () =>
        createComponent(AdminLayout, {
          c,
          ui: "v2",
          title: "Chat",
          get children() {
            const nav = adminNavigation(c);
            return createComponent(ChatAdmin, { view: c.req.query("worst") === undefined ? view(nav) : worst(nav) });
          },
        }),
    ),
  );

const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
let browser: Browser;
let css: string;
let fonts: string;
beforeAll(async () => {
  // The plugin belongs to Cloud, as in the workspace fixture.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  fonts =
    (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "https://chat.test/fonts/") +
    (await Bun.file(resolve(uiDist, "tabler.css")).text()).replace(/\.\/(tabler-icons-[\w-]+\.woff2)(\?[^)]*)?/, "https://chat.test/$1");
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

for (const [state, width, height] of [
  ["", 1440, 900],
  ["", 390, 844],
  ["worst", 1440, 900],
  ["worst", 390, 844],
] as const)
  test(`the admin page keeps the v2 rules at ${width} px${state ? " with the worst state" : ""}`, async () => {
    const response = await server.request(`/admin/chat${state ? "?worst" : ""}`, { headers: { "accept-language": "de" } });
    expect(response.status).toBe(200);
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
    try {
      const page = await context.newPage();
      const errors = pageErrors(page);
      await page.route("https://chat.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        // The server's picture only: its islands' code is not built here.
        if (path === "/admin/chat")
          return route.fulfill({
            contentType: "text/html",
            body: await new HTMLRewriter()
              .on("script", { element: (element) => void element.remove() })
              .transform(response)
              .text(),
          });
        if (path === "/branding/logo")
          return route.fulfill({
            contentType: "image/svg+xml",
            body: Buffer.from(await Bun.file(resolve(import.meta.dir, "../../../cloud/public/logo.svg")).arrayBuffer()),
          });
        if (path.startsWith("/fonts/") || path.startsWith("/tabler-icons"))
          return route.fulfill({ body: Buffer.from(await Bun.file(resolve(uiDist, `.${path}`)).arrayBuffer()) });
        return route.fulfill({ status: 404, body: "" });
      });
      await page.goto("https://chat.test/admin/chat");
      await page.addStyleTag({ content: css });
      await page.addStyleTag({ content: await Bun.file(resolve(import.meta.dir, "../../../ui/src/v2/v2.css")).text() });
      await page.addStyleTag({ content: fonts });
      await settled(page);
      await page.getByText("Orte ohne Benachrichtigung").first().waitFor();
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
      // The way to Chat's logs is there at every width, the phone included: it stands in the statement's row.
      const logs = page.getByRole("link", { name: "Logs", exact: true });
      expect(await logs.isVisible()).toBe(true);
      expect(await logs.getAttribute("href")).toBe("/admin/observability/logs?search=chat");
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `${state ? "19-worst-admin" : "03-admin"}-light-${width}.png`) });
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
