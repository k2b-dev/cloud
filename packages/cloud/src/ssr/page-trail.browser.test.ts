import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// The way up is real layout and real navigation: which row shows where, what
// collapses when space runs out, and where a click on "‹ Users" lands after
// filtering and scrolling. A real engine loads the server-rendered Layout from
// a real server, with the global stylesheet and the browser runtime Cloud
// installs, across document navigations in one tab. All names are invented.
const root = mkdtempSync(resolve(tmpdir(), "cloud-page-trail-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);

const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { server, folders } = await import("./page-trail.browser-harness");

let browser: Browser;
let css: string;
let runtime: string;
let origin: string;
let stop: () => void;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  // What Cloud's islands install once per document, from the shipped browser
  // build of `@k2b/ui` and Cloud's own runtime source.
  const entry = resolve(import.meta.dir, "page-trail.runtime-fixture.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { followPageTrail, installAppWorkspaceController, installPageTitleController } from "@k2b/ui";
import { layout } from "./layout-runtime";
import { installPageTrailRuntime } from "./page-trail-runtime";
import { attachCommandShortcuts, contextCommandsWithShortcuts, shortcutLabel } from "../browser/command-shortcuts";
import { platformMessages } from "./platform-messages";
const t = platformMessages.resolve([document.documentElement.lang]).t;
installAppWorkspaceController();
installPageTitleController(document);
followPageTrail(document);
window.layout = layout;
installPageTrailRuntime((page) => ({ title: t.pageUp({ page }), description: t.pageUpDescription }));
attachCommandShortcuts((command) => typeof command.action === "function" && command.action());
window.shortcuts = () => contextCommandsWithShortcuts().filter((command) => command.shortcut).map((command) => ({ title: command.title, keys: shortcutLabel(command.shortcut) }));`,
    },
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the page trail runtime.");
  runtime = await bundle.outputs[0]!.text();
  const served = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      // Without island bundles, the page gets the stylesheet and the runtime instead.
      const markup = (await response.text())
        .replace(/<script type="module">[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace(
          "</body>",
          `<script>window.initialMainRect=document.querySelector(".k2b-app-workspace__main")?.getBoundingClientRect().toJSON();</script><script>${runtime}</script></body>`,
        );
      return new Response(markup, { status: response.status, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  origin = `http://localhost:${served.port}`;
  stop = () => served.stop(true);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await browser?.close();
  stop?.();
});

type Device = { name: string; width: number; height: number; touch: boolean };
const phone: Device = { name: "phone", width: 390, height: 844, touch: true };
const ipadPortrait: Device = { name: "iPad portrait", width: 820, height: 1180, touch: true };
const ipadLandscape: Device = { name: "iPad landscape", width: 1180, height: 820, touch: true };
const laptop: Device = { name: "laptop", width: 1366, height: 900, touch: false };
const desktop: Device = { name: "desktop", width: 1920, height: 1080, touch: false };

type Options = { language?: "en" | "de"; theme?: "light" | "dark" };
const open = async (device: Device, path: string, options: Options = {}): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    hasTouch: device.touch,
    isMobile: device.touch,
    locale: options.language ?? "en",
    extraHTTPHeaders: { "Accept-Language": options.language ?? "en" },
  });
  await context.addCookies([{ name: "theme", value: options.theme ?? "light", url: origin }]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  await settle(page);
  return { context, page };
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Row = { display: string; box: Box; borders: number[]; background: string } | null;
type Trail = {
  head: Row;
  shellRow: Row;
  title: { text: string; box: Box; tag: string } | null;
  form: "title" | "back" | "path";
  back: { text: string; label: string | null; href: string | null; box: Box } | null;
  crumbs: string[];
  more: boolean;
  arrow: { label: string | null; href: string | null; box: Box } | null;
  hairlines: string[];
};

/** Everything visible about the way up, measured in the page. */
const trail = (page: Page): Promise<Trail> =>
  page.evaluate(() => {
    const visible = (element: Element | null | undefined): element is HTMLElement =>
      !!element && getComputedStyle(element).display !== "none" && element.getClientRects().length > 0;
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const row = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        display: style.display,
        box: box(element),
        borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(Number.parseFloat),
        background: style.backgroundColor,
      };
    };
    const shown = [...document.querySelectorAll(".k2b-page-title")].find(visible) ?? null;
    const title = shown?.querySelector(".k2b-page-title__title");
    const back = shown?.querySelector(".k2b-page-title__up");
    const path = shown?.querySelector(".k2b-page-title__path");
    const arrow = shown?.querySelector(".k2b-page-title__back");
    const appWidth = document.querySelector(".layout-shell-content")?.getBoundingClientRect().width ?? window.innerWidth;
    const hairlines = [...document.querySelectorAll(".cloud-app-canvas *")].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") return [];
      const vertical = rect.width > 0 && rect.width <= 2 && rect.height >= window.innerHeight / 2;
      const horizontal = rect.height > 0 && rect.height <= 2 && rect.width >= appWidth / 2;
      return vertical || horizontal ? [element.className.toString() || element.localName] : [];
    });
    return {
      head: row(".k2b-app-workspace__head"),
      shellRow: row(".layout-page-head"),
      title: title
        ? { text: title.querySelector(".k2b-page-title__text")?.textContent ?? "", box: box(title), tag: title.localName }
        : null,
      form: visible(back) ? "back" : visible(path) ? "path" : "title",
      back: visible(back)
        ? { text: back.textContent?.trim() ?? "", label: back.getAttribute("aria-label"), href: back.getAttribute("href"), box: box(back) }
        : null,
      crumbs: path ? [...path.querySelectorAll(":scope > li")].filter(visible).map((item) => item.textContent?.trim() ?? "") : [],
      more: visible(path?.querySelector(".k2b-page-title__more") ?? null),
      arrow: visible(arrow) ? { label: arrow.getAttribute("aria-label"), href: arrow.getAttribute("href"), box: box(arrow) } : null,
      hairlines,
    };
  });
const none = [0, 0, 0, 0];

describe("the rule decides the form by depth", () => {
  for (const device of [ipadPortrait, ipadLandscape, laptop, desktop]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${device.name} ${theme}: one level shows the title, two a back link, more a path, in one 46 px head without lines`, async () => {
        const { context, page } = await open(device, "/app/accounts/users", { theme });
        try {
          const list = await trail(page);
          // Start and the app root are dropped, so the list is one level: its own heading is the title.
          if (device.width >= 1024) expect(list.head?.display).toBe("none");
          else expect(list).toMatchObject({ form: "title", title: { text: "Users" } });
          expect(list.shellRow?.display).toBe("none");

          await page.goto(`${origin}/app/accounts/users/user07`);
          await settle(page);
          const detail = await trail(page);
          expect(detail.head).toMatchObject({ display: "flex", borders: none });
          expect(detail.head!.box.height).toBe(46);
          // Flush up to 1536 px; the card's own edge above it.
          expect(detail.head!.box.top).toBeLessThanOrEqual(device.width >= 1536 ? 9 : 0);
          expect(detail).toMatchObject({ form: "back", title: { text: "user07", tag: "p" }, arrow: null });
          // The page's own heading is its only one; the head's title is no second.
          expect(await page.getByRole("heading", { level: 1 }).allTextContents()).toEqual(["User Seven"]);
          expect(detail.back).toMatchObject({ text: "Users", label: "Back to Users", href: "/app/accounts/users" });
          expect(detail.hairlines).toEqual([]);

          await page.goto(`${origin}/app/files?path=${encodeURIComponent(folders.slice(0, 3).join("/"))}`);
          await settle(page);
          const folder = await trail(page);
          expect(folder).toMatchObject({ form: "path", title: { text: folders[2] }, crumbs: folders.slice(0, 2), more: false });
          expect(folder.head!.box.height).toBe(46);
          // The title sits at the same place at every depth that has a row above it.
          expect(folder.title!.box.top).toBe(detail.title!.box.top);
          expect(folder.hairlines).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  test("phones: a back arrow left of the title names the parent; the path row gives way to it", async () => {
    for (const language of ["en", "de"] as const) {
      const { context, page } = await open(phone, "/app/accounts/users/user07", { language });
      try {
        const detail = await trail(page);
        expect(detail).toMatchObject({ form: "title", title: { text: "user07" }, back: null });
        expect(detail.arrow).toMatchObject({ label: language === "de" ? "Zurück zu Users" : "Back to Users", href: "/app/accounts/users" });
        expect(detail.arrow!.box.left).toBeLessThan(detail.title!.box.left);
        expect(detail.arrow!.box.height).toBeGreaterThanOrEqual(32);
        await page.goto(`${origin}/app/files?path=${encodeURIComponent(folders.join("/"))}`);
        await settle(page);
        const folder = await trail(page);
        expect(folder).toMatchObject({ form: "title", crumbs: [], title: { text: "Questions about the foundation" } });
        expect(folder.arrow?.label).toBe(`${language === "de" ? "Zurück zu" : "Back to"} ${folders[3]}`);
        // The list page has nothing above it, so the phone keeps its header alone.
        await page.goto(`${origin}/app/accounts/users`);
        await settle(page);
        expect((await trail(page)).head?.display).toBe("none");
      } finally {
        await context.close();
      }
    }
  });

  test("a long path collapses its middle into a menu only when it does not fit", async () => {
    const path = `/app/files?path=${encodeURIComponent(folders.join("/"))}&detail=1`;
    const wide = await open(desktop, path);
    try {
      expect(await trail(wide.page)).toMatchObject({ more: false, crumbs: folders.slice(0, 4) });
    } finally {
      await wide.context.close();
    }
    for (const language of ["en", "de"] as const) {
      const { context, page } = await open(ipadPortrait, path, { language });
      try {
        const before = await trail(page);
        // The permanent detail now narrows the head too. Only the parent fits;
        // the first level joins the middle levels in the menu.
        expect(before.more).toBe(true);
        expect(before.crumbs).toEqual(["…", folders[3]!]);
        const hidden = folders.slice(0, 3);
        expect(hidden.length).toBeGreaterThan(0);
        // The collapse changes no geometry.
        expect(before.head!.box.height).toBe(46);

        const more = page.locator(".k2b-page-title__more-button:visible");
        expect(await more.getAttribute("aria-label")).toBe(language === "de" ? "Weitere Ebenen" : "More levels");
        await more.click();
        const menuId = (await more.getAttribute("popovertarget"))!;
        const menu = await page.evaluate((id) => {
          const menu = document.getElementById(id)!;
          const items = [...menu.querySelectorAll<HTMLElement>("a:not([hidden])")];
          return {
            open: menu.matches(":popover-open"),
            items: items.map((item) => item.textContent?.trim()),
            indents: items.map((item) => Number.parseFloat(getComputedStyle(item).paddingInlineStart)),
            focus: document.activeElement?.textContent?.trim(),
          };
        }, menuId);
        expect(menu.open).toBe(true);
        expect(menu.items).toEqual(hidden);
        expect(menu.focus).toBe(hidden[0]);
        for (let index = 1; index < menu.indents.length; index += 1) expect(menu.indents[index]).toBeGreaterThan(menu.indents[index - 1]!);
        await page.keyboard.press("Escape");
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-page-title__more-button"))).toBe(true);
        expect((await trail(page)).title!.box).toEqual(before.title!.box);
      } finally {
        await context.close();
      }
    }
  });

  test("a page without a workspace gets the shell's row; a third-party app's own header gets the same trail", async () => {
    for (const device of [phone, ipadPortrait, laptop]) {
      const { context, page } = await open(device, "/me/notifications/history");
      try {
        const history = await trail(page);
        expect(history.shellRow?.display).toBe("flex");
        expect(history.shellRow?.borders).toEqual(none);
        expect(history.title?.text).toBe("Delivery history");
        if (device.width < 768) expect(history.arrow?.label).toBe("Back to Notifications");
        else expect(history.back).toMatchObject({ text: "Notifications", href: "/me/notifications" });

        await page.goto(`${origin}/app/timetrack/entries/e1`);
        await settle(page);
        const entry = await trail(page);
        // The app's header holds it, as a heading; the shell adds no row of its own.
        expect(entry.shellRow?.display).toBe("none");
        expect(entry.title).toMatchObject({ text: "Homepage: agree on drafts", tag: "h1" });
        const inHeader = await page.evaluate(() => !!document.querySelector(".timetrack-head .k2b-page-title"));
        expect(inHeader).toBe(true);
        if (device.width < 768) expect(entry.arrow?.label).toBe("Back to Website relaunch");
        else expect(entry.back).toMatchObject({ text: "Website relaunch", href: "/app/timetrack/projects/web" });
        expect(await page.locator(".timetrack-head .k2b-page-title__subtitle").textContent()).toBe("2:15 h");

        // After an in-page navigation the server-rendered header follows, in its place and with its subtitle.
        await page.evaluate(() => {
          (window as unknown as { layout: { update: (value: unknown) => void } }).layout.update({
            breadcrumbs: [
              { title: "Time", href: "/app/timetrack" },
              { title: "Other project", href: "/app/timetrack/projects/other" },
              { title: "Second entry" },
            ],
          });
          window.history.pushState(null, "", "/app/timetrack/entries/e2");
        });
        await settle(page);
        const next = await trail(page);
        expect(next.title).toMatchObject({ text: "Second entry", tag: "h1" });
        if (device.width < 768) expect(next.arrow).toMatchObject({ label: "Back to Other project", href: "/app/timetrack/projects/other" });
        else expect(next.back).toMatchObject({ text: "Other project", href: "/app/timetrack/projects/other" });
        expect(await page.locator(".timetrack-head .k2b-page-title__subtitle").textContent()).toBe("2:15 h");
        expect(await page.evaluate(() => document.querySelector(".timetrack-head")!.firstElementChild!.className)).toContain(
          "k2b-page-title",
        );
        expect(next.shellRow?.display).toBe("none");
      } finally {
        await context.close();
      }
    }
  });
});

describe("layout.update() keeps the trail current", () => {
  test("a server-rendered workspace head follows in-page navigation, at every depth", async () => {
    const { context, page } = await open(laptop, "/app/accounts/users");
    try {
      type Update = { title?: string; breadcrumbs?: { title: string; href?: string }[] };
      // As an island does: it updates the title and moves to the new address in the same task.
      const update = (value: Update, address?: string) =>
        page.evaluate(
          ([next, url]) => {
            // The page's navigation follows the route too: only the exact list marks Users.
            const item = document.querySelector('.k2b-app-workspace__sidebar [href="/app/accounts/users"]');
            if (url && url !== "/app/accounts/users") item?.removeAttribute("aria-current");
            else if (url) item?.setAttribute("aria-current", "page");
            (window as unknown as { layout: { update: (value: Update) => void } }).layout.update(next as Update);
            if (url) window.history.pushState(null, "", url as string);
          },
          [value, address] as const,
        );
      expect((await trail(page)).head?.display).toBe("none");
      await update(
        {
          breadcrumbs: [
            { title: "Start", href: "/" },
            { title: "Accounts", href: "/app/accounts" },
            { title: "Users", href: "/app/accounts/users" },
            { title: "user09" },
          ],
        },
        "/app/accounts/users/user09",
      );
      await settle(page);
      expect(await trail(page)).toMatchObject({
        head: { display: "flex" },
        form: "back",
        title: { text: "user09" },
        back: { text: "Users" },
      });
      // The head's heading follows as well, for a sidebar that marks the page.
      expect(await page.locator(".k2b-app-workspace__head-heading").textContent()).toBe("user09");
      expect(await page.title()).toBe("user09");
      // A title alone renames the page and keeps the way up.
      await update({ title: "user09 (renamed)" });
      await settle(page);
      expect(await trail(page)).toMatchObject({ form: "back", title: { text: "user09 (renamed)" }, back: { text: "Users" } });
      await update(
        {
          breadcrumbs: [
            { title: "Accounts", href: "/app/accounts" },
            { title: "Users", href: "/app/accounts/users" },
            { title: "user09", href: "/app/accounts/users/user09" },
            { title: "Keys" },
          ],
        },
        "/app/accounts/users/user09/keys",
      );
      await settle(page);
      expect(await trail(page)).toMatchObject({ form: "path", crumbs: ["Users", "user09"], title: { text: "Keys" } });
      await update({ breadcrumbs: [{ title: "Accounts", href: "/app/accounts" }, { title: "Users" }] }, "/app/accounts/users");
      await settle(page);
      expect((await trail(page)).head?.display).toBe("none");
      // The array the server rendered, sent again: a link to the page itself is no level here either.
      await update({ breadcrumbs: [{ title: "Users", href: "/app/accounts/users" }, { title: "All users" }] });
      await settle(page);
      expect(await trail(page)).toMatchObject({ head: { display: "none" } });
    } finally {
      await context.close();
    }
  });
});

describe("going up returns to the page as this tab left it", () => {
  const scrollOf = (page: Page) =>
    page.evaluate(() => document.querySelector<HTMLElement>('[data-scroll-preserve="accounts-users"]')!.scrollTop);

  for (const device of [ipadLandscape, laptop]) {
    test(`${device.name}: the back link keeps filters and scroll and marks the row; a new tab gets the plain list`, async () => {
      const { context, page } = await open(device, "/app/accounts/users?group=sales");
      try {
        // A wide region whose content arrives a few frames after the page, as a table an island renders.
        await context.addInitScript(() => {
          addEventListener("DOMContentLoaded", () => {
            let frame = 0;
            const widen = () => {
              frame += 1;
              if (frame < 8) requestAnimationFrame(widen);
              else document.querySelector<HTMLElement>(".accounts-wide-content")?.style.setProperty("width", "3000px");
            };
            requestAnimationFrame(widen);
          });
        });
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('[data-scroll-preserve="accounts-users"]')!.scrollTop = 600;
          document.querySelector<HTMLElement>(".accounts-wide-content")!.style.width = "3000px";
          document.querySelector<HTMLElement>('[data-scroll-preserve="accounts-wide"]')!.scrollLeft = 450;
        });
        const scrolled = await scrollOf(page);
        expect(scrolled).toBeGreaterThan(0);
        // The detail is opened without the list's query in the trail, so only the tab's memory knows the filter.
        await page.evaluate(() => {
          window.location.assign("/app/accounts/users/user25");
        });
        await page.waitForURL(/user25$/);
        await settle(page);
        const back = page.locator(".k2b-page-title__up:visible");
        expect(await back.getAttribute("href")).toBe("/app/accounts/users");
        await back.click();
        await page.waitForURL(/\/app\/accounts\/users\?group=sales$/);
        await page.waitForFunction(() => document.querySelector("[data-page-trail-recent]"));
        expect(await scrollOf(page)).toBe(scrolled);
        expect(await page.locator("[data-page-trail-recent]").textContent()).toBe("user25");
        // Sideways too, once the content is wide enough again.
        await page.waitForFunction(() => document.querySelector<HTMLElement>(".accounts-wide-content")!.style.width === "3000px");
        await settle(page);
        expect(await page.evaluate(() => document.querySelector<HTMLElement>('[data-scroll-preserve="accounts-wide"]')!.scrollLeft)).toBe(
          450,
        );

        // Another tab has its own memory: the same link leads to the list itself.
        const other = await context.newPage();
        await other.goto(`${origin}/app/accounts/users/user25`);
        await settle(other);
        await other.locator(".k2b-page-title__up:visible").click();
        await other.waitForURL(/\/app\/accounts\/users$/);
        // The runtime marks the row in a later animation frame, once the list has rendered.
        await other.waitForFunction(() => document.querySelector("[data-page-trail-recent]"));
        expect(await other.locator("[data-page-trail-recent]").count()).toBe(1);
      } finally {
        await context.close();
      }
    });
  }

  test("Alt+↑ goes one level up outside text fields, and the shortcut help lists it only where there is a level above", async () => {
    for (const language of ["en", "de"] as const) {
      const { context, page } = await open(laptop, "/app/accounts/users?group=sales", { language });
      try {
        type Entry = { title: string; keys: string };
        const shortcuts = () => page.evaluate(() => (window as unknown as { shortcuts: () => Entry[] }).shortcuts());
        expect((await shortcuts()).some((entry) => entry.keys === "Alt+↑")).toBe(false);
        await page.locator("a", { hasText: "user03" }).click();
        await page.waitForURL(/user03/);
        await settle(page);
        expect(await shortcuts()).toContainEqual({
          title: language === "de" ? "Eine Ebene höher: Users" : "One level up: Users",
          keys: "Alt+↑",
        });

        // In a text field the keys belong to the field.
        await page.getByLabel("Note").focus();
        await page.keyboard.press("Alt+ArrowUp");
        await settle(page);
        expect(page.url()).toContain("user03");

        await page.locator("body").click({ position: { x: 600, y: 400 } });
        await page.keyboard.press("Alt+ArrowUp");
        await page.waitForURL(/\/app\/accounts\/users\?group=sales$/);
        await page.waitForFunction(() => document.querySelector("[data-page-trail-recent]"));
        expect(await page.locator("[data-page-trail-recent]").textContent()).toBe("user03");
      } finally {
        await context.close();
      }
    }
  });

  test("a widget that moves with Alt+↑, such as a tree item, keeps the keys", async () => {
    const { context, page } = await open(laptop, "/app/accounts/users/user03");
    try {
      await page.evaluate(() => {
        const item = document.createElement("div");
        item.id = "movable";
        item.tabIndex = 0;
        item.setAttribute("role", "treeitem");
        item.textContent = "Movable note";
        item.addEventListener("keydown", (event) => {
          if (!event.altKey || event.key !== "ArrowUp") return;
          event.preventDefault();
          item.dataset.moved = "up";
        });
        document.querySelector(".layout-content-main")!.append(item);
      });
      await page.locator("#movable").focus();
      await page.keyboard.press("Alt+ArrowUp");
      await settle(page);
      expect(page.url()).toContain("user03");
      expect(await page.locator("#movable").getAttribute("data-moved")).toBe("up");
    } finally {
      await context.close();
    }
  });

  test("from a document, the way up leads to its folder with the document's row, never back to the editor", async () => {
    const folder = `/app/files?path=${encodeURIComponent(folders[0]!)}`;
    const file = `${folders[0]}/plan.md`;
    const { context, page } = await open(laptop, folder);
    try {
      for (const how of ["link", "keys"] as const) {
        await page.evaluate((href) => window.location.assign(href), `${folder}&file=${encodeURIComponent(file)}&view=edit`);
        await page.waitForURL((url) => url.searchParams.get("view") === "edit");
        await settle(page);
        if (how === "link") await page.locator(".k2b-page-title__up:visible").click();
        else {
          await page.locator("body").click({ position: { x: 600, y: 400 } });
          await page.keyboard.press("Alt+ArrowUp");
        }
        await page.waitForURL((url) => url.searchParams.get("view") !== "edit", { timeout: 5_000 });
        const landed = new URL(page.url()).searchParams;
        expect({ how, path: landed.get("path"), file: landed.get("file") }).toEqual({ how, path: folders[0]!, file });
      }
    } finally {
      await context.close();
    }
  });
});

describe("workspace title beside exact-current navigation", () => {
  for (const device of [laptop, ipadPortrait, phone]) {
    test(`${device.name}: the marked page keeps one accessible title, stable main and working way up`, async () => {
      const { context, page } = await open(device, "/app/accounts/teams");
      try {
        // Without the title row, the head's heading names the page; the visible title row is no heading.
        const heading = page.getByRole("heading", { level: 1, name: "Teams", exact: true });
        expect(await heading.count()).toBe(device.width >= 1024 ? 1 : 0);
        expect(await page.getByRole("heading", { level: 1 }).count()).toBe(device.width >= 1024 ? 1 : 0);
        expect(await page.title()).toBe("Teams");
        const head = page.locator('.k2b-app-workspace__head[data-trail="up"]');
        if (device.width >= 1024) {
          const box = await head.boundingBox();
          expect(box!.width).toBeLessThanOrEqual(1);
          expect(box!.height).toBeLessThanOrEqual(1);
          expect(await head.locator(".k2b-page-title").evaluate((element) => getComputedStyle(element).display)).toBe("none");
          expect(await page.locator(".k2b-page-title__up:visible,.k2b-page-title__back:visible").count()).toBe(0);
        } else {
          expect(await head.locator(device.width < 768 ? ".k2b-page-title__back" : ".k2b-page-title__up").isVisible()).toBe(true);
        }
        const main = () => page.locator(".k2b-app-workspace__main").evaluate((element) => element.getBoundingClientRect().toJSON());
        const initial = await page.evaluate(() => (window as unknown as { initialMainRect: unknown }).initialMainRect);
        expect(await main()).toEqual(initial);
        await page.waitForTimeout(1000);
        expect(await main()).toEqual(initial);
        expect(await page.title()).toBe("Teams");
        await page.keyboard.press("Alt+ArrowUp");
        await page.waitForURL(/\/app\/accounts\/directory$/);
      } finally {
        await context.close();
      }
    });
  }
  test("a deeper page with an active ancestor keeps its desktop back link", async () => {
    const { context, page } = await open(laptop, "/app/accounts/teams/engineering");
    try {
      expect(await page.locator('.k2b-app-workspace__sidebar [aria-current="page"]').count()).toBe(0);
      const ancestor = page.locator('.k2b-app-workspace__sidebar [aria-current="true"]');
      expect(await ancestor.getAttribute("href")).toBe("/app/accounts/teams");
      expect(await ancestor.evaluate((element) => element.classList.contains("is-active"))).toBe(true);
      const back = page.locator(".k2b-app-workspace__head .k2b-page-title__up");
      expect(await back.isVisible()).toBe(true);
      expect(await back.getAttribute("href")).toBe("/app/accounts/teams");
      expect((await page.locator(".k2b-app-workspace__head").boundingBox())!.height).toBe(46);
    } finally {
      await context.close();
    }
  });
});
