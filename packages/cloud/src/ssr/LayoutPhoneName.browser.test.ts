import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { User } from "../contracts/shared";
import type {} from "./LayoutPhoneName.browser-harness";
import type { RuntimeContext } from "./runtime";

// A v2 page whose head shows where it stands and whose open item has no title of its own (W7: the Assistant's open
// chat): on the phone the shell's bar names that item, the last step of the head's path, from the server's page on,
// and follows it when the page opens another item without a new page. A page without such a path keeps the app's
// name there.
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
let harness: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const client = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "LayoutPhoneName.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "layout-phone-name",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!client.success) throw new AggregateError(client.logs, "Could not build the phone name harness.");
  harness = await client.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

/** The real page from Layout's server HTML with the global stylesheet, at 390 px. */
const open = async (query: string): Promise<Page> => {
  const response = await server.request(`/app/chat?${query}`);
  expect(response.status).toBe(200);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const html = await response.text();
  // a real address: the shell's islands read the page's URL
  await page.route("http://cloud.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://cloud.test/app/chat?${query}`);
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

test("390 px: the phone bar follows the page's islands when another chat opens without a new page", async () => {
  const page = await open("chat=Reiseplanung%20Lissabon");
  try {
    const errors = pageErrors(page);
    await page.evaluate(() => (window.__chat = "Reiseplanung Lissabon"));
    await page.addScriptTag({ content: harness });
    expect(errors).toEqual([]);
    await page.locator('body[data-mounted="true"]').waitFor({ timeout: 10_000 });
    // the header's island keeps the server's name until the page's island tells its own
    expect(await page.locator("body").getAttribute("data-header-first")).toBe("Reiseplanung Lissabon");
    await settled(page);
    expect(await barTitle(page)).toBe("Reiseplanung Lissabon");
    await page.evaluate(() => window.__openChat?.("Budget 2027"));
    await settled(page);
    expect(await barTitle(page)).toBe("Budget 2027");
    // no open chat: the app's name again
    await page.evaluate(() => window.__openChat?.(undefined));
    await settled(page);
    expect(await barTitle(page)).toBe("Gustav");
  } finally {
    await page.close();
  }
}, 30_000);
