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

// On a signed-in phone the search of a v2 page's head sits in the shell's phone bar, as the mockup draws Mail ("Mail",
// search, menu; the head carries only its views): the bar's search button opens the head's field, which then opens
// over the head, and the head keeps its room for its tabs. The page is the real `Layout`'s server HTML with the global
// stylesheet, the first frame a person sees; the button's deed is `openPageSearch`, loaded as shipped.
registerSsrTestPlugin({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const { default: Layout } = await import("./Layout");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { Bar, Button, Input, Pane, Tabs, Text, Workspace } = await import("@k2b/ui/v2");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];

/** Mail's mailbox on v2: its views as tabs, the search and "…" in the head, the list below. */
const workspace = () =>
  createComponent(Workspace, {
    get head() {
      return createComponent(Bar, {
        get start() {
          return createComponent(Tabs, {
            label: "Ansichten",
            items: [
              { label: "Alle", count: 12, href: "/app/phone", current: true },
              { label: "Zu erledigen", count: 5, href: "/app/phone?view=todo" },
              { label: "Weitere", count: "+10", menu: [{ label: "Später", href: "/app/phone?view=later" }] },
            ],
          });
        },
        get end() {
          return [
            createComponent(Input, { type: "search", icon: "search", label: "Suchen", placeholder: "Suchen" }),
            createComponent(Button, { keep: true, variant: "ghost", icon: "dots", label: "Weitere Aktionen" }),
          ];
        },
      });
    },
    get children() {
      return createComponent(Pane, {
        label: "Liste",
        get children() {
          return createComponent(Text, { children: "Holzwerk Brandt" });
        },
      });
    },
  });

const app = defineApp({
  id: "phone",
  name: "Mail",
  icon: "ti ti-mail",
  description: "Phone search fixture",
  baseUrl: "http://phone:3000",
  routes: ["/app/phone"],
});
type Env = { Variables: { runtime: RuntimeContext; user: User | undefined } };
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [{ ...app.meta, nav: { href: "/app/phone", section: "primary" } }] });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/phone",
    ...app.ssr<Env>(
      (c) => () =>
        createComponent(Layout, {
          c,
          // `?ui=v1` is a page of the classic library: the bar's search stays the global one
          ui: c.req.query("ui") === "v1" ? undefined : "v2",
          fullPage: true,
          title: [{ title: "Start", href: "/" }, { title: "Mail", href: "/app/phone" }, { title: "Posteingang" }],
          get children() {
            return workspace();
          },
        }),
    ),
  );

let browser: Browser;
let css: string;
let helpers: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  const entry = resolve(import.meta.dir, "page-search.fixture.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: `import { openPageSearch } from "../browser/page-search"; window.openPageSearch = openPageSearch;` },
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the page search.");
  helpers = await bundle.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

declare global {
  interface Window {
    openPageSearch?: (trigger: HTMLElement) => boolean;
  }
}

/** The real page from Layout's server HTML with the global stylesheet; the phone bar's button runs `openPageSearch`. */
const open = async (ui: "v1" | "v2" = "v2"): Promise<Page> => {
  const response = await server.request(`/app/phone?ui=${ui}`);
  expect(response.status).toBe(200);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(await response.text());
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: helpers });
  await settled(page);
  return page;
};

/** The names of the phone bar's buttons, left to right. */
const barButtons = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".layout-header button")]
      .filter((button) => button.getBoundingClientRect().width > 0)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((button) => button.getAttribute("aria-label")),
  );

/** The head of the page: the tabs on its line, and the box of its search field against the head's bar. */
const head = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.layout-content-main [data-slot="head"] > .k2-bar')!.getBoundingClientRect();
    const first = document.querySelector(".k2-tabs > .k2-tab")!.getBoundingClientRect().top;
    const row = document.querySelector(".k2-tabs")!.getBoundingClientRect();
    const field = document.querySelector('[data-slot="head"] [data-k2-part="Input"][data-search]')!.getBoundingClientRect();
    return {
      tabs: [...document.querySelectorAll<HTMLElement>(".k2-tabs > .k2-tab")]
        // on the line of the tabs and whole within their row (a tab without room wraps below it or is cut off there)
        .filter((tab) => tab.getBoundingClientRect().top === first && tab.getBoundingClientRect().right <= row.right + 0.5)
        .map((tab) => tab.firstChild?.textContent ?? ""),
      field: [Math.round(field.width), Math.round(field.left - bar.left), Math.round(bar.right - field.right)],
      overHead: field.top >= bar.top && field.bottom <= bar.bottom,
    };
  });

test("a v2 page's search sits in the phone bar; the head keeps its tabs", async () => {
  const page = await open();
  try {
    expect(await barButtons(page)).toEqual(["Search", "Open help", "Open apps"]);
    const found = await head(page);
    expect(found.tabs).toEqual(["Alle", "Zu erledigen"]);
    expect(found.field[0]).toBeLessThanOrEqual(1);
  } finally {
    await page.close();
  }
}, 30_000);

test("the phone bar's search opens the head's field over the head, and Escape gives the focus back to the bar", async () => {
  const page = await open();
  try {
    // the field's own Escape (`@k2b/ui/v2`, delegated to the document): it folds the field and lets the focus go
    await page.evaluate(() =>
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !(event.target instanceof HTMLInputElement)) return;
        event.preventDefault();
        event.target.blur();
      }),
    );
    const button = page.getByRole("button", { name: "Search", exact: true });
    await button.evaluate((trigger) => {
      if (trigger instanceof HTMLElement) trigger.addEventListener("click", () => window.openPageSearch?.(trigger));
    });
    await button.click();
    await settled(page);
    const search = page.getByRole("searchbox", { name: "Suchen" });
    expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
    expect(await head(page)).toMatchObject({ field: [390 - 2 * 16, 16, 16], overHead: true });
    await page.keyboard.type("Brandt");
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await button.evaluate((trigger) => document.activeElement === trigger)).toBe(true);
    expect(await search.inputValue()).toBe("Brandt");
    expect((await head(page)).field[0]).toBeLessThanOrEqual(1);
  } finally {
    await page.close();
  }
}, 30_000);

test("a page of the classic library keeps the global search in the phone bar", async () => {
  const page = await open("v1");
  try {
    expect(await barButtons(page)).toEqual(["Open global search", "Open help", "Open apps"]);
    expect(await page.locator("[data-k2-host-search]").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);
