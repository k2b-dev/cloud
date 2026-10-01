import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { type Browser, chromium, type Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceColumn, SpaceItem } from "@/contracts";
import type { KanbanBucketInitial } from "./types";

// Where the board starts, whether the toolbar stays one row, and how a folded column takes a drop are
// layout questions, so the route renders on the server and then runs its real island bundle in Chromium,
// as the workspace page does. The island bundle resolves Solid from its root, so the scratch root sits
// inside this package's dependencies.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-kanban-browser-"));
const workspaceDir = resolve(import.meta.dir, "../workspace");
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [workspaceDir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: KanbanFixture } = await import("./kanban-board.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];

const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: "#3b82f6", rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In progress", color: "#f59e0b", rank: "2", isDone: false },
  { id: "Col003", spaceId: "Space1", name: "Review", color: "#8b5cf6", rank: "3", isDone: false },
  { id: "Col004", spaceId: "Space1", name: "Done", color: null, rank: "4", isDone: true },
];
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
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: id,
  completedAt: columnId === "Col004" ? "2026-09-30T10:00:00.000Z" : null,
  createdBy: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: new Date().toISOString(),
  assignees: [],
  tags: [],
  ...extra,
});
const me = { id: "11111111-1111-4111-8111-111111111111", displayName: "Robin Example", avatarHash: null };
const items = [
  item("Item01", "Col001", "Order banners for the spring fair", { assignees: [me], priority: "high" }),
  item("Item02", "Col001", "Ask the bakery about a stand"),
  item("Item03", "Col001", "Draft the volunteer schedule", { description: "Two shifts per day, one lead per shift." }),
  item("Item04", "Col002", "Book the stage", { assignees: [me] }),
  item("Item05", "Col002", "Collect insurance quotes"),
  item("Item06", "Col003", "Proofread the flyer"),
  item("Item07", "Col004", "Reserve the town square"),
];
const bucketsFor = (filter?: (entry: SpaceItem) => boolean): KanbanBucketInitial[] =>
  columns.map((column) => {
    const all = items.filter((entry) => entry.columnId === column.id);
    const shown = filter ? all.filter(filter) : all;
    return {
      key: `column:${column.id}`,
      label: column.name,
      color: column.color,
      kind: "column",
      columnId: column.id,
      isDone: column.isDone,
      items: shown,
      page: 1,
      totalPages: shown.length > 0 ? 1 : 0,
      total: shown.length,
      ...(filter ? { unfilteredTotal: all.length } : {}),
    };
  });
const unfiltered = () => bucketsFor();
const assignedToMe = () => bucketsFor((entry) => entry.assignees?.some((assignee) => assignee.id === me.id) ?? false);

type Scenario = { locale: "en" | "de"; query?: string; folded?: string[]; buckets?: KanbanBucketInitial[] };
const serverBody = (scenario: Scenario) =>
  renderToString(() =>
    createComponent(KanbanFixture, {
      locale: scenario.locale,
      spaceId: "Space1",
      baseUrl: `/app/spaces/Space1${scenario.query ?? ""}`,
      columns,
      tags: [{ id: "Tag001", spaceId: "Space1", name: "Logistics", color: "#0ea5e9" }],
      wormholes: [],
      initialBuckets: scenario.buckets ?? unfiltered(),
      foldedColumns: scenario.folded ?? [],
      selectedItemId: "",
      canWrite: true,
      currentUserId: me.id,
    }),
  );

let css = "";
let server: ReturnType<typeof Bun.serve>;
const pages = new Map<string, string>();
const moves: unknown[] = [];
let browser: Browser;

beforeAll(async () => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      const move = /^\/api\/spaces\/Space1\/items\/(\w+)\/move$/.exec(url.pathname);
      if (move && request.method === "POST") {
        const body = (await request.json()) as { columnId: string };
        moves.push(body);
        return Response.json({ ...items.find((entry) => entry.id === move[1])!, columnId: body.columnId });
      }
      if (url.pathname === "/api/spaces/Space1/items/filter") {
        const body = (await request.json()) as { columnIds: string[] };
        const bucket = unfiltered().find((entry) => entry.columnId === body.columnIds[0])!;
        return Response.json({ items: bucket.items, total: bucket.total, page: 1, pageSize: 30, totalPages: bucket.totalPages });
      }
      if (url.pathname === "/api/spaces/workspace/view") {
        const href = new URL(url.searchParams.get("href") ?? "", url.origin);
        const buckets = href.searchParams.get("assignedTo") === "me" ? assignedToMe() : unfiltered();
        return Response.json({ kind: "kanban", buckets, wormholes: [] });
      }
      const html = pages.get(url.searchParams.get("case") ?? "");
      return html
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("Not found", { status: 404 });
    },
  });
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (scenario: Scenario, theme: "light" | "dark") =>
  `<!doctype html><html lang="${scenario.locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The workspace main area: a padded flex column the route fills.
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(scenario)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1280, height: 800, touch: false };

const open = async (view: View, scenario: Scenario, options: { javaScript?: boolean; theme?: "light" | "dark" } = {}) => {
  const id = `case${++caseCounter}`;
  pages.set(id, pageHtml(scenario, options.theme ?? "light"));
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    javaScriptEnabled: options.javaScript ?? true,
  });
  const page = await context.newPage();
  await page.goto(`${server.url}app/spaces/Space1?case=${id}${scenario.query ? `&${scenario.query.slice(1)}` : ""}`);
  await page.evaluate(() => window.document.fonts.ready);
  if (options.javaScript ?? true) await rendered(page);
  return page;
};
/** The island has replaced the server markup: hydrated icon buttons drop their server-only native title. */
const rendered = (page: Page) => page.waitForSelector('[data-spaces-kanban-fold][aria-expanded="true"]:not([title])', { timeout: 15_000 });

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element!.getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const board = window.document.querySelector('[role="region"]')!;
    const visible = (element: Element) => getComputedStyle(element).display !== "none";
    return {
      toolbar: box(window.document.querySelector("[data-spaces-board-toolbar]")),
      board: box(board),
      boardScroll: { width: board.scrollWidth, client: board.clientWidth },
      documentScroll: { width: window.document.documentElement.scrollWidth, client: window.document.documentElement.clientWidth },
      columns: Array.from(board.querySelectorAll("section")).map(box),
      cards: Array.from(board.querySelectorAll("article")).map(box),
      /** How far a card's title sits below the card's top edge; its corner buttons must not push it down. */
      titleOffset: Math.round(
        board.querySelector("article p")!.getBoundingClientRect().top - board.querySelector("article")!.getBoundingClientRect().top,
      ),
      combinedFilter: visible(window.document.querySelector("[data-spaces-board-toolbar] .\\@4xl\\:hidden")!),
      separateFilters: visible(window.document.querySelector("[data-spaces-board-toolbar] .\\@4xl\\:flex")!),
    };
  });

describe("Spaces Kanban board in Chromium", () => {
  for (const [name, view] of [
    ["phone", phone],
    ["desktop", desktop],
  ] as const) {
    test(`${name}: the toolbar is one row and the board starts where the server put it`, async () => {
      const scenario: Scenario = { locale: "de", folded: ["column:Col003"] };
      const before = await open(view, scenario, { javaScript: false });
      const server = await layout(before);
      await before.context().close();
      const page = await open(view, scenario);
      try {
        const client = await layout(page);
        expect(client).toEqual(server);
        // One toolbar row, the height of a filter field, holds search, filters, and the shortcut hint.
        expect(client.toolbar.height).toBeLessThanOrEqual(40);
        expect(client.titleOffset).toBeLessThanOrEqual(12);
        expect(client.board.top).toBeLessThanOrEqual(client.toolbar.top + client.toolbar.height + 8);
        expect(client.documentScroll.width).toBe(client.documentScroll.client);
        expect(client.combinedFilter).toBe(view === phone);
        expect(client.separateFilters).toBe(view === desktop);
        // The folded column is a narrow strip; open columns keep their width and scroll sideways on a phone.
        expect(client.columns.map((column) => column.width)).toEqual([288, 288, 40, 288]);
        if (view === phone) expect(client.boardScroll.width).toBeGreaterThan(client.boardScroll.client);
        expect(await page.locator('[role="region"]').getAttribute("aria-describedby")).toBe("spaces-kanban-shortcuts-Space1");
        expect(await page.locator("#spaces-kanban-shortcuts-Space1").textContent()).toContain("Pfeiltasten");
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("hovering cards and columns moves nothing", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      const at = await layout(page);
      await page.locator("article").first().hover();
      expect(await layout(page)).toEqual(at);
      await page.locator('[data-spaces-kanban-fold="column:Col002"]').hover();
      expect(await layout(page)).toEqual(at);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a column folds and unfolds by keyboard, keeps focus, and remembers it in the settings cookie", async () => {
    const page = await open(phone, { locale: "en" });
    try {
      const fold = page.locator('[data-spaces-kanban-fold="column:Col002"]');
      await fold.focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-spaces-kanban-fold="column:Col002"][aria-expanded="false"]');
      expect(await page.evaluate(() => window.document.activeElement?.getAttribute("data-spaces-kanban-fold"))).toBe("column:Col002");
      expect(await fold.getAttribute("aria-label")).toBe("Unfold In progress, 2 items");
      const settings = async () => {
        const cookie = (await page.context().cookies()).find((entry) => entry.name === "settings-app-spaces");
        return cookie ? JSON.parse(decodeURIComponent(cookie.value)).spaces.Space1 : undefined;
      };
      expect((await settings())?.foldedColumns).toEqual(["column:Col002"]);
      expect(await page.locator('[data-bucket-key="column:Col002"]').count()).toBe(0);

      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-spaces-kanban-fold="column:Col002"][aria-expanded="true"]');
      expect(await page.evaluate(() => window.document.activeElement?.getAttribute("data-spaces-kanban-fold"))).toBe("column:Col002");
      expect((await settings())?.foldedColumns).toBeUndefined();
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("arrow keys skip a folded column", async () => {
    const page = await open(desktop, { locale: "en", folded: ["column:Col002"] });
    try {
      await page.locator('[data-item-id="Item01"]').focus();
      await page.keyboard.press("ArrowRight");
      expect(await page.evaluate(() => (window.document.activeElement as HTMLElement | null)?.dataset.itemId)).toBe("Item06");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a card dropped on a folded column moves to the top of that column", async () => {
    const page = await open(desktop, { locale: "en", folded: ["column:Col003"] });
    try {
      moves.splice(0);
      const card = page.locator("article").filter({ hasText: "Ask the bakery" });
      await card.hover();
      const handle = card.locator("[data-dnd-card-handle]");
      const from = (await handle.boundingBox())!;
      const to = (await page.locator('[data-spaces-kanban-fold="column:Col003"]').boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(
          from.x + ((to.x + to.width / 2 - from.x) * step) / 12,
          from.y + ((to.y + to.height / 2 - from.y) * step) / 12,
        );
      }
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item02/move"));
      await page.mouse.up();
      await moved;
      expect(moves).toEqual([{ columnId: "Col003", beforeItemId: "Item06", completed: false }]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a filter loads the narrowed board in place, keeps it in the URL, and counts what it hides", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      await page.getByRole("button", { name: "Assignment" }).click();
      await page.getByRole("menuitemradio", { name: "Assigned to me" }).click();
      await page.waitForURL((url) => url.searchParams.get("assignedTo") === "me");
      await page.keyboard.press("Escape");
      expect(await page.locator('[role="region"] header > span[title] > [aria-hidden="true"]').allTextContents()).toEqual([
        "1/3",
        "1/2",
        "0/1",
        "0/1",
      ]);
      expect(await page.locator('[role="region"] section').nth(2).textContent()).toContain("No matching items");
      expect(await page.locator("[data-spaces-kanban-card]").first().getAttribute("href")).toBe(
        "/app/spaces/Space1?assignedTo=me&item=Item01",
      );
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
