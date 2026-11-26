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

// A v2 page whose head shows where it stands and whose open item has no title of its own (W7: the Assistant's open
// chat): on the phone the shell's bar names that item, the last step of the head's path, from the server's page on.
// A page without such a path keeps the app's name there, and a v1 page keeps its order and its bar.
registerSsrTestPlugin({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const { default: Layout } = await import("./Layout");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { Bar, Input, Pane, Path, Text, Workspace } = await import("@k2b/ui/v2");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];

/** The Assistant's open chat: a path to it in the head, a search, the chat below. */
const workspace = (chat: string | undefined) =>
  createComponent(Workspace, {
    get head() {
      return createComponent(Bar, {
        get start() {
          return chat
            ? createComponent(Path, { label: "Gustav", items: [{ label: "Gustav", href: "/app/chat" }, { label: chat }] })
            : undefined;
        },
        get end() {
          return createComponent(Input, { type: "search", icon: "search", label: "Chats durchsuchen", placeholder: "Chats durchsuchen" });
        },
      });
    },
    get children() {
      return createComponent(Pane, {
        label: "Chat",
        get children() {
          return createComponent(Text, { children: "Wie komme ich vom Flughafen in die Altstadt?" });
        },
      });
    },
  });

const app = defineApp({
  id: "chat",
  name: "Gustav",
  icon: "ti ti-moustache",
  description: "Phone name fixture",
  baseUrl: "http://chat:3000",
  routes: ["/app/chat"],
});
type Env = { Variables: { runtime: RuntimeContext; user: User | undefined } };
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [{ ...app.meta, nav: { href: "/app/chat", section: "primary" } }] });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/chat",
    ...app.ssr<Env>(
      (c) => () =>
        createComponent(Layout, {
          c,
          ui: c.req.query("ui") === "v1" ? undefined : "v2",
          fullPage: true,
          title: [
            { title: "Start", href: "/" },
            { title: "Gustav", href: "/app/chat" },
          ],
          get children() {
            return workspace(c.req.query("chat"));
          },
        }),
    ),
  );

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

/** The real page from Layout's server HTML with the global stylesheet, at 390 px. */
const open = async (query: string): Promise<Page> => {
  const response = await server.request(`/app/chat?${query}`);
  expect(response.status).toBe(200);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(await response.text());
  await page.addStyleTag({ content: css });
  await settled(page);
  return page;
};
/** The words the phone bar shows as its title. */
const barTitle = (page: Page) =>
  page.evaluate(() => {
    const title = [
      ...document.querySelectorAll<HTMLElement>(".layout-header .layout-header-title, .layout-header .layout-header-title-menu"),
    ].find((element) => element.getBoundingClientRect().width > 0);
    return title?.textContent?.trim() ?? "";
  });

test("390 px: the phone bar names the open chat, the last step of the head's path, from the server's page on", async () => {
  const page = await open("chat=Reiseplanung%20Lissabon");
  try {
    expect(await barTitle(page)).toBe("Reiseplanung Lissabon");
  } finally {
    await page.close();
  }
}, 30_000);

test("390 px: without an open chat the phone bar names the app", async () => {
  const page = await open("");
  try {
    expect(await barTitle(page)).toBe("Gustav");
  } finally {
    await page.close();
  }
}, 30_000);
