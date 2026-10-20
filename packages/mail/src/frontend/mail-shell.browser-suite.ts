import { afterAll, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser, settled, storedCookie } from "../../../ui/test/browser";
import { mailTagSearch } from "../search-url";

setDefaultTimeout(20_000);

const cache = resolve(import.meta.dir, "../../node_modules/.cache");
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, "mail-shell-browser-"));
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const {
  default: Fixture,
  MAIL_SHELL_NOW,
  focusCounts,
  viewCounts,
  focusView,
  focusPage,
  mailboxData,
  mailboxList,
} = await import("./mail-shell.browser-fixture");
const ui = resolve(import.meta.dir, "../../../ui/dist");
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
const boxPath = "/app/mail/Box001";
const tabsSelector = ".k2b-app-workspace__head-views";
const sidebarSelector = ".mail-sidebar .k2b-app-workspace__sidebar-desktop";
const measurements = [
  ".mail-sidebar",
  ".k2b-app-workspace__head",
  tabsSelector,
  ".k2b-app-workspace__head-filters",
  ".k2b-app-workspace__head-actions",
  ".k2b-app-workspace__head-actions button",
  "[data-workspace-primary]",
  ".k2b-app-workspace__main",
  ".k2b-view-tabs__item",
  ".k2b-filter-chip",
  ".mail-sidebar-mailbox",
  ".mail-focus-row",
  ".mail-list-entry",
  ".k2b-app-workspace__main-pane",
  ".k2b-app-workspace__main-primary",
  ".mail-reader-toolbar",
  ".mail-reading-column",
  ".k2b-app-workspace__detail",
].join(",");
// Rows below the fold render lazily (content-visibility); only what the person sees must hold still.
const geometrySource = `() => Array.from(document.querySelectorAll(${JSON.stringify(measurements)})).map((e,i)=>{const r=e.getBoundingClientRect();const part=String(e.className).split(" ").filter(Boolean).join(" ");return r.bottom<=0||r.top>=innerHeight?{part,index:i,x:0,y:-1,width:0,height:0}:{part,index:i,x:r.x,y:r.y,width:r.width,height:r.height}})`;
type Frame = { part: string; index: number; x: number; y: number; width: number; height: number }[];
// The head's view strip as a person sees it: every rendered label at its full width, the current tab inside the strip.
const stripSource = `() => {const list=document.querySelector(${JSON.stringify(`${tabsSelector} .k2b-view-tabs__list`)});if(!list)return null;const b=list.getBoundingClientRect();const fade=list.getAttribute("data-scroll-fade");const current=list.querySelector('.k2b-view-tabs__tab[aria-current="page"]');const c=current&&current.getClientRects().length>0?current.getBoundingClientRect():null;return {overflow:list.scrollWidth-list.clientWidth,current:current?.getAttribute("href")??null,left:c?c.left-b.left:null,right:c?b.right-c.right:null,leftInset:fade==="top"||fade==="both"?parseFloat(getComputedStyle(list).scrollPaddingLeft)||0:0,rightInset:fade==="bottom"||fade==="both"?parseFloat(getComputedStyle(list).scrollPaddingRight)||0:0,labels:Array.from(list.querySelectorAll(".k2b-view-tabs__tab .k2b-view-tabs__label")).filter(l=>l.getClientRects().length>0).map(l=>({text:l.textContent,scroll:l.scrollWidth,width:l.clientWidth}))}}`;
type Strip = {
  overflow: number;
  current: string | null;
  left: number | null;
  right: number | null;
  leftInset: number;
  rightInset: number;
  labels: { text: string | null; scroll: number; width: number }[];
};
let css = "";
let controller = "";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const pageErrors = new WeakMap<Page, string[]>();
/**
 * `?shell=1` lays the page out like Cloud's signed-in shell from 1024 px: a 56 px rail, the card spacing, and the
 * window as the app host. `&panel=416` adds Cloud's panel column, which makes the app area beside it the host.
 * Without `shell`, the window is the app area and the workspace, as before.
 */
const shell = (url: URL, html: string) => {
  if (url.searchParams.get("shell") !== "1")
    return `<main style="container-type:inline-size;container-name:k2b-app-area;display:flex;flex-direction:column;height:100dvh">${html}</main>`;
  const panel = Number(url.searchParams.get("panel")) || 0;
  // A sidebar width the person stored, as Cloud's layout cookie restores it on the workspace.
  const sidebar = Number(url.searchParams.get("sidebar")) || 0;
  const stored = sidebar ? `<style>.k2b-app-workspace{--k2b-workspace-sidebar-width:${sidebar}px}</style>` : "";
  const inset = "round(clamp(0.25rem, calc(0.25rem + (100vw - 64rem) / 104), 0.5rem), 1px)";
  return `${stored}<div style="display:flex;box-sizing:border-box;height:100dvh;padding:${inset} ${inset} ${inset} 0"><div style="flex:none;width:3.5rem"></div><div data-fixture-app-area style="display:flex;flex:1;min-width:0;flex-direction:column;${panel ? "container:k2b-app-area / inline-size" : ""}"><main style="display:flex;flex:1;min-height:0;flex-direction:column">${html}</main></div>${panel ? `<aside data-fixture-panel style="flex:none;width:${panel}px;margin-inline-start:${inset}"></aside>` : ""}</div>`;
};
const pageHtml = (url: URL, cookieHeader: string | null = null) => {
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const locale = url.searchParams.get("locale") === "de" ? "de" : "en";
  const html = renderToString(() =>
    createComponent(Fixture, {
      source: `${url.pathname}${url.search}`,
      locale,
      theme,
      // This opt-in exercises the same request-cookie reader as Mail's SSR page
      // without putting an artificial preference into its navigation URL.
      workspaceCookieHeader: url.searchParams.has("persist-details") ? cookieHeader : undefined,
    }),
  );
  // As in Cloud, the page owns the one workspace controller (its body marker), so workspaces do not install their own.
  return `<!doctype html><html lang="${locale}" class="${theme}" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style><style>solid-client,solid-island{display:contents}</style><style>/* Like the Cloud shell on phones: the primary action is the round button beside the bottom bar, out of the head row. */@media not all and (min-width:48rem){.k2b-app-workspace__head-primary{position:fixed;z-index:11;right:12px;bottom:12px}}</style></head><body class="k2b-ui" data-theme="${theme}" data-k2b-app-workspace-controller="global" style="margin:0">${shell(url, html)}<script>${controller}</script><script type="module">
    const geometry=${geometrySource};
    const strip=${stripSource};
    const step=(name)=>{document.documentElement.dataset.mailShellStep=name};
    step('fonts');
    await document.fonts.ready;
    step('first frame');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    document.documentElement.dataset.serverGeometry=JSON.stringify(geometry());
    document.documentElement.dataset.serverStrip=JSON.stringify(strip());
    document.documentElement.dataset.serverCurrent=document.querySelector('${tabsSelector} [aria-current="page"]')?.getAttribute('href')??'';
    step('islands');
    await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));
    step('hydrated frame');
    // The first frame the browser paints after hydration, as a person sees it.
    await new Promise(resolve=>requestAnimationFrame(resolve));
    document.documentElement.dataset.hydratedGeometry=JSON.stringify(geometry());
    document.documentElement.dataset.hydratedStrip=JSON.stringify(strip());
    document.documentElement.dataset.mailShellReady='true';
    </script></body></html>`;
};

beforeAll(async () => {
  setSystemTime(new Date(MAIL_SHELL_NOW));
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Mail shell CSS failed");
  css = (await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))).join("\n");
  const entry = join(root, "controller.ts");
  const built = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import {installAppWorkspaceController} from ${JSON.stringify(join(ui, "browser/index.js"))};installAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!built.success) throw new AggregateError(built.logs, "Workspace controller failed");
  controller = await built.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, host) {
      const url = new URL(request.url);
      if (url.pathname === "/api/mail/live" && host.upgrade(request, { data: undefined })) return;
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname.endsWith("/workspace-route") || url.pathname.endsWith("/workspace-list")) {
        const target = new URL(url.searchParams.get("href") ?? boxPath, server.url);
        return Response.json(url.pathname.endsWith("/workspace-list") ? mailboxList(target) : mailboxData(target));
      }
      if (url.pathname === "/api/mail/overview/conversations") return Response.json(focusPage(focusView(url)));
      if (url.pathname.endsWith("/actions") && request.method === "POST") return Response.json({ commands: [] });
      if (url.pathname.endsWith("/preference") && request.method === "PATCH") return Response.json(await request.json());
      if (url.pathname.endsWith("/activity")) return Response.json({ items: [], nextCursor: null });
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Outside synthetic fixture" }, { status: 404 });
      return new Response(pageHtml(url, request.headers.get("cookie")), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message));
        if (frame.t === "sub") socket.send(JSON.stringify({ t: "ready", id: frame.id, cursor: "s6t.mail.4" }));
      },
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    setSystemTime();
    rmSync(root, { recursive: true, force: true });
  }
});
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: distance from the pinned fixture instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the fixture instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset;
    } // real clock: keeps native timers and performance
  }
  globalThis.Date = PinnedDate as DateConstructor;
};
const ready = async (page: Page) => {
  try {
    await page.waitForFunction(() => document.documentElement.dataset.mailShellReady === "true");
  } catch (error) {
    // Name the page script's step that never finished, so a stall points at fonts, the first frame or the islands.
    const step = await page
      .locator("html")
      .getAttribute("data-mail-shell-step", { timeout: 1000 })
      .catch(() => "unreadable");
    throw new Error(`Mail shell page never got ready (stopped at: ${step ?? "page script not started"})`, { cause: error });
  }
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll(".k2b-app-workspace__main")).some((main) => main.getAttribute("aria-busy") === "true"),
  );
  await settled(page);
};
const sizes = [
  [1920, 1080],
  [1440, 900],
  [1194, 834],
  [834, 1194],
  [390, 844],
] as const;
const open = async (path: string, width = 1440, height = sizes.find(([w]) => w === width)?.[1] ?? 900) => {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: width === 390,
    hasTouch: width === 390,
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  await context.addInitScript(pinPageClock, Date.parse(MAIL_SHELL_NOW));
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(new URL(path, server.url).href);
    await ready(page);
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
};
const close = async (page: Page) => {
  try {
    expect(pageErrors.get(page), "No page errors, including live connections").toEqual([]);
    expect(await page.locator(".k2b-moved-hint").count(), "Mail never renders a MovedHint").toBe(0);
  } finally {
    await page.context().close();
  }
};
const tabs = (page: Page) => page.locator(tabsSelector);
const sidebar = (page: Page) => page.locator(sidebarSelector);
const currentHref = (page: Page) => tabs(page).locator('a[aria-current="page"]').getAttribute("href");
const geometry = (page: Page): Promise<Frame> =>
  page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector)).map((e, index) => {
        const r = e.getBoundingClientRect();
        const part = String(e.className).split(" ").filter(Boolean).join(" ");
        // Rows below the fold render lazily (content-visibility); only what the person sees must hold still.
        if (r.bottom <= 0 || r.top >= innerHeight) return { part, index, x: 0, y: -1, width: 0, height: 0 };
        return { part, index, x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    measurements,
  );
const assertFrame = (before: Frame, after: Frame, label: string) => {
  expect(after.length, `${label}: measured part count`).toBe(before.length);
  for (const [index, actual] of after.entries()) {
    const original = before[index]!;
    expect(actual.part, label).toBe(original.part);
    for (const dimension of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(actual[dimension] - original[dimension]),
        `${label}: ${actual.part}[${index}].${dimension}: ${original[dimension]} → ${actual[dimension]}`,
      ).toBeLessThanOrEqual(0.5);
  }
};
const recordedFrame = async (page: Page, name: "server" | "hydrated"): Promise<Frame> => {
  const value = await page.locator("html").getAttribute(`data-${name}-geometry`);
  if (!value) throw new Error(`Missing ${name} geometry`);
  return JSON.parse(value);
};
const clickTab = async (page: Page, href: string) => {
  let link = tabs(page).locator(`a[href="${href}"]`);
  if (!(await link.isVisible())) {
    await tabs(page).getByRole("button", { name: /More/ }).click();
    link = page.locator(`[role="menuitem"][href="${href}"]`);
  }
  const response = page.waitForResponse(
    (response) => response.url().includes("/workspace-") || response.url().includes("/overview/conversations"),
  );
  await link.click();
  await response;
  await page.waitForURL(new URL(href, server.url).href);
  await page.waitForFunction(
    ({ selector, href }) => document.querySelector(`${selector} a[aria-current="page"]`)?.getAttribute("href") === href,
    { selector: tabsSelector, href },
  );
  await settled(page);
};

/** The shell tests. `screenshots` is a directory for optional synthetic review screenshots. */
export const defineMailShellTests = (screenshots: string | undefined) =>
  describe(`Mail SSR and hydration shell in ${browserName}`, () => {
    test("Focus and mailbox share the ordered navigation; switching mailbox takes one link", async () => {
      let label: string | null = null;
      let rows: string[] = [];
      for (const path of ["/app/mail", boxPath]) {
        const page = await open(path);
        try {
          // Focus stacks its sidebar as chips below 64 rem and is a nav landmark; a mailbox's sidebar is the same rows.
          const currentLabel = await page.locator(".mail-sidebar").getAttribute("aria-label");
          expect(currentLabel).toBe("Mailboxes");
          const ids = await sidebar(page)
            .locator('.mail-sidebar-mailbox:not([data-hidden="true"])')
            .evaluateAll((elements) => elements.map((e) => e.getAttribute("data-mailbox")!));
          expect(ids).toEqual(["Box002", "Box001", "Box003", "Box004"]);
          if (label) {
            expect(currentLabel).toBe(label);
            expect(ids).toEqual(rows);
          }
          label = currentLabel;
          rows = ids;
          expect(await sidebar(page).locator(`a[href="${path}"][aria-current="page"]`).count()).toBe(1);
          const groups = sidebar(page).getByRole("group", { name: /^Folders of / });
          expect(await groups.count()).toBe(path === boxPath ? 1 : 0);
          if (path === boxPath) expect(await groups.getAttribute("aria-label")).toBe("Folders of Example support");
          expect(await page.locator(".k2b-app-workspace__sidebar-switcher").count()).toBe(0);
          expect(await page.getByRole("button", { name: "Switch mailbox" }).count()).toBe(0);
          const other = sidebar(page).locator('[data-mailbox="Box002"] a').first();
          expect(await other.getAttribute("href")).toBe("/app/mail/Box002");
          expect(await other.evaluate((e) => e.tagName)).toBe("A");
          const countSlot = other.locator(".mail-sidebar-needs-action");
          expect(await countSlot.count()).toBe(1);
          expect(await countSlot.textContent()).toBe(path === boxPath ? "" : "4");
          expect(await other.locator(".mail-sidebar-unread-dot").count()).toBe(path === boxPath ? 0 : 1);
        } finally {
          await close(page);
        }
      }
    });

    for (const path of ["/app/mail", boxPath]) {
      test(`${path}: default first tab, exact fixture counts, no Paper`, async () => {
        const page = await open(path);
        try {
          const first = tabs(page).locator("a").first();
          expect(await first.getAttribute("href")).toBe(path);
          expect(await first.getAttribute("aria-current")).toBe("page");
          expect(await first.textContent()).toBe(path === boxPath ? "All" : `For me${focusCounts.mine}`);
          const entries =
            path === boxPath ? Object.entries(viewCounts).filter(([id]) => id !== "send_problems") : Object.entries(focusCounts);
          for (const [id, count] of entries) {
            const href = path === "/app/mail" && id === "mine" ? path : `${path}?view=${id}`;
            let link = tabs(page).locator(`a[href="${href}"]`);
            if (!(await link.count())) {
              await tabs(page).getByRole("button", { name: /More/ }).click();
              // Dropdown document links carry the menuitem role themselves.
              link = page.locator(`[role="menuitem"][href="${href}"]`);
              expect(await link.textContent()).toMatch(new RegExp(`${count}$`));
              await page.keyboard.press("Escape");
            } else expect(await link.textContent()).toMatch(new RegExp(`${count}$`));
          }
          expect(await page.locator(".k2b-app-workspace .k2b-paper").count()).toBe(0);
        } finally {
          await close(page);
        }
      });
    }

    const tag = mailTagSearch("Tag001");
    if (!tag.ok) throw new Error("Invalid synthetic tag ID");
    const routes = [
      { query: "view=needs_action", selected: `${boxPath}?view=needs_action` },
      { query: "view=snoozed", selected: `${boxPath}?view=snoozed` },
      { query: "folder=Filed1", selected: null },
      { query: "savedView=Saved1", selected: `${boxPath}?savedView=Saved1` },
      { query: new URLSearchParams({ search: tag.value }).toString(), selected: boxPath },
      { query: "scheduled=1", selected: null },
    ];
    for (const route of routes)
      test(`${route.query}: SSR, in-place switch, Back, Forward and reload keep URL state`, async () => {
        const start = `${boxPath}?${route.query}`;
        const page = await open(start);
        const assertRoute = async () => {
          expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(start);
          if (route.selected) expect(await currentHref(page)).toBe(route.selected);
          else expect(await tabs(page).locator("a").count()).toBe(0);
          if (route.query.startsWith("folder="))
            expect(await sidebar(page).locator('a[href$="folder=Filed1"]').getAttribute("aria-current")).toBe("page");
          if (route.query.startsWith("search=")) {
            const chip = page.locator(".k2b-app-workspace__head-filters .k2b-filter-chip");
            expect(await chip.textContent()).toContain("Tag");
            expect(await chip.textContent()).toContain("Priority");
          }
          if (route.query === "view=snoozed") {
            expect(await tabs(page).getByRole("button", { name: /More/ }).isVisible()).toBe(true);
            expect(await tabs(page).locator('a[aria-current="page"]').isVisible()).toBe(true);
          }
        };
        try {
          expect(await page.locator("html").getAttribute("data-server-current")).toBe(route.selected ?? "");
          await assertRoute();
          await page.reload();
          await ready(page);
          await assertRoute();
          // Places have no tabs; use the mailbox root link to get back to the strip first.
          if (!route.selected) {
            await sidebar(page).locator(`[data-mailbox="Box001"] a[href="${boxPath}"]`).click();
            await page.waitForURL(new URL(boxPath, server.url).href);
            await ready(page);
          }
          await clickTab(page, `${boxPath}?view=waiting`);
          expect(await currentHref(page)).toBe(`${boxPath}?view=waiting`);
          await page.goBack();
          await ready(page);
          if (!route.selected) {
            await page.goBack();
            await ready(page);
          }
          await assertRoute();
          await page.goForward();
          await ready(page);
          if (!route.selected) {
            await page.goForward();
            await ready(page);
          }
          expect(new URL(page.url()).search).toBe("?view=waiting");
          expect(await currentHref(page)).toBe(`${boxPath}?view=waiting`);
          await page.reload();
          await ready(page);
          expect(await currentHref(page)).toBe(`${boxPath}?view=waiting`);
        } finally {
          await close(page);
        }
      }, 30_000);

    test("Focus waiting URL survives in-place navigation and history", async () => {
      const page = await open("/app/mail?view=waiting");
      try {
        expect(await currentHref(page)).toBe("/app/mail?view=waiting");
        await clickTab(page, "/app/mail?view=unassigned");
        await page.goBack();
        await ready(page);
        expect(new URL(page.url()).search).toBe("?view=waiting");
        expect(await currentHref(page)).toBe("/app/mail?view=waiting");
        await page.goForward();
        await ready(page);
        expect(await currentHref(page)).toBe("/app/mail?view=unassigned");
        await page.reload();
        await ready(page);
        expect(await currentHref(page)).toBe("/app/mail?view=unassigned");
      } finally {
        await close(page);
      }
    });

    for (const permission of ["write", "read", "admin", "assigned-only"])
      test(`${permission}: head and sidebar share the authorized mailbox menu`, async () => {
        const page = await open(`${boxPath}?permission=${permission}`);
        try {
          const head = page.locator(".k2b-app-workspace__head-actions").getByRole("button", { name: "Options for Example support" });
          const row = sidebar(page).getByRole("button", { name: "Options for Example support" });
          // The open row's "…" also holds its own pin and hide, which need no mailbox-wide access. The fixture pins it.
          const rowOnly = ["Unpin Example support", "Hide Example support"];
          const expected =
            permission === "assigned-only"
              ? []
              : [
                  permission === "read" ? "About this mailbox" : "Mailbox details",
                  "Automations",
                  "Mailing lists",
                  "Remote images",
                  "Email link setup",
                  "Settings",
                  ...(permission === "admin" ? ["Sync mailbox", "Mailbox health", "Shared links"] : []),
                ];
          if (permission === "assigned-only") {
            expect(await head.count()).toBe(0);
            expect(await page.getByRole("link", { name: "Compose", exact: true }).count()).toBe(0);
          } else expect(await head.count()).toBe(1);
          expect(await row.count()).toBe(1);
          for (const [trigger, items] of [
            ...(permission === "assigned-only" ? [] : [[head, expected] as const]),
            [row, [...expected, ...rowOnly]] as const,
          ]) {
            await trigger.click();
            await page.getByRole("menu").waitFor();
            expect((await page.getByRole("menuitem").allTextContents()).map((text) => text.trim()).sort()).toEqual([...items].sort());
            await page.keyboard.press("Escape");
            await page.getByRole("menu").waitFor({ state: "hidden" });
          }
        } finally {
          await close(page);
        }
      });

    test("dragging a list row to a custom folder submits its move; unread counts and More persist", async () => {
      const page = await open(boxPath);
      try {
        const destination = sidebar(page).locator('a[href$="folder=Filed1"]');
        expect(await destination.textContent()).toContain("7 unread");
        const action = page.waitForRequest(
          (request) => request.method() === "POST" && request.url().endsWith("/conversations/Conv01/actions"),
        );
        await page.locator('[data-conversation-id="Conv01"] [draggable="true"]').dragTo(destination);
        const request = await action;
        expect(request.postDataJSON()).toMatchObject({ kind: "move_to_folder", sourceFolderId: "Inbox1", destinationFolderId: "Filed1" });
        await sidebar(page).getByRole("button", { name: "More", exact: true }).click();
        for (const id of ["Archive1", "Trash1", "Junk1"])
          expect(await sidebar(page).locator(`a[href$="folder=${id}"]`).isVisible()).toBe(true);
        await sidebar(page).locator('a[href$="folder=Archive1"]').click();
        await page.waitForURL(new URL(`${boxPath}?folder=Archive1`, server.url).href);
        await settled(page);
        await sidebar(page).getByRole("button", { name: "More", exact: true }).click();
        expect(await sidebar(page).locator('a[href$="folder=Archive1"]').isVisible()).toBe(true);
        await page.reload();
        await ready(page);
        expect(await sidebar(page).locator('a[href$="folder=Archive1"]').getAttribute("aria-current")).toBe("page");
        expect(await sidebar(page).locator('a[href$="folder=Junk1"]').isVisible()).toBe(true);
      } finally {
        await close(page);
      }
    }, 30_000);

    test("hidden mailboxes have a link and a working Show action", async () => {
      const page = await open(boxPath);
      try {
        const section = sidebar(page).locator(".mail-sidebar-hidden-mailboxes");
        await section.getByRole("button", { name: /Hidden mailboxes/ }).click();
        const hidden = section.locator('[data-mailbox="Box005"]');
        expect(await hidden.locator("a").getAttribute("href")).toBe("/app/mail/Box005");
        const saved = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith("/Box005/preference"));
        await hidden.hover();
        await hidden.getByRole("button", { name: /Show/ }).click();
        expect((await saved).postDataJSON()).toEqual({ hidden: false });
        await sidebar(page).locator('[data-mailbox="Box005"]:not([data-hidden="true"])').waitFor();
      } finally {
        await close(page);
      }
    });

    for (const path of ["/app/mail", boxPath]) {
      test(`${path}: sidebar resizes with pointer and ArrowLeft/ArrowRight/Home`, async () => {
        const page = await open(path);
        try {
          const handle = page.getByRole("separator", { name: "Resize navigation", exact: true });
          const before = Number(await handle.getAttribute("aria-valuenow"));
          const box = await handle.boundingBox();
          if (!box) throw new Error("Missing navigation resize handle");
          await page.mouse.move(box.x + box.width / 2, box.y + 60);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + 48, box.y + 60, { steps: 5 });
          await page.mouse.up();
          await page.waitForFunction(
            (before) => Number(document.querySelector('[data-app-workspace-resize="sidebar"]')?.getAttribute("aria-valuenow")) > before,
            before,
          );
          await settled(page);
          expect((await page.locator(".mail-sidebar").boundingBox())!.width).toBeGreaterThan(before);
          for (const key of ["ArrowLeft", "ArrowRight", "Home"]) {
            const previous = Number(await handle.getAttribute("aria-valuenow"));
            await handle.focus();
            await page.keyboard.press(key);
            await page.waitForFunction(
              ({ key, previous }) => {
                const handle = document.querySelector('[data-app-workspace-resize="sidebar"]')!;
                const value = Number(handle.getAttribute("aria-valuenow"));
                return key === "Home"
                  ? value === Number(handle.getAttribute("aria-valuemin"))
                  : key === "ArrowLeft"
                    ? value < previous
                    : value > previous;
              },
              { key, previous },
            );
            await settled(page);
            expect((await page.locator(".mail-sidebar").boundingBox())!.width).toBeCloseTo(
              Number(await handle.getAttribute("aria-valuenow")),
              0,
            );
          }
        } finally {
          await close(page);
        }
      });
      test(`${path}: phone tabs are the card's first row`, async () => {
        const page = await open(path, 390);
        try {
          const views = await tabs(page).boundingBox();
          const workspace = await page.locator(".k2b-app-workspace").boundingBox();
          expect(views).not.toBeNull();
          expect(workspace).not.toBeNull();
          if (!views || !workspace) throw new Error("Missing phone frame");
          const filters =
            (await page.locator(".k2b-app-workspace__head-filters").count()) > 0
              ? await page.locator(".k2b-app-workspace__head-filters").boundingBox()
              : null;
          if (filters) expect(views.y + views.height).toBeLessThanOrEqual(filters.y + 0.5);
          const rows = await page.locator(".mail-focus-row,.mail-list-entry").first().boundingBox();
          expect(views.y + views.height).toBeLessThanOrEqual(rows!.y);
          if (path === "/app/mail") {
            expect(await page.locator('.mail-sidebar[data-mobile="stacked"]').count()).toBe(1);
            const chip = await page.locator('.mail-sidebar [data-mailbox="Box002"] a:visible').first().boundingBox();
            expect(chip).not.toBeNull();
            // The shared workspace puts the head first on phones: the tabs are the card's top row, the chips follow.
            expect(chip!.y).toBeGreaterThanOrEqual(views.y + views.height);
          }
          const firstRowY = await page.locator(".k2b-app-workspace__head").evaluate((head) => {
            const style = getComputedStyle(head);
            return head.getBoundingClientRect().y + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.borderTopWidth);
          });
          // The tabs share the head's first row with the actions, which may be taller and center the row.
          expect(views.y - firstRowY, "Tabs occupy the head's first content row").toBeLessThan(8);
        } finally {
          await close(page);
        }
      });
      test(`${path}: selecting a tab moves no neighboring tab, chip or head action`, async () => {
        const page = await open(path);
        try {
          const neighbors = page.locator(
            `${tabsSelector} [data-view-tab],.k2b-app-workspace__head-filters,.k2b-filter-chip,.k2b-app-workspace__head-actions,.k2b-app-workspace__head-actions button,[data-workspace-primary]`,
          );
          const boxes = () =>
            neighbors.evaluateAll((elements) =>
              elements.map((e) => {
                const r = e.getBoundingClientRect();
                return { part: e.getAttribute("data-view-tab") ?? e.className, x: r.x, y: r.y, width: r.width, height: r.height };
              }),
            );
          const before = await boxes();
          expect(before.length).toBeGreaterThan(3);
          await clickTab(page, `${path}?view=waiting`);
          await settled(page);
          expect(await boxes()).toEqual(before);
        } finally {
          await close(page);
        }
      });
    }

    for (const locale of ["en", "de"] as const)
      test(`390 ${locale}: Focus and mailbox tabs keep full labels, and the current tab is in the strip before and after hydration`, async () => {
        for (const path of ["/app/mail", "/app/mail?view=all", boxPath, `${boxPath}?view=snoozed`]) {
          const page = await open(`${path}${path.includes("?") ? "&" : "?"}locale=${locale}`, 390);
          try {
            for (const name of ["server", "hydrated", "settled"] as const) {
              const label = `${path} ${locale} ${name}`;
              const strip: Strip | null =
                name === "settled"
                  ? await page.evaluate(`(${stripSource})()`)
                  : JSON.parse((await page.locator("html").getAttribute(`data-${name}-strip`)) ?? "null");
              if (!strip) throw new Error(`${label}: missing view strip`);
              expect(strip.labels.length, `${label}: visible tab labels`).toBeGreaterThanOrEqual(3);
              for (const tab of strip.labels) expect(tab.scroll, `${label}: "${tab.text}" is clipped`).toBeLessThanOrEqual(tab.width);
              expect(strip.current, label).toBe(path);
              expect(strip.left, `${label}: current tab's left edge`).toBeGreaterThanOrEqual(strip.leftInset - 0.5);
              expect(strip.right, `${label}: current tab's right edge`).toBeGreaterThanOrEqual(strip.rightInset - 0.5);
            }
          } finally {
            await close(page);
          }
        }
      }, 60_000);

    for (const width of [1440, 834, 390] as const)
      test(`${width}: a folder is named where the person sees it`, async () => {
        const page = await open(`${boxPath}?folder=Filed1`, width);
        try {
          const heading = page.locator("[data-mail-list-heading]");
          expect(await heading.textContent()).toBe("Filed");
          const box = await heading.boundingBox();
          if (width === 1440) {
            // Beside the sidebar its marked row names the folder; the heading stays for assistive technology.
            expect(await sidebar(page).locator('a[href$="folder=Filed1"]').getAttribute("aria-current")).toBe("page");
            expect(box?.width ?? 0).toBeLessThanOrEqual(1);
          } else {
            // Below 64 rem the sidebar is out of view and folders have no tab: the list heading names the folder.
            expect(await sidebar(page).isVisible()).toBe(false);
            expect(box?.width ?? 0).toBeGreaterThan(20);
            expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
          }
        } finally {
          await close(page);
        }
      });

    test("1440: a folder is named where the person sees it even without a sidebar row", async () => {
      const page = await open(`${boxPath}?folder=Quiet1`, 1440);
      try {
        expect(await sidebar(page).locator('a[href$="folder=Quiet1"]').count()).toBe(0);
        const heading = page.locator("[data-mail-list-heading]");
        expect(await heading.textContent()).toBe("Quiet");
        expect((await heading.boundingBox())?.width ?? 0).toBeGreaterThan(20);
        expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      } finally {
        await close(page);
      }
    });

    test("1440: collapsing the open folder's parent leaves its name in the list heading", async () => {
      const page = await open(`${boxPath}?folder=Child1`, 1440);
      try {
        const heading = page.locator("[data-mail-list-heading]");
        const childRow = sidebar(page).locator('a[href$="folder=Child1"]');
        const toggle = sidebar(page).locator(
          '[role="treeitem"][data-k2b-nav-tree-id="Filed1"] > .k2b-app-workspace__nav-tree-row [data-k2b-nav-tree-toggle]',
        );
        await settled(page);
        expect(await childRow.count()).toBe(1);
        expect((await heading.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

        await toggle.click();
        await settled(page);
        expect(await childRow.count()).toBe(0);
        expect(await heading.textContent()).toBe("Nested");
        expect((await heading.boundingBox())?.width ?? 0).toBeGreaterThan(20);

        await toggle.click();
        await settled(page);
        expect(await childRow.count()).toBe(1);
        expect((await heading.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
      } finally {
        await close(page);
      }
    });

    test("the open mailbox's name stays readable beside its row actions at the default width", async () => {
      const page = await open(boxPath);
      try {
        const row = sidebar(page).locator('.mail-sidebar-mailbox[data-mailbox="Box001"]');
        // The open row shows its actions without hover; only "…" stays there, with pin and hide inside it.
        // The menu renders inside the actions; its items are not row buttons.
        const buttons = row.locator('.k2b-app-workspace__sidebar-item-actions button:not([role="menuitem"])');
        expect(await buttons.count()).toBe(1);
        expect(await buttons.getAttribute("aria-label")).toBe("Options for Example support");
        const fit = await row.evaluate((element) => {
          const label = element.querySelector(".k2b-app-workspace__sidebar-item-label")!;
          const range = document.createRange();
          range.selectNodeContents(label);
          // The leftmost row action: the name may run into its padding, where the label fades, but not past its middle.
          const actions = Array.from(
            element.querySelectorAll('.k2b-app-workspace__sidebar-item-actions button:not([role="menuitem"])'),
            (button) => button.getBoundingClientRect(),
          ).filter((box) => box.width > 0);
          const first = actions.reduce((left, box) => (box.x < left.x ? box : left));
          return { textEnd: range.getBoundingClientRect().right, actionMiddle: first.x + first.width / 2 };
        });
        expect(fit.textEnd).toBeLessThanOrEqual(fit.actionMiddle);
      } finally {
        await close(page);
      }
    });

    // Each URL opens in its own page (testing.md: an in-place goto can stall in WebKit, #1367); reload is the subject.
    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of sizes)
        test(`${theme} ${width}x${height}: server = hydrated = settled = reload within 0.5px`, async () => {
          const differences: string[] = [];
          for (const path of ["/app/mail", boxPath]) {
            const page = await open(`${path}?theme=${theme}`, width, height);
            try {
              const serverFrame = await recordedFrame(page, "server");
              expect(serverFrame.some((part) => part.part.includes("head"))).toBe(true);
              expect(
                serverFrame.filter((part) => part.part.includes("mail-focus-row") || part.part.includes("mail-list-entry")).length,
              ).toBeGreaterThan(0);
              const compare = async (label: string, expected: Frame, actual: Frame) => {
                try {
                  assertFrame(expected, actual, `${path} ${label}`);
                } catch (error) {
                  differences.push(String(error));
                }
              };
              // Rows keep their height in the first hydrated frame too (#1545).
              await compare("hydrated", serverFrame, await recordedFrame(page, "hydrated"));
              await compare("settled", serverFrame, await geometry(page));
              await page.reload();
              await ready(page);
              await compare("reload SSR", serverFrame, await recordedFrame(page, "server"));
              await compare("reload hydrated", serverFrame, await recordedFrame(page, "hydrated"));
              await compare("reload settled", serverFrame, await geometry(page));
            } finally {
              await close(page);
            }
          }
          expect(differences).toEqual([]);
        }, 30_000);

    test("German locale uses the same hydrated sidebar and head", async () => {
      for (const path of ["/app/mail", boxPath]) {
        const page = await open(`${path}?locale=de`);
        try {
          expect(await page.locator("html").getAttribute("lang")).toBe("de");
          expect(await tabs(page).locator('a[aria-current="page"]').textContent()).toBe(
            path === boxPath ? "Alle" : `Für mich${focusCounts.mine}`,
          );
          expect(await page.locator(".mail-sidebar").getAttribute("aria-label")).toBe("Postfächer");
        } finally {
          await close(page);
        }
      }
    });

    describe("Mail wide windows", () => {
      /** Cloud's card with the mockup's 240 px sidebar, a conversation open and its details on. */
      const widePath = (options: { panel?: number; path?: string; extra?: string } = {}) =>
        `${options.path ?? `${boxPath}?conversation=Conv01&details=1`}${(options.path ?? "?").includes("?") ? "&" : "?"}shell=1&sidebar=240${options.panel ? `&panel=${options.panel}` : ""}${options.extra ?? ""}`;
      type Box = { x: number; y: number; width: number; height: number };
      type Wide = {
        list: number;
        pane: Box | null;
        reader: Box | null;
        column: Box | null;
        toolbar: Box | null;
        sidebar: Box | null;
        head: Box | null;
        detail: "column" | "waiting" | "drawer" | "closed";
        detailWidth: number;
        headDetails: boolean;
      };
      const wide = (page: Page): Promise<Wide> =>
        page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element || element.getClientRects().length === 0) return null;
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const aside = document.querySelector<HTMLElement>(".mail-workspace .k2b-app-workspace__detail");
          const toggle = document.querySelector<HTMLElement>(".mail-workspace .k2b-app-workspace__detail-toggle");
          const pane = box(".mail-workspace .k2b-app-workspace__main-pane");
          return {
            // The list pane holds the list and the shared 12 px gap to the reader.
            list: pane ? pane.width - 12 : 0,
            pane,
            reader: box(".mail-workspace .k2b-app-workspace__main-primary"),
            column: box(".mail-reading-column"),
            toolbar: box(".mail-reader-toolbar"),
            sidebar: box(".mail-workspace .k2b-app-workspace__sidebar"),
            head: box(".mail-workspace .k2b-app-workspace__head"),
            detail:
              !aside || aside.hidden
                ? "closed"
                : getComputedStyle(aside).display === "none"
                  ? "waiting"
                  : aside.dataset.workspaceDetailDrawer === "open"
                    ? "drawer"
                    : "column",
            detailWidth: aside?.getBoundingClientRect().width ?? 0,
            headDetails: Boolean(toggle && getComputedStyle(toggle).display !== "none"),
          };
        });
      const sameBox = (actual: Box | null, expected: Box | null, label: string) => {
        expect(Boolean(actual), label).toBe(Boolean(expected));
        if (!actual || !expected) return;
        for (const key of ["x", "y", "width", "height"] as const)
          expect(Math.abs(actual[key] - expected[key]), `${label}.${key}: ${expected[key]} → ${actual[key]}`).toBeLessThanOrEqual(0.5);
      };
      // Where the shared frame differs from the mockup's: a Detail column keeps an 8 px inset and the card a 1 px edge,
      // while the list's gap to the reader is 12 px instead of 16 px, so a reader beside a column is 6 px narrower.
      const COLUMN_EDGES = 6;
      const table = [
        { width: 1440, height: 900, panel: 0, list: 320, reader: 800, detail: "waiting" },
        // The mockup drew the sidebar as a column in a 952 px card. Below a 64 rem host the shared sidebar is the
        // overlay (#1380), so the reader also gets the 240 px: 952 - 2 - 332.
        { width: 1440, height: 900, panel: 416, list: 320, reader: 618, detail: "waiting" },
        { width: 1920, height: 1080, panel: 0, list: 440, reader: 680 - COLUMN_EDGES, detail: "column" },
        { width: 1920, height: 1080, panel: 416, list: 334, reader: 842, detail: "waiting" },
        { width: 2560, height: 1080, panel: 0, list: 440, reader: 1320 - COLUMN_EDGES, detail: "column" },
        { width: 2560, height: 1080, panel: 416, list: 440, reader: 896 - COLUMN_EDGES, detail: "column" },
      ] as const;

      test("F2: list, reader, reading column and Detail follow the 1920/2560 table, server = hydrated = settled", async () => {
        const failures: string[] = [];
        for (const row of table) {
          const label = `${row.width}${row.panel ? ` with a ${row.panel} px panel` : ""}`;
          const page = await open(widePath({ panel: row.panel }), row.width, row.height as 900);
          try {
            const frame = await wide(page);
            try {
              expect(Math.abs(frame.list - row.list), `${label}: list ${frame.list}`).toBeLessThanOrEqual(4);
              expect(Math.abs(frame.reader!.width - row.reader), `${label}: reader ${frame.reader!.width}`).toBeLessThanOrEqual(4);
              expect(frame.detail, `${label}: Detail`).toBe(row.detail);
              expect(frame.headDetails, `${label}: head Details`).toBe(true);
              if (row.detail === "column") expect(Math.abs(frame.detailWidth - 480), `${label}: Detail width`).toBeLessThanOrEqual(0.5);
              // At most 760 px, centred in the reader; the toolbar stays as wide as the reader.
              expect(frame.column!.width, `${label}: reading column`).toBeLessThanOrEqual(760.5);
              const readerCentre = frame.reader!.x + frame.reader!.width / 2;
              expect(Math.abs(frame.column!.x + frame.column!.width / 2 - readerCentre), `${label}: column centre`).toBeLessThanOrEqual(1);
              sameBox({ ...frame.toolbar!, y: 0, height: 0 }, { ...frame.reader!, y: 0, height: 0 }, `${label}: toolbar`);
              // Opening the conversation marks it read after hydration; that changes no geometry.
              const read = (parts: Frame) => parts.map((part) => ({ ...part, part: part.part.replace(" mail-list-entry-unread", "") }));
              const server = read(await recordedFrame(page, "server"));
              assertFrame(server, read(await recordedFrame(page, "hydrated")), `${label} hydrated`);
              assertFrame(server, read(await geometry(page)), `${label} settled`);
            } catch (error) {
              failures.push(String(error));
            }
          } finally {
            await close(page);
          }
        }
        expect(failures).toEqual([]);
      }, 120_000);

      test("F2: inside the band where the list grows, a 1520 px card keeps the Detail waiting", async () => {
        // A fixed 776 px minimum (320 + 16 + 440) would make a column here, with a reader below 440 px.
        const page = await open(widePath(), 1584, 900);
        try {
          const frame = await wide(page);
          expect(Math.abs(frame.list - (1520 * 0.25 - 24))).toBeLessThanOrEqual(0.5);
          expect(frame.detail).toBe("waiting");
          expect(frame.headDetails).toBe(true);
        } finally {
          await close(page);
        }
      });

      for (const [width, height, detail] of [
        [1440, 900, "column"],
        [1194, 834, "waiting"],
      ] as const)
        test(`F2: at ${width}, Hide list makes the Detail a ${detail === "column" ? "column" : "Detail that still waits"}`, async () => {
          const page = await open(widePath(), width, height);
          try {
            expect((await wide(page)).detail).toBe("waiting");
            await page.getByRole("button", { name: "Hide conversation list" }).click();
            await settled(page);
            const frame = await wide(page);
            expect(frame.pane).toBeNull();
            expect(frame.detail).toBe(detail);
            if (detail === "column") expect(frame.reader!.width).toBeGreaterThanOrEqual(440);
          } finally {
            await close(page);
          }
        });

      for (const [width, height, path] of [
        [1194, 834, widePath({ path: "/app/mail" })],
        [834, 1194, "/app/mail"],
      ] as const)
        test(`Fokus at ${width}: a conversation opens the 480 px drawer, Escape parks it and focus returns`, async () => {
          const page = await open(path, width, height);
          try {
            const aside = page.locator(".mail-focus-workspace .k2b-app-workspace__detail");
            await page.locator(".mail-focus-row").first().click();
            await page.waitForFunction(
              () =>
                document.querySelector<HTMLElement>(".mail-focus-workspace .k2b-app-workspace__detail")?.dataset.workspaceDetailDrawer ===
                "open",
            );
            await settled(page);
            expect(Math.abs((await aside.boundingBox())!.width - 480)).toBeLessThanOrEqual(0.5);
            await page.keyboard.press("Escape");
            await settled(page);
            expect(await aside.evaluate((element) => getComputedStyle(element).display)).toBe("none");
            expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-app-workspace__detail-toggle"))).toBe(true);
          } finally {
            await close(page);
          }
        });

      test("reader toolbar: labels from 720 px, icons below, and Reply all and Forward move into … below 520 px", async () => {
        const cases = [
          { path: widePath(), width: 2560, height: 1080, labels: true, shown: true },
          { path: widePath(), width: 1920, height: 1080, labels: false, shown: true },
          { path: `${boxPath}?conversation=Conv01`, width: 834, height: 1194, labels: false, shown: false },
        ] as const;
        for (const item of cases) {
          const page = await open(item.path, item.width, item.height);
          try {
            const label = `${item.width}`;
            for (const id of ["reply_all", "forward"]) {
              const button = page.locator(`.mail-reader-toolbar [data-mail-toolbar-action="${id}"]`);
              const readerWidth = await page.locator(".mail-reader").evaluate((element) => element.getBoundingClientRect().width);
              expect(await button.isVisible(), `${label}: ${id} shown (reader ${readerWidth})`).toBe(item.shown);
              if (item.shown)
                expect(await button.locator(".mail-reader-respond-label").isVisible(), `${label}: ${id} label`).toBe(item.labels);
            }
            expect(await page.locator(".mail-reader-toolbar [data-mail-details-trigger]").isVisible(), `${label}: Details`).toBe(true);
            // Nothing in the bar spills out of the reader.
            const bar = await page.locator(".mail-reader-toolbar").evaluate((element) => element.scrollWidth - element.clientWidth);
            expect(bar, `${label}: toolbar overflow`).toBeLessThanOrEqual(0);
            if (!item.shown) {
              const more = page.getByRole("button", { name: "More conversation actions" });
              await more.focus();
              await page.keyboard.press("Enter");
              for (const name of ["Reply all", "Forward"])
                expect(await page.getByRole("menuitem", { name }).count(), `${label}: ${name} in …`).toBe(1);
              await page.keyboard.press("Escape");
            }
          } finally {
            await close(page);
          }
        }
      }, 60_000);

      test("reader toolbar: the largest own toolbar fits every reader width, in English and German", async () => {
        // Eight actions is the most a person can choose: all three answers plus five icons, or Reply plus seven.
        const misfits: string[] = [];
        const readers: number[] = [];
        for (const toolbar of ["reply,reply_all,forward,archive,spam,trash,move,read", "reply,archive,spam,trash,move,read,flag,tags"])
          for (const locale of ["en", "de"] as const) {
            for (const [extra, widths] of [
              ["", [768, 800, 834, 900, 980, 1024, 1100, 1194, 1280, 1366, 1440]],
              ["&list=hidden", [834, 900]],
              ["&shell=1&sidebar=240&panel=416", [1024, 1100, 1194, 1280, 1366]],
              ["&list=hidden&shell=1&sidebar=240&panel=416", [900, 924, 960, 1024, 1100, 1194]],
            ] as const) {
              // One page per case, resized through its widths.
              const page = await open(`${boxPath}?conversation=Conv01&toolbar=${toolbar}&locale=${locale}${extra}`, widths[0], 900);
              try {
                for (const width of widths) {
                  await page.setViewportSize({ width, height: 900 });
                  await settled(page);
                  const result = await page.evaluate(() => {
                    const reader = document.querySelector(".mail-reader")!.getBoundingClientRect();
                    const bar = document.querySelector(".mail-reader-toolbar")!;
                    const outside = [...bar.querySelectorAll<HTMLElement>("button, a")]
                      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
                      .filter((element) => {
                        const box = element.getBoundingClientRect();
                        return box.left < reader.left - 0.5 || box.right > reader.right + 0.5;
                      })
                      .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "?");
                    const details = bar.querySelector<HTMLElement>("[data-mail-details-trigger]")!.getClientRects().length > 0;
                    return { reader: Math.round(reader.width), outside, details };
                  });
                  readers.push(result.reader);
                  if (result.outside.length || !result.details)
                    misfits.push(
                      `${toolbar} ${locale} ${width}${extra} (reader ${result.reader}): ${result.outside.join(", ") || "no Details"}`,
                    );
                }
              } finally {
                await close(page);
              }
            }
          }
        expect(misfits).toEqual([]);
        // The sweep covers every tier: under 380, 380–440, 440–480, 480–520, 520–720 and from 720 px of reader.
        for (const [from, to] of [
          [0, 380],
          [380, 440],
          [440, 480],
          [480, 520],
          [520, 720],
          [720, 2000],
        ] as const)
          expect(
            readers.some((width) => width >= from && width < to),
            `a reader width in ${from}–${to} (${[...new Set(readers)].join(", ")})`,
          ).toBe(true);
      }, 90_000);

      test("reader toolbar: a person's own actions stay, and those that do not fit are in …", async () => {
        const toolbar = "reply,forward,archive,trash,move,read,flag,tags";
        const page = await open(`${boxPath}?conversation=Conv01&toolbar=${toolbar}`, 834, 1194);
        try {
          expect(await page.locator('.mail-reader-toolbar [data-mail-toolbar-action="reply_all"]').count()).toBe(0);
          const visible = await page
            .locator(".mail-reader-toolbar [data-mail-toolbar-action]")
            .evaluateAll((elements) =>
              elements
                .filter((element) => element.getClientRects().length > 0)
                .map((element) => element.getAttribute("data-mail-toolbar-action")),
            );
          expect(visible[0]).toBe("reply");
          expect(visible.every((id) => toolbar.split(",").includes(id!))).toBe(true);
          expect(
            await page.locator(".mail-reader-toolbar").evaluate((element) => element.scrollWidth - element.clientWidth),
          ).toBeLessThanOrEqual(0);
          await page.getByRole("button", { name: "More conversation actions" }).click();
          for (const name of ["Forward", "Move to folder", "Tags"])
            expect(await page.getByRole("menuitem", { name, exact: true }).count(), `${name} in …`).toBeGreaterThan(0);
        } finally {
          await close(page);
        }
      });

      for (const width of [1920, 1440, 834]) {
        test(`persistent Details: default, close, resize and reload at ${width}`, async () => {
          const page = await open(`${boxPath}?conversation=Conv01&shell=1&persist-details=1`, width, 900);
          try {
            const button = page.locator("[data-app-workspace-detail-toggle]");
            const aside = page.locator(".k2b-app-workspace__detail");
            expect(await button.isVisible()).toBe(true);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            await button.focus();
            await page.keyboard.press("Enter");
            await settled(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            expect(await button.getAttribute("aria-expanded")).toBe("true");
            if (width === 1920) {
              // Pointer focus stays on a persistent control even when a resize
              // leaves the Detail in its column instead of hiding that control.
              await button.click();
              await button.click();
              await page.setViewportSize({ width: 1900, height: 900 });
              await settled(page);
              expect(await button.getAttribute("aria-expanded")).toBe("true");
              expect(await page.evaluate(() => document.activeElement?.matches("[data-app-workspace-detail-toggle]"))).toBe(true);
            }
            // Wide Mail deliberately puts its X in the reader; Escape closes its column.
            if (width >= 1024) await page.keyboard.press("Escape");
            else await aside.getByRole("button", { name: "Close conversation details", exact: true }).click();
            await settled(page);
            expect(await button.isVisible()).toBe(true);
            expect(await button.getAttribute("aria-expanded")).toBe("false");
            expect(await page.evaluate(() => document.activeElement?.matches("[data-app-workspace-detail-toggle]"))).toBe(true);
            await page.setViewportSize({ width: width === 1920 ? 834 : 1920, height: 900 });
            await settled(page);
            expect(await button.isVisible()).toBe(true);
            // Parking retained the available app detail; widening restores its column.
            if (width === 1440) {
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              await button.click();
              await settled(page);
              expect(await aside.getAttribute("hidden")).not.toBeNull();
            }
            await button.click();
            await settled(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            expect(await page.evaluate(() => document.activeElement?.matches("[data-app-workspace-detail-toggle]"))).toBe(true);
            // Persist application visibility closed, then reload the same conversation.
            if (width === 1920) await aside.getByRole("button", { name: "Close conversation details", exact: true }).click();
            else await page.keyboard.press("Escape");
            await page.waitForFunction(() => {
              const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
              return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === false;
            });
            await page.reload();
            await page.locator("html[data-mail-shell-ready=true]").waitFor();
            expect(await button.isVisible()).toBe(true);
            expect(await button.isEnabled()).toBe(true);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            await button.click();
            await settled(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            await page.waitForFunction(() => {
              const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
              return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === true;
            });
            await page.reload();
            await ready(page);
            // An initially open waiting drawer parks; the app preference still
            // restores true, while responsive presentation remains separate.
            expect(await aside.getAttribute("hidden")).toBeNull();
            if (width === 1920) {
              expect(await button.getAttribute("aria-expanded")).toBe("false");
              await button.click();
              await settled(page);
            }
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
          } finally {
            await close(page);
          }
        }, 30_000); // Several reloads include font/island readiness in both engines.
      }
      for (const theme of ["light", "dark"]) {
        test(`phone pane head: reader Details, persistence and Back in ${theme}`, async () => {
          const page = await open(`${boxPath}?conversation=Conv01&persist-details=1&theme=${theme}`, 390, 844);
          try {
            const head = page.locator(".mail-workspace > .k2b-app-workspace__head");
            const shared = page.locator(".mail-workspace [data-app-workspace-detail-toggle]");
            const reader = page.locator(".mail-reader-toolbar [data-mail-details-trigger]");
            const aside = page.locator(".k2b-app-workspace__detail");
            expect(await head.isVisible()).toBe(false);
            expect(await shared.isVisible()).toBe(false);
            const serverFrame: Frame = JSON.parse((await page.locator("html").getAttribute("data-server-geometry"))!);
            const hydratedFrame: Frame = JSON.parse((await page.locator("html").getAttribute("data-hydrated-geometry"))!);
            for (const frame of [serverFrame, hydratedFrame])
              expect(frame.find((part) => part.part === "k2b-app-workspace__head")?.height).toBe(0);
            expect(
              await page.locator(".mail-workspace").evaluate((root) => {
                const content = root.querySelector(":scope > .k2b-app-workspace__content")!;
                return content.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop;
              }),
            ).toBe(0);
            expect(await reader.isVisible()).toBe(true);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            const shots = screenshots;
            if (shots) {
              mkdirSync(resolve(shots, browserName), { recursive: true });
              await page.screenshot({ path: resolve(shots, browserName, `f6-reader-${theme}-390.png`) });
            }
            await reader.focus();
            await page.keyboard.press("Enter");
            await settled(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            expect(await reader.getAttribute("aria-expanded")).toBe("true");
            await aside.getByRole("button", { name: "Close conversation details", exact: true }).click();
            await settled(page);
            expect(await reader.evaluate((element) => element === document.activeElement)).toBe(true);
            expect(await reader.getAttribute("aria-expanded")).toBe("false");
            expect(await shared.isVisible()).toBe(false);
            await page.waitForFunction((expected) => {
              const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
              return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === expected;
            }, false);
            const closedCookie = await storedCookie(page, "cloud_mail_workspace");
            expect(JSON.parse(decodeURIComponent(closedCookie!.value)).detailsOpen).toBe(false);
            await page.reload();
            await ready(page);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            await reader.click();
            await settled(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            await page.waitForFunction((expected) => {
              const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
              return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === expected;
            }, true);
            const openCookie = await storedCookie(page, "cloud_mail_workspace");
            expect(JSON.parse(decodeURIComponent(openCookie!.value)).detailsOpen).toBe(true);
            await page.reload();
            await ready(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            await page.keyboard.press("Escape");
            await settled(page);
            expect(await reader.evaluate((element) => element === document.activeElement)).toBe(true);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            await page.locator(".mail-reader-back").click();
            await page.waitForFunction(() => !new URL(location.href).searchParams.has("conversation"));
            await settled(page);
            expect(await head.isVisible()).toBe(true);
            expect(await shared.isVisible()).toBe(true);
            expect(await shared.isDisabled()).toBe(true);
            if (shots) await page.screenshot({ path: resolve(shots, browserName, `f6-list-${theme}-390.png`) });
            await page.goBack();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
            await settled(page);
            expect(await head.isVisible()).toBe(false);
            expect(await reader.isVisible()).toBe(true);
            await page.setViewportSize({ width: 834, height: 1194 });
            await settled(page);
            expect(await head.isVisible()).toBe(true);
            expect(await shared.isVisible()).toBe(true);
          } finally {
            await close(page);
          }
        });
      }

      test("persistent Details: conversation Back keeps the same closed preference", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&shell=1&persist-details=1`, 834, 900);
        try {
          const button = page.locator("[data-app-workspace-detail-toggle]");
          const aside = page.locator(".k2b-app-workspace__detail");
          await page.locator('[data-conversation-id="Conv02"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
          await settled(page);
          expect(await button.isVisible()).toBe(true);
          expect(await aside.getAttribute("hidden")).not.toBeNull();
          await page.goBack();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
          await settled(page);
          expect(await button.isVisible()).toBe(true);
          expect(await button.isEnabled()).toBe(true);
          expect(await aside.getAttribute("hidden")).not.toBeNull();
          await button.click();
          await settled(page);
          expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("persistent Details: no selection keeps the head control disabled", async () => {
        const page = await open(`${boxPath}?shell=1`, 834, 900);
        try {
          const button = page.locator("[data-app-workspace-detail-toggle]");
          expect(await button.isVisible()).toBe(true);
          expect(await button.isDisabled()).toBe(true);
          expect(await page.locator(".k2b-app-workspace__detail").isVisible()).toBe(false);
        } finally {
          await close(page);
        }
      });

      test("#1467: while the details wait, one click on the reader's details button opens and parks the drawer", async () => {
        const page = await open(widePath(), 1440, 900);
        try {
          const button = page.locator(".mail-reader-toolbar [data-mail-details-trigger]");
          expect((await wide(page)).detail).toBe("waiting");
          await button.click();
          await settled(page);
          expect((await wide(page)).detail).toBe("drawer");
          expect(await button.getAttribute("aria-expanded")).toBe("true");
          // The open drawer covers the reader's end; Escape parks it again.
          await page.keyboard.press("Escape");
          await settled(page);
          expect((await wide(page)).detail).toBe("waiting");
          expect(await button.getAttribute("aria-expanded")).toBe("false");
          // Keyboard: Enter opens it again and moves into the details.
          await button.focus();
          await page.keyboard.press("Enter");
          await settled(page);
          expect((await wide(page)).detail).toBe("drawer");
          expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".k2b-app-workspace__detail")))).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("phone: Reply, Reply all, Forward and Archive wait at the bottom, work by touch and keyboard, and cover nothing", async () => {
        const page = await open(`${boxPath}?conversation=Conv01`, 390, 844);
        try {
          const bar = page.locator("[data-mail-phone-actions] .k2b-toolbar");
          await page.waitForFunction(
            () => !document.querySelector("[data-mail-phone-actions] .k2b-toolbar")?.hasAttribute("data-overflow-pending"),
          );
          expect(await bar.isVisible()).toBe(true);
          const names = await bar
            .locator("button")
            .evaluateAll((elements) =>
              elements
                .filter((element) => element.getClientRects().length > 0 && !element.closest("[data-overflow]"))
                .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim()),
            );
          expect(names).toEqual(["Reply", "Reply all", "Forward", "Archive"]);
          // The bar is the reader's last row: the scrolled messages end above it.
          const scroller = (await page.locator(".mail-reader-scroll").boundingBox())!;
          const strip = (await bar.boundingBox())!;
          expect(scroller.y + scroller.height).toBeLessThanOrEqual(strip.y + 0.5);
          expect(strip.y + strip.height).toBeLessThanOrEqual(844 + 0.5);
          // The top row keeps the way back, … and the details; the actions live below.
          expect(
            await page
              .locator(".mail-reader-toolbar [data-mail-toolbar-action]")
              .evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).length),
          ).toBe(0);
          expect(await page.locator(".mail-reader-toolbar [data-mail-details-trigger]").isVisible()).toBe(true);
          expect(await page.locator("[data-mail-reply-box]").isVisible()).toBe(false);
          // Keyboard: the bar is one tab stop with arrow keys inside.
          await bar.getByRole("button", { name: "Reply", exact: true }).focus();
          await page.keyboard.press("ArrowRight");
          expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Reply all");
          // Touch: Archive sends its command.
          const archived = page.waitForRequest((request) => request.url().endsWith("/actions") && request.method() === "POST");
          await bar.getByRole("button", { name: "Archive" }).tap();
          expect(JSON.stringify((await archived).postDataJSON())).toContain("archive");
        } finally {
          await close(page);
        }
      });

      test("reader: a long conversation shows its newest three messages and n older messages for the rest", async () => {
        const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 900);
        try {
          const cards = page.locator("[data-mail-conversation-messages] [data-mail-message-id]");
          expect(await cards.count()).toBe(3);
          const older = page.locator("[data-mail-older-messages]");
          expect(await older.textContent()).toBe("3 older messages");
          await older.focus();
          await page.keyboard.press("Enter");
          await settled(page);
          expect(await cards.count()).toBe(6);
          expect(await older.count()).toBe(0);
          // Focus moves to the first message the button showed.
          expect(
            await page.evaluate(() => document.activeElement?.closest("[data-mail-message-id]")?.getAttribute("data-mail-message-id")),
          ).toBe("Long03");
          // Another conversation and back: the older messages stay shown with the reading position.
          await page.locator('.mail-workspace [data-conversation-id="Conv01"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
          await settled(page);
          await page.locator('.mail-workspace [data-conversation-id="Conv02"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
          await settled(page);
          expect(await cards.count()).toBe(6);
        } finally {
          await close(page);
        }
      });

      test("reader: a link to an older message shows the whole conversation, also after collapsing that message", async () => {
        const page = await open(widePath({ path: `${boxPath}?conversation=Conv02&message=Long02` }), 1440, 900);
        try {
          const cards = page.locator("[data-mail-conversation-messages] [data-mail-message-id]");
          expect(await cards.count()).toBe(6);
          expect(await page.locator("[data-mail-older-messages]").count()).toBe(0);
          const header = page.locator('[data-mail-message-id="Long02"] [data-mail-message-header]');
          await header.focus();
          await page.keyboard.press("Enter");
          await settled(page);
          expect(await cards.count()).toBe(6);
          expect(await header.evaluate((element) => element === document.activeElement)).toBe(true);
          // Another conversation and Back to the same link: the conversation stays unfolded.
          await page.locator('.mail-workspace [data-conversation-id="Conv01"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
          await settled(page);
          await page.goBack();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("message") === "Long02");
          await settled(page);
          expect(await cards.count()).toBe(6);
        } finally {
          await close(page);
        }
      });

      test("reader: a conversation taller than the reader opens at its start, with the subject in view", async () => {
        const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 480 as 900);
        try {
          const scroller = page.locator(".mail-reader-scroll");
          expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
          expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
          expect(await page.locator("[data-mail-reader-heading]").isVisible()).toBe(true);
          const server = await recordedFrame(page, "server");
          const read = (parts: Frame) => parts.map((part) => ({ ...part, part: part.part.replace(" mail-list-entry-unread", "") }));
          assertFrame(read(server), read(await geometry(page)), "tall conversation settled");
        } finally {
          await close(page);
        }
      });

      test("rows: three-line rows share one height, a fourth line only for tags or Waiting", async () => {
        const page = await open(widePath(), 1440, 900);
        try {
          const rows = await page.locator(".mail-workspace .mail-list-entry").evaluateAll((elements) =>
            elements
              .filter((element) => element.getBoundingClientRect().bottom < innerHeight)
              .map((element) => ({
                lines: element.getAttribute("data-lines"),
                height: element.getBoundingClientRect().height,
              })),
          );
          expect(rows.length).toBeGreaterThan(4);
          for (const row of rows)
            expect(Math.abs(row.height - (row.lines === "4" ? 102 : 77)), JSON.stringify(row)).toBeLessThanOrEqual(0.5);
          expect(rows.filter((row) => row.lines === "3").length).toBeGreaterThan(3);
        } finally {
          await close(page);
        }
      });

      test("opening the waiting Detail moves nothing; closing a column gives only the reader its room", async () => {
        const waiting = await open(widePath(), 1440, 900);
        try {
          const before = await wide(waiting);
          await waiting.locator(".mail-workspace .k2b-app-workspace__detail-toggle").click();
          await settled(waiting);
          const after = await wide(waiting);
          expect(after.detail).toBe("drawer");
          for (const part of ["pane", "reader", "toolbar", "sidebar", "head"] as const) sameBox(after[part], before[part], `1440 ${part}`);
          // Reduced motion: the drawer opened without a transition.
          expect(
            await waiting.locator(".mail-workspace .k2b-app-workspace__detail").evaluate((element) =>
              getComputedStyle(element)
                .transitionDuration.split(",")
                .every((value) => Number.parseFloat(value) === 0),
            ),
          ).toBe(true);
        } finally {
          await close(waiting);
        }
        const column = await open(widePath(), 1920, 1080);
        try {
          const before = await wide(column);
          expect(before.detail).toBe("column");
          await column.locator(".mail-reader-toolbar [data-mail-details-trigger]").click();
          await settled(column);
          const after = await wide(column);
          expect(after.detail).toBe("closed");
          for (const part of ["pane", "sidebar"] as const) sameBox(after[part], before[part], `1920 ${part}`);
          // The head row shares its track with Main, so only its end follows the column away.
          sameBox({ ...after.head!, width: 0 }, { ...before.head!, width: 0 }, "1920 head start");
          sameBox({ ...after.reader!, width: 0 }, { ...before.reader!, width: 0 }, "1920 reader start");
          expect(after.reader!.width).toBeGreaterThan(before.reader!.width);
        } finally {
          await close(column);
        }
      });

      test("dark at 1920: the Detail column shares the reader's surface, with no seam", async () => {
        const page = await open(`${widePath()}&theme=dark`, 1920, 1080);
        try {
          const seam = await page.evaluate(() => {
            const surface = (element: Element | null): string => {
              for (let current = element; current; current = current.parentElement) {
                const color = getComputedStyle(current).backgroundColor;
                if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
              }
              return "none";
            };
            const aside = document.querySelector(".mail-workspace .k2b-app-workspace__detail")!;
            const style = getComputedStyle(aside);
            return {
              detail: surface(aside),
              reader: surface(document.querySelector(".mail-reader")),
              list: surface(document.querySelector(".mail-workspace .k2b-app-workspace__main-pane")),
              borders: [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth],
              shadow: style.boxShadow,
            };
          });
          // One surface: the list, the reader and the Detail column (the reader drew a raised dark fill before).
          expect(seam.detail).toBe(seam.list);
          expect(seam.reader).toBe(seam.detail);
          expect(seam.borders).toEqual(["0px", "0px", "0px", "0px"]);
          expect(seam.shadow).toBe("none");
          if (screenshots) await page.screenshot({ path: join(resolve(screenshots), "wide-dark-1920.png") });
        } finally {
          await close(page);
        }
      });
    });

    if (screenshots)
      test("optional synthetic review screenshots", async () => {
        const directory = resolve(screenshots);
        mkdirSync(directory, { recursive: true });
        for (const theme of ["light", "dark"] as const)
          for (const [width, height] of sizes) {
            if (theme === "dark" && width !== 1440 && width !== 390) continue;
            for (const [name, state, path] of [
              ["focus", "tabs", "/app/mail"],
              ["mailbox", "tabs", boxPath],
              ...(theme === "light"
                ? [
                    ["mailbox", "folder", `${boxPath}?folder=Filed1`],
                    ["mailbox", "details", `${boxPath}?conversation=Conv01&details=1`],
                  ]
                : []),
            ]) {
              const page = await open(`${path}${path!.includes("?") ? "&" : "?"}theme=${theme}`, width, height);
              try {
                await page.screenshot({ path: join(directory, `${name}-${state}-${theme}-${width}.png`) });
              } finally {
                await close(page);
              }
            }
          }
      }, 120_000);
  });
