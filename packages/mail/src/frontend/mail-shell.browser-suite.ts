import { afterAll, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser, settled } from "../../../ui/test/browser";
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
].join(",");
// Rows below the fold render lazily (content-visibility); only what the person sees must hold still.
const geometrySource = `() => Array.from(document.querySelectorAll(${JSON.stringify(measurements)})).map((e,i)=>{const r=e.getBoundingClientRect();const part=String(e.className).split(" ").filter(Boolean).join(" ");return r.bottom<=0||r.top>=innerHeight?{part,index:i,x:0,y:-1,width:0,height:0}:{part,index:i,x:r.x,y:r.y,width:r.width,height:r.height}})`;
type Frame = { part: string; index: number; x: number; y: number; width: number; height: number }[];
let css = "";
let controller = "";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const pageErrors = new WeakMap<Page, string[]>();
const pageHtml = (url: URL) => {
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const locale = url.searchParams.get("locale") === "de" ? "de" : "en";
  const html = renderToString(() => createComponent(Fixture, { source: `${url.pathname}${url.search}`, locale, theme }));
  return `<!doctype html><html lang="${locale}" class="${theme}" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style><style>solid-client,solid-island{display:contents}</style><style>/* Like the Cloud shell on phones: the primary action is the round button beside the bottom bar, out of the head row. */@media not all and (min-width:48rem){.k2b-app-workspace__head-primary{position:fixed;right:12px;bottom:12px}}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0"><main style="container-type:inline-size;container-name:k2b-app-area;display:flex;flex-direction:column;height:100dvh">${html}</main><script>${controller}</script><script type="module">
    const geometry=${geometrySource};
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    document.documentElement.dataset.serverGeometry=JSON.stringify(geometry());
    document.documentElement.dataset.serverCurrent=document.querySelector('${tabsSelector} [aria-current="page"]')?.getAttribute('href')??'';
    await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));
    // The first frame the browser paints after hydration, as a person sees it.
    await new Promise(resolve=>requestAnimationFrame(resolve));
    document.documentElement.dataset.hydratedGeometry=JSON.stringify(geometry());
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
      return new Response(pageHtml(url), { headers: { "content-type": "text/html; charset=utf-8" } });
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
  await page.waitForFunction(() => document.documentElement.dataset.mailShellReady === "true");
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
        const action = element.querySelector(".k2b-app-workspace__sidebar-item-actions button[aria-haspopup]")!.getBoundingClientRect();
        return { textEnd: range.getBoundingClientRect().right, actionStart: action.x, actionWidth: action.width };
      });
      expect(fit.actionWidth).toBeGreaterThan(0);
      expect(fit.textEnd).toBeLessThanOrEqual(fit.actionStart);
    } finally {
      await close(page);
    }
  });

  // One browser, one context per viewport/theme; Focus and mailbox share that context.
  for (const theme of ["light", "dark"] as const)
    for (const [width, height] of sizes)
      test(`${theme} ${width}x${height}: server = hydrated = settled = reload within 0.5px`, async () => {
        const page = await open(`/app/mail?theme=${theme}`, width, height);
        const differences: string[] = [];
        try {
          for (const path of ["/app/mail", boxPath]) {
            if (path === boxPath) {
              await page.goto(new URL(`${path}?theme=${theme}`, server.url).href);
              await ready(page);
            }
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
            // List rows change height for one frame after hydration on main too (#1545); the shell must not move.
            const shell = (frame: Frame) => frame.filter((part) => !/mail-focus-row|mail-list-entry/.test(part.part));
            await compare("hydrated", shell(serverFrame), shell(await recordedFrame(page, "hydrated")));
            await compare("settled", serverFrame, await geometry(page));
            await page.reload();
            await ready(page);
            await compare("reload SSR", serverFrame, await recordedFrame(page, "server"));
            await compare("reload hydrated", shell(serverFrame), shell(await recordedFrame(page, "hydrated")));
            await compare("reload settled", serverFrame, await geometry(page));
          }
          expect(differences).toEqual([]);
        } finally {
          await close(page);
        }
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

  if (process.env.MAIL_SHELL_SCREENSHOTS)
    test("optional synthetic review screenshots", async () => {
      const directory = resolve(process.env.MAIL_SHELL_SCREENSHOTS!);
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
