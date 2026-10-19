import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSeenHintsCookieHeader } from "@k2b/cloud/contracts/seen-hints";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ItemListResult, SpaceAssignableUser, SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { SpaceSettingsContextSchema } from "@/settings-context";
import { browserName, launchBrowser, storedCookie } from "../../../../../../ui/test/browser";
import type { KanbanBucketInitial } from "../kanban/types";
import { parseSpaceSettings } from "../settings/SpaceSettingsStore";
import type { SpacesViewSnapshot } from "./workspace-types";

const TIME = "2026-10-15T09:00:00+02:00";
const TIME_ZONE = "Europe/Berlin";
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-head-browser-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  // The frontend root holds the overview island, which the overview pages render as Cloud does.
  componentRoots: [resolve(import.meta.dir, "../../..")],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpaceHeadFixture, OverviewFixture } = await import("./space-head.browser-fixture");
const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
// Invented content: a small team board with tags, people, deadlines, and one task someone works on.
const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: null, rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In progress", color: "#3b82f6", rank: "2", isDone: false },
  { id: "Col003", spaceId: "Space1", name: "Review", color: "#f59e0b", rank: "3", isDone: false },
  { id: "Col004", spaceId: "Space1", name: "Done", color: "#10b981", rank: "4", isDone: true },
];
const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Warehouse", color: "#f59e0b" },
  { id: "Tag002", spaceId: "Space1", name: "Purchasing", color: "#8b5cf6" },
  { id: "Tag003", spaceId: "Space1", name: "Routes", color: "#0ea5e9" },
  { id: "Tag004", spaceId: "Space1", name: "Customer", color: "#ef4444" },
];
const robin = { id: "11111111-1111-4111-8111-111111111111", kind: "user" as const, displayName: "Robin Example", avatarHash: null };
const kim = { id: "22222222-2222-4222-8222-222222222222", kind: "user" as const, displayName: "Kim Example", avatarHash: null };
const sam = { id: "33333333-3333-4333-8333-333333333333", kind: "user" as const, displayName: "Sam Example", avatarHash: null };
const tag = (id: string) => tags.filter((entry) => entry.id === id);
const item = (id: string, columnId: string, title: string, extra: Partial<SpaceItem> = {}): SpaceItem => ({
  id,
  spaceId: "Space1",
  columnId,
  title,
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  deadlineAllDay: false,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: id,
  completedAt: columnId === "Col004" ? "2026-10-14T10:00:00.000Z" : null,
  createdBy: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  assignees: [],
  tags: [],
  ...extra,
});
const boardItems: SpaceItem[] = [
  item("Item01", "Col001", "Clear out shelf B", { tags: tag("Tag001"), assignees: [robin], deadline: "2026-10-16", deadlineAllDay: true }),
  item("Item02", "Col001", "Ask the film supplier for a quote", {
    tags: tag("Tag002"),
    assignees: [kim],
    deadline: "2026-10-20",
    deadlineAllDay: true,
  }),
  item("Item03", "Col001", "Agree on the route plan for week 43", { tags: tag("Tag003"), assignees: [robin], priority: "high" }),
  item("Item04", "Col001", "Service the forklift", { tags: tag("Tag001"), assignees: [sam], deadline: "2026-10-22", deadlineAllDay: true }),
  item("Item05", "Col002", "Count stock on shelf B", {
    tags: tag("Tag001"),
    assignees: [kim],
    deadline: "2026-10-12",
    deadlineAllDay: true,
    claim: {
      id: "44444444-4444-4444-8444-444444444444",
      actor: { kind: "user", id: kim.id },
      displayName: kim.displayName,
      avatarHash: null,
      claimedAt: "2026-10-15T06:48:00.000Z",
    },
  }),
  item("Item06", "Col002", "Settle the complaint from Morgenrot", { tags: tag("Tag004"), assignees: [sam], priority: "urgent" }),
  item("Item07", "Col002", "Plan a new route for the north side", { tags: [...tag("Tag003"), ...tag("Tag004")] }),
  item("Item08", "Col003", "Check the September delivery notes", {
    tags: tag("Tag002"),
    assignees: [robin],
    deadline: "2026-10-15T16:00:00+02:00",
  }),
  item("Item09", "Col003", "Order labels for hall 2", { assignees: [kim], deadline: "2026-10-19", deadlineAllDay: true }),
  item("Item10", "Col004", "Sweep ramp 2", { tags: tag("Tag001"), assignees: [sam] }),
  item("Item11", "Col004", "Compare film prices", { tags: tag("Tag002"), assignees: [kim] }),
];
const itemsResult: ItemListResult = {
  items: boardItems,
  page: 1,
  pageSize: 50,
  total: boardItems.length,
  totalPages: 1,
  groupCounts: {},
};
const buckets: KanbanBucketInitial[] = columns.map((column) => {
  const shown = boardItems.filter((entry) => entry.columnId === column.id);
  return {
    key: `column:${column.id}`,
    label: column.name,
    color: column.color,
    kind: "column",
    columnId: column.id,
    isDone: column.isDone,
    items: shown,
    page: 1,
    totalPages: 1,
    total: shown.length,
  };
});
const overviewSpaces = [
  { id: "Space1", name: "Planning", color: "#6366f1", description: "Team work", openItemCount: 9 },
  { id: "Space2", name: "Ideas", color: "#2563eb", description: null, openItemCount: 3 },
  { id: "Space3", name: "Trade fair 2026 with a name long enough to fade", color: "#f97316", description: null, openItemCount: 12 },
];
const overviewWork = {
  view: "mine" as const,
  counts: { mine: 3, today: 1, upcoming: 4 },
  items: [
    {
      shortId: "Item01",
      spaceShortId: "Space1",
      spaceName: "Planning",
      spaceColor: "#6366f1",
      title: "Clear out shelf B",
      priority: null,
      startsAt: null,
      endsAt: null,
      deadline: "2026-10-16",
      deadlineAllDay: true,
    },
    {
      shortId: "Item03",
      spaceShortId: "Space1",
      spaceName: "Planning",
      spaceColor: "#6366f1",
      title: "Agree on the route plan for week 43",
      priority: "high" as const,
      startsAt: null,
      endsAt: null,
      deadline: null,
      deadlineAllDay: false,
    },
    {
      shortId: "Item21",
      spaceShortId: "Space2",
      spaceName: "Ideas",
      spaceColor: "#2563eb",
      title: "Collect ideas for the winter catalogue",
      priority: null,
      startsAt: null,
      endsAt: null,
      deadline: "2026-10-21",
      deadlineAllDay: true,
    },
  ],
};
const overviewActivity = [
  {
    id: "Act001",
    space: { id: "Space1", name: "Planning", color: "#6366f1" },
    item: { id: "Item05", title: "Count stock on shelf B" },
    actor: { kind: "user" as const, id: kim.id, displayName: kim.displayName, avatarHash: null },
    action: "task.claimed",
    metadata: {},
    occurrenceCount: 1,
    createdAt: "2026-10-15T06:48:00.000Z",
    lastOccurredAt: "2026-10-15T06:48:00.000Z",
  },
  {
    id: "Act002",
    space: { id: "Space1", name: "Planning", color: "#6366f1" },
    item: { id: "Item10", title: "Sweep ramp 2" },
    actor: { kind: "user" as const, id: sam.id, displayName: sam.displayName, avatarHash: null },
    action: "task.completed",
    metadata: {},
    occurrenceCount: 1,
    createdAt: "2026-10-14T15:10:00.000Z",
    lastOccurredAt: "2026-10-14T15:10:00.000Z",
  },
];
/** Screenshots for review, light and dark at every width; nothing personal, all invented. */
const shots = join(tmpdir(), "spaces-white-canvas", browserName);
mkdirSync(shots, { recursive: true });
const people: SpaceAssignableUser[] = Array.from({ length: 6 }, (_, index) => ({
  id: `${index + 1}1111111-1111-4111-8111-111111111111`,
  uid: `person${index}`,
  displayName: index === 5 ? "Task worker" : `Person ${index + 1}`,
  kind: index === 5 ? "service_account" : "user",
  avatarHash: null,
}));
const settings = SpaceSettingsContextSchema.parse({
  space: {
    id: "Space1",
    name: "Planning",
    description: "Team work",
    color: "#6366f1",
    icalToken: "calendar-token",
    createdAt: TIME,
    updatedAt: TIME,
    columns,
    virtualColumns: [],
    tags: [],
    templates: [],
  },
  settings: { view: "list", hideSettings: false },
  permission: "admin",
  accessEntries: [],
  apiKeys: [],
  wormholes: [],
  githubTokenConfigured: false,
});
type View = "list" | "table" | "kanban" | "calendar";
const isView = (view: string | null): view is View => view === "list" || view === "table" || view === "kanban" || view === "calendar";
const resolveView = (url: URL, cookie: string | undefined) => {
  const view = url.searchParams.get("view");
  return isView(view) ? view : parseSpaceSettings(cookie, "Space1").view;
};
const snapshot = (view: View): SpacesViewSnapshot =>
  view === "kanban"
    ? { kind: "kanban", buckets, wormholes: [] }
    : { kind: "list", currentView: view === "table" ? "table" : "list", itemsResult };
const hintIds = ["spaces.sidebar-switch", "spaces.view-tabs", "spaces.space-menu", "spaces.overview-sidebar"];
let css = "";
let controller = "";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

// Recorded before island imports, after fonts load. The same selectors measure the hydrated frame.
const geometryScript = `window.headGeometry = () => Array.from(document.querySelectorAll('.k2b-app-workspace__head-views,.k2b-app-workspace__head-filters,.k2b-app-workspace__head-actions,[data-workspace-primary],.spaces-sidebar-list .k2b-app-workspace__sidebar-item')).map(e => {const r=e.getBoundingClientRect(); return {class:e.className.trim().split(/\\s+/).sort().join(" "),x:r.x,y:r.y,width:r.width,height:r.height}});`;
const pageHtml = (url: URL, cookie: string | undefined) => {
  const view = resolveView(url, cookie);
  const wanted = url.searchParams.get("hint");
  const hint = wanted && hintIds.includes(wanted) && !parseSeenHintsCookieHeader(cookie).includes(wanted) ? wanted : null;
  const html =
    url.pathname === "/app/spaces"
      ? renderToString(() =>
          createComponent(OverviewFixture, {
            spaces: overviewSpaces,
            sidebarHint: hint === "spaces.overview-sidebar",
            initialView: "mine",
            initialPinnedSpaceIds: ["Space1"],
            initialWork: overviewWork,
            initialActivity: { items: overviewActivity, nextCursor: null },
            initialActivityError: null,
            dateConfig: { locale: "en", timeZone: TIME_ZONE },
          }),
        )
      : renderToString(() =>
          createComponent(SpaceHeadFixture, {
            view,
            source: `${url.pathname}${url.search}`,
            overview: false,
            hint,
            columns,
            tags,
            itemsResult,
            buckets,
            people,
          }),
        );
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  return (
    `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
    `<style>solid-client,solid-island{display:contents}@media not all and (min-width:48rem){[data-workspace-primary]{position:fixed;right:12px;bottom:24px}}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0"><main style="container-type:inline-size;container-name:k2b-app-area;display:flex;flex-direction:column;height:100dvh">${html}</main>` +
    `<script>${controller}</script><script type="module">${geometryScript}await document.fonts.ready;document.documentElement.dataset.serverCurrent=document.querySelector('.k2b-app-workspace__head-views [aria-current="page"]')?.textContent;document.documentElement.dataset.serverGeometry=JSON.stringify(window.headGeometry());` +
    `await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));document.documentElement.dataset.headReady='true';</script></body></html>`
  );
};

beforeAll(async () => {
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css")].map(
      (entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile head fixture styles");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))),
  ].join("\n");
  const entry = resolve(import.meta.dir, "space-head.controller.ts");
  const built = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(join(ui, "browser/index.js"))}; installAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle workspace controller");
  const output = built.outputs[0];
  if (!output) throw new Error("Missing workspace controller bundle");
  controller = await output.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === "/api/spaces/Space1/settings-context") return Response.json(settings);
      if (url.pathname === "/api/spaces/workspace/view")
        return Response.json(snapshot(resolveView(new URL(url.searchParams.get("href") ?? "/", "http://spaces.local"), undefined)));
      if (url.pathname === "/api/spaces/Space1/items/filter") return Response.json(itemsResult);
      if (url.pathname === "/api/spaces/Space1/board") return Response.json(buckets);
      if (url.pathname.startsWith("/api/")) return Response.json([]);
      return new Response(pageHtml(url, request.headers.get("cookie") ?? undefined), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
const open = async (path: string, width = 1440) => {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    hasTouch: width === 390,
    isMobile: width === 390,
    timezoneId: TIME_ZONE,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.clock.setFixedTime(new Date(TIME));
  try {
    await page.goto(new URL(path, server.url).href);
    await ready(page);
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
};
const ready = async (page: Page) => {
  await page.waitForFunction(() => document.documentElement.dataset.headReady === "true");
  await page.evaluate(() => document.fonts.ready);
};
const geometry = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        ".k2b-app-workspace__head-views,.k2b-app-workspace__head-filters,.k2b-app-workspace__head-actions,[data-workspace-primary],.spaces-sidebar-list .k2b-app-workspace__sidebar-item",
      ),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        class: element.className.trim().split(/\s+/).sort().join(" "),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
const expectStableFrame = async (page: Page) => {
  const before = await page.locator("html").getAttribute("data-server-geometry");
  if (before === null) throw new Error("Missing server geometry snapshot");
  expect(JSON.stringify(await geometry(page))).toBe(before);
  expect(await page.locator('.k2b-app-workspace__head-views [aria-current="page"]').textContent()).toBe(
    await page.locator("html").getAttribute("data-server-current"),
  );
};

describe(`Spaces shared head in ${browserName}`, () => {
  for (const view of ["list", "kanban"] as const)
    for (const theme of ["light", "dark"])
      for (const width of [1440, 1194, 834, 390]) {
        test(`${view} ${theme} ${width}: server, hydrated and reload geometry agree`, async () => {
          const page = await open(`/app/spaces/Space1?view=${view}&theme=${theme}`, width);
          try {
            expect(await page.locator("body").getAttribute("data-theme")).toBe(theme);
            await expectStableFrame(page);
            const frame = await geometry(page);
            // querySelectorAll records all four rows even when the phone sidebar has zero-sized rectangles.
            expect(frame.filter((part) => part.class.includes("k2b-app-workspace__sidebar-item"))).toHaveLength(4);
            await page.reload();
            await ready(page);
            await expectStableFrame(page);
            expect(await geometry(page)).toEqual(frame);
          } finally {
            await page.context().close();
          }
        }, 30_000);
      }
  for (const view of ["list", "table", "kanban", "calendar"] as const) {
    test(`old ?view=${view} URLs keep the selected server tab after reload`, async () => {
      const page = await open(`/app/spaces/Space1?view=${view}`);
      try {
        for (let reload = 0; reload < 2; reload++) {
          await expectStableFrame(page);
          expect(await page.locator(`.k2b-app-workspace__head-views a[aria-current="page"]`).getAttribute("href")).toContain(
            `view=${view}`,
          );
          if (reload === 0) {
            await page.reload();
            await ready(page);
          }
        }
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
  test("tab clicks keep every neighboring tab in place", async () => {
    const page = await open("/app/spaces/Space1?view=list");
    try {
      const neighbors = page.locator('[data-spaces-view-tabs] [data-view-tab]:not([data-view-tab="table"]) a');
      const boxes = () =>
        neighbors.evaluateAll((links) =>
          links.map((link) => {
            const rect = link.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        );
      expect(await neighbors.count()).toBe(3);
      const before = await boxes();
      await Promise.all([
        page.waitForURL((url) => url.searchParams.get("view") === "table"),
        page.locator('[data-spaces-view-tabs] [data-view-tab="table"] a').click(),
      ]);
      await ready(page);
      expect(await page.locator('[data-spaces-view-tabs] [aria-current="page"]').getAttribute("href")).toContain("view=table");
      expect(await boxes()).toEqual(before);
    } finally {
      await page.context().close();
    }
  }, 30_000);
  test("settings and iCal work from the head menu", async () => {
    const page = await open("/app/spaces/Space1?view=kanban");
    try {
      if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.getByRole("button", { name: "Space menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Space settings", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").getByRole("button", { name: "Close settings", exact: true }).click();
      await page.getByRole("button", { name: "Space menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Copy iCal URL", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Copied iCal URL" }).waitFor();
      if (browserName === "chromium")
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          new URL("/api/spaces/calendar/ical/calendar-token.ics", server.url).href,
        );
      await page.getByRole("button", { name: "Space menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true }).click();
      await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    } finally {
      await page.context().close();
    }
  }, 30_000);
  for (const id of hintIds)
    for (const usePath of [false, true]) {
      test(`${id}: ${usePath ? "using the path" : "Got it"} persists across reload`, async () => {
        const path = id === "spaces.overview-sidebar" ? "/app/spaces" : "/app/spaces/Space1";
        const page = await open(`${path}?view=list&hint=${id}`);
        try {
          const hint = page.locator(".k2b-moved-hint");
          await hint.waitFor({ state: "visible" });
          expect(await hint.count()).toBe(1);
          if (!usePath) await hint.getByRole("button", { name: "Got it", exact: true }).click();
          else if (id === "spaces.space-menu") await page.getByRole("button", { name: "Space menu", exact: true }).click();
          else if (id === "spaces.view-tabs") await page.locator('[data-spaces-view-tabs] a[aria-current="page"]').click();
          else await page.locator('.spaces-sidebar-list a[href="/app/spaces/Space2"]').click();
          await ready(page);
          expect(await page.locator(".k2b-moved-hint").count()).toBe(0);
          await page.reload();
          await ready(page);
          expect(await page.locator(".k2b-moved-hint").count()).toBe(0);
          expect((await storedCookie(page, "cloud_seen_hints"))?.value).toContain(id);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  /** Resolves with the handle's value once it passes `than` in the given direction. */
  const resizedPast = (target: ReturnType<Page["locator"]>, direction: "above" | "below", than: number) =>
    target.evaluate(
      (handle, [way, limit]) =>
        new Promise<number>((resolve, reject) => {
          const started = performance.now();
          const check = () => {
            const now = Number(handle.getAttribute("aria-valuenow"));
            if (way === "above" ? now > limit : now < limit) resolve(now);
            else if (performance.now() - started > 5000)
              reject(
                new Error(
                  `aria-valuenow stayed ${now}, focus on ${document.activeElement?.tagName}.${document.activeElement?.getAttribute("role")}`,
                ),
              );
            else requestAnimationFrame(check);
          };
          check();
        }),
      [direction, than] as const,
    );
  test("overview sidebar resizes by pointer", async () => {
    const page = await open("/app/spaces?view=mine");
    try {
      const target = page.locator('[role="separator"][data-app-workspace-resize="sidebar"]');
      const before = Number(await target.getAttribute("aria-valuenow"));
      const box = await target.boundingBox();
      if (!box) throw new Error("Missing overview sidebar resize handle");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2);
      await page.mouse.up();
      expect(await resizedPast(target, "above", before)).toBeGreaterThan(before);
    } finally {
      await page.context().close();
    }
  }, 30_000);
  for (const [key, direction] of [
    ["ArrowRight", "above"],
    ["ArrowLeft", "below"],
  ] as const)
    test(`overview sidebar resizes by ${key}`, async () => {
      // One key per page: a second key right after the first is sometimes lost in WebKit under load (#1525).
      const page = await open("/app/spaces?view=mine");
      try {
        const target = page.locator('[role="separator"][data-app-workspace-resize="sidebar"]');
        const before = Number(await target.getAttribute("aria-valuenow"));
        await target.focus();
        await page.keyboard.press(key);
        const after = await resizedPast(target, direction, before);
        expect(direction === "above" ? after > before : after < before).toBe(true);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  test("390px: view tabs precede chips and primary is round", async () => {
    const page = await open("/app/spaces/Space1?view=list", 390);
    try {
      const tabs = await page.locator(".k2b-app-workspace__head-views").boundingBox();
      const filters = await page.locator(".k2b-app-workspace__head-filters").boundingBox();
      if (!tabs || !filters) throw new Error("Phone head has no views or filters");
      expect(tabs.y + tabs.height).toBeLessThanOrEqual(filters.y);
      const primary = await page.locator("[data-workspace-primary]").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, radius: Number.parseFloat(getComputedStyle(element).borderRadius) };
      });
      expect(primary.width).toBe(primary.height);
      expect(primary.radius).toBeGreaterThanOrEqual(primary.width / 2);
    } finally {
      await page.context().close();
    }
  }, 30_000);
  test("Kanban columns have no tray, and cards are calm objects with a 14 px title", async () => {
    const page = await open("/app/spaces/Space1?view=kanban");
    try {
      const columns = await page.locator("section[data-spaces-kanban-column]").evaluateAll((sections) =>
        sections.map((section) => {
          const style = getComputedStyle(section);
          return { background: style.backgroundColor, border: style.borderTopWidth };
        }),
      );
      expect(columns.length).toBe(4);
      for (const column of columns) expect(column).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px" });
      const cards = await page.locator("[data-spaces-kanban-card] p").evaluateAll((titles) =>
        titles.map((title) => ({
          size: getComputedStyle(title).fontSize,
          border: getComputedStyle(title.closest("article")!).borderTopWidth,
        })),
      );
      expect(cards.length).toBe(11);
      for (const card of cards) expect(card).toEqual({ size: "14px", border: "0px" });
      // The first tag tints its card and its name stands on the card; a card without a tag stays neutral.
      const tinted = page.locator('article:has([data-item-id="Item07"])');
      expect(await tinted.getAttribute("data-spaces-kanban-card-tint")).toBe("");
      expect(await tinted.locator("[data-spaces-kanban-card-tag]").textContent()).toBe("Routes+1");
      expect(await page.locator('article:has([data-item-id="Item09"])').getAttribute("data-spaces-kanban-card-tint")).toBeNull();
    } finally {
      await page.context().close();
    }
  }, 30_000);
  for (const width of [1440, 390])
    test(`${width}: no Kanban column scrolls sideways, also with the touch hit areas`, async () => {
      // Only the board scrolls sideways; a column that did would take the reveal of the next card on a phone.
      const page = await open("/app/spaces/Space1?view=kanban", width);
      try {
        const sideways = await page
          .locator("section[data-spaces-kanban-column] [data-scroll-preserve]")
          .evaluateAll((lists) =>
            lists.filter((list) => list.scrollWidth > list.clientWidth).map((list) => list.closest("section")?.dataset.spacesKanbanColumn),
          );
        expect(sideways).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  for (const theme of ["light", "dark"] as const)
    test(`${theme}: a tag tint keeps every card text at AA contrast`, async () => {
      const page = await open(`/app/spaces/Space1?view=kanban&theme=${theme}`);
      try {
        const palette = [
          "#ef4444",
          "#f97316",
          "#f59e0b",
          "#eab308",
          "#84cc16",
          "#22c55e",
          "#10b981",
          "#14b8a6",
          "#06b6d4",
          "#0ea5e9",
          "#3b82f6",
          "#6366f1",
          "#8b5cf6",
          "#a855f7",
          "#d946ef",
          "#ec4899",
          "#f43f5e",
          "#6b7280",
          "#facc15",
          "#000000",
          "#ffffff",
        ];
        const lowest = await page.evaluate((colors) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d", { willReadFrequently: true })!;
          /** Paints the layers from the page's own computed colors, so color-mix and alpha resolve as rendered. */
          const paint = (...layers: string[]) => {
            context.clearRect(0, 0, 1, 1);
            for (const layer of [getComputedStyle(document.body).backgroundColor, ...layers]) {
              context.fillStyle = layer;
              context.fillRect(0, 0, 1, 1);
            }
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            return [r!, g!, b!];
          };
          const luminance = (rgb: number[]) => {
            const [r, g, b] = rgb.map((value) => {
              const channel = value / 255;
              return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          const contrast = (a: number[], b: number[]) => {
            const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (light! + 0.05) / (dark! + 0.05);
          };
          const card = document.querySelector<HTMLElement>('article:has([data-item-id="Item05"])')!;
          const texts = [card.querySelector("p")!, ...card.querySelectorAll<HTMLElement>(".spaces-kanban-card-meta")];
          const results: { color: string; part: string; ratio: number }[] = [];
          for (const color of colors) {
            card.style.setProperty("--spaces-card-tag", color);
            const surface = getComputedStyle(card).backgroundColor;
            for (const text of texts)
              results.push({ color, part: text.textContent ?? "", ratio: contrast(paint(getComputedStyle(text).color), paint(surface)) });
            // Hover deepens the tint; it must keep the same contrast.
            const probe = card.appendChild(document.createElement("i"));
            probe.style.backgroundColor = "var(--spaces-card-fill-hover)";
            const hover = getComputedStyle(probe).backgroundColor;
            probe.remove();
            for (const text of texts)
              results.push({
                color,
                part: `hover ${text.textContent}`,
                ratio: contrast(paint(getComputedStyle(text).color), paint(hover)),
              });
          }
          return results.sort((a, b) => a.ratio - b.ratio).slice(0, 3);
        }, palette);
        expect(lowest[0]!.ratio, JSON.stringify(lowest)).toBeGreaterThanOrEqual(4.5);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  test("review screenshots of the white surface", async () => {
    for (const theme of ["light", "dark"] as const)
      for (const width of [1920, 1440, 1194, 834, 390])
        for (const path of [
          "/app/spaces/Space1?view=kanban",
          "/app/spaces/Space1?view=list",
          "/app/spaces/Space1?view=table",
          "/app/spaces",
        ]) {
          if (theme === "dark" && path !== "/app/spaces/Space1?view=kanban" && width !== 1440) continue;
          const page = await open(`${path}${path.includes("?") ? "&" : "?"}theme=${theme}`, width);
          try {
            const name = path === "/app/spaces" ? "overview" : new URL(path, server.url).searchParams.get("view");
            await page.screenshot({ path: join(shots, `${name}-${theme}-${width}.png`) });
          } finally {
            await page.context().close();
          }
        }
  }, 180_000);
});
