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

// On a signed-in phone an open v2 detail's way back (the part `Back`) takes the title's place in the phone bar:
// "‹ Posteingang", then search, help and the app menu, which stay usable. Only the shell's stylesheet does it. The
// page is the real `Layout`'s server HTML (as in `Layout.unchanged`), so the test sees every element Layout puts
// between the bar and the content; a hand-built page missed the page trail's script once.
registerSsrTestPlugin({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const { default: Layout } = await import("./Layout");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { Bar, Pane, Text, Workspace } = await import("@k2b/ui/v2");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];

/** Mail's mailbox on v2: the list and, when `open`, a conversation with its way back to the list named `list`. */
const workspace = (open: boolean, list: string) =>
  createComponent(Workspace, {
    get head() {
      return createComponent(Bar, { start: "Alle · Handlungsbedarf" });
    },
    get children() {
      return createComponent(Pane.Split, {
        get children() {
          return [
            createComponent(Pane, {
              label: "Liste",
              get children() {
                return createComponent(Text, { children: "Holzwerk Brandt" });
              },
            }),
            open &&
              createComponent(Pane, {
                detail: true,
                label: "Nachricht",
                back: { label: list, href: "/app/phone" },
                get head() {
                  return createComponent(Bar, { start: "Angebot Eichenplatten" });
                },
                get children() {
                  return createComponent(Text, { children: "Guten Tag Frau Solberg" });
                },
              }),
          ];
        },
      });
    },
  });

const app = defineApp({
  id: "phone",
  name: "Mail",
  icon: "ti ti-mail",
  description: "Phone bar fixture",
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
          ui: "v2",
          fullPage: true,
          // Mail's title has no page above it; `up` gives the page one, so the shell's row of the way up exists.
          title:
            c.req.query("trail") === "up"
              ? [{ title: "Projekte", href: "/app/phone/projects" }, { title: "Posteingang" }]
              : [{ title: "Start", href: "/" }, { title: "Mail", href: "/app/phone" }, { title: "Kontakt" }],
          get children() {
            return workspace(c.req.query("open") === "1", c.req.query("list") ?? "Posteingang");
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

type Shell = { open?: boolean; list?: string; trail?: "up"; banner?: boolean; width?: number };

/** The real page from Layout's server HTML with the global stylesheet; `banner` adds one below the bar, as Layout's warnings stand. */
const open = async ({ open = true, list, trail, banner = false, width = 390 }: Shell): Promise<Page> => {
  const query = new URLSearchParams({ open: open ? "1" : "0", ...(list ? { list } : {}), ...(trail ? { trail } : {}) });
  const response = await server.request(`/app/phone?${query}`);
  expect(response.status).toBe(200);
  let html = await response.text();
  expect(html.split("</header>").length).toBe(2);
  if (banner) html = html.replace("</header>", '</header><div role="status">Neue Version verfügbar</div>');
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  await settled(page);
  return page;
};

/**
 * What a person sees in the phone bar's row, left to right: each control's name and left edge, whether a tap on its
 * middle reaches it, and whether it runs into the next one (a text's width depends on the engine's font).
 */
const barRow = (page: Page) =>
  page.evaluate(() => {
    const name = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const inRow = Array.from(document.querySelectorAll("a[href], button"))
      .filter((element) => visible(element) && element.getBoundingClientRect().bottom <= 46.5)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return inRow.map((element, index) => {
      const box = element.getBoundingClientRect();
      const tapped = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("a[href], button");
      const next = inRow[index + 1]?.getBoundingClientRect();
      return [
        `${name(element)} at ${Math.round(box.left)}`,
        tapped === element ? "" : ` (a tap reaches ${tapped ? name(tapped) : "nothing"})`,
        next && box.right > next.left ? " (runs into the next)" : "",
      ].join("");
    });
  });

/** The names the keyboard reaches with Tab, from the start of the page. */
const tabOrder = async (page: Page, steps: number) => {
  const names: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press("Tab");
    names.push(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? ""),
    );
  }
  return names;
};

/** Where the card (the page's content) begins: below the bar, or at the top when the way back shares the bar's row. */
const cardTop = (page: Page) => page.evaluate(() => document.querySelector(".layout-content-main")!.getBoundingClientRect().top);

/** How far the way back's name may reach (its padding keeps the bar's controls free) and where those controls begin. */
const backRoom = (page: Page) =>
  page.evaluate(() => {
    const back = document.querySelector('[data-k2-part="Back"]')!;
    const end = back.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(back).paddingRight);
    const controls = Math.min(
      ...Array.from(document.querySelectorAll(".layout-header button"), (button) => button.getBoundingClientRect()).flatMap((box) =>
        box.width > 0 ? [box.left] : [],
      ),
    );
    return { nameEndsBeforeControls: end <= controls };
  });

test("an open detail's way back takes the title's place in the phone bar; search, help and apps stay usable", async () => {
  const page = await open({});
  try {
    // One row: the way back where the title was, then the bar's controls, each reached by a tap on it.
    expect(await barRow(page)).toEqual(["Posteingang at 8", "Open global search at 278", "Open help at 314", "Open apps at 350"]);
    expect(await backRoom(page)).toEqual({ nameEndsBeforeControls: true });
    expect(await cardTop(page)).toBe(0);
    expect(await page.locator(".layout-header-title").isVisible()).toBe(false);
    // The only way back, named by the list it leads to; the workspace head (the views) gives way (#4085).
    expect(await page.getByRole("link", { name: "Posteingang" }).count()).toBe(1);
    expect(await page.getByText("Alle · Handlungsbedarf").isVisible()).toBe(false);
    // The keyboard meets the bar's controls first and then the way back, the first stop of the content.
    expect(await tabOrder(page, 4)).toEqual(["Open global search", "Open help", "Open apps", "Posteingang"]);
  } finally {
    await page.close();
  }
}, 30_000);

// Known gap of @k2b/ui v2 (lane C builds it, 24.11.): the text button of `Back` does not end a long name in "…" but
// runs past its bar, on any page. It turns red once `Back` shortens its name: then make it a plain test.
test.failing("a long list name ends before the bar's controls", async () => {
  const page = await open({ list: "Suchergebnisse für Eichenplatten aus dem Lager Nord" });
  try {
    expect(await barRow(page)).toEqual([
      "Suchergebnisse für Eichenplatten aus dem Lager Nord at 8",
      "Open global search at 278",
      "Open help at 314",
      "Open apps at 350",
    ]);
  } finally {
    await page.close();
  }
}, 30_000);

test("without an open detail the phone bar keeps its title and the card starts below it", async () => {
  const page = await open({ open: false });
  try {
    expect(await page.locator(".layout-header-title").isVisible()).toBe(true);
    expect(await cardTop(page)).toBe(46);
    expect(await page.getByText("Alle · Handlungsbedarf").isVisible()).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);

test("a banner between the bar and the content keeps the bar whole and the way back in its own row", async () => {
  const page = await open({ banner: true });
  try {
    expect(await page.locator(".layout-header-title").isVisible()).toBe(true);
    const banner = await page.getByRole("status").filter({ hasText: "Neue Version" }).boundingBox();
    expect(banner?.y).toBe(46);
    const back = await page.getByRole("link", { name: "Posteingang" }).boundingBox();
    expect(back?.y).toBeGreaterThan(46 + (banner?.height ?? 0));
  } finally {
    await page.close();
  }
}, 30_000);

// A v2 workspace brings its own head and way back, as a v1 workspace does: the shell's row of the way up gives way,
// so the page has one way back, not two.
test("a v2 page with a page above it shows no second row of the way up", async () => {
  for (const open_ of [false, true]) {
    const page = await open({ open: open_, trail: "up" });
    try {
      expect(await page.locator(".layout-page-head").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  }
}, 30_000);

test("from 768 px the way back stays hidden and nothing of the phone bar applies", async () => {
  const page = await open({ width: 1024 });
  try {
    expect(await page.getByRole("link", { name: "Posteingang" }).isVisible()).toBe(false);
    expect(await page.locator(".layout-header").isVisible()).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);
