import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ItemFilterSchema, type SpaceColumn, type SpaceItem, type SpaceWormhole } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import type { KanbanBucketInitial } from "./types";

// Where the board starts, whether the toolbar stays one row, and how a folded column takes a drop are
// layout questions, so the route renders on the server and then runs its real island bundle in a real browser,
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
const kim = { id: "22222222-2222-4222-8222-222222222222", displayName: "Kim Example", avatarHash: null };
const items = [
  item("Item01", "Col001", "Order banners for the spring fair", { assignees: [me], priority: "high" }),
  item("Item02", "Col001", "Ask the bakery about a stand"),
  item("Item03", "Col001", "Draft the volunteer schedule", { description: "Two shifts per day, one lead per shift." }),
  item("Item04", "Col002", "Book the stage", {
    assignees: [me, kim],
    claim: {
      id: "44444444-4444-4444-8444-444444444444",
      actor: { kind: "user", id: kim.id },
      displayName: kim.displayName,
      avatarHash: null,
      claimedAt: "2026-10-01T08:00:00.000Z",
    },
  }),
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

// A board with both automatic columns: Blocked after "To do", Overdue before "Done".
const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const waiting = [
  item("Item08", "Col001", "Hang the signs", { activeBlockerCount: 1 }),
  item("Item09", "Col002", "Pay the deposit", { deadline: yesterday }),
  item("Item10", "Col003", "Print the badges", { activeBlockerCount: 2, deadline: yesterday }),
];
const allItems = [...items, ...waiting];
const isBlocked = (entry: SpaceItem) => !entry.completedAt && entry.activeBlockerCount > 0;
const isOverdue = (entry: SpaceItem) => !entry.completedAt && entry.deadline !== null && !isBlocked(entry);
const bucket = (
  base: Pick<KanbanBucketInitial, "key" | "label" | "color" | "kind" | "columnId" | "isDone">,
  shown: SpaceItem[],
): KanbanBucketInitial => ({ ...base, items: shown, page: 1, totalPages: shown.length > 0 ? 1 : 0, total: shown.length });
const statusBucket = (column: SpaceColumn) =>
  bucket(
    { key: `column:${column.id}`, label: column.name, color: column.color, kind: "column", columnId: column.id, isDone: column.isDone },
    allItems.filter((entry) => entry.columnId === column.id && !isBlocked(entry) && !isOverdue(entry)),
  );
const blockedBucket = (label: string) =>
  bucket({ key: "virtual:blocked", label, color: null, kind: "blocked", columnId: null, isDone: false }, allItems.filter(isBlocked));
const overdueBucket = (label: string) =>
  bucket({ key: "virtual:overdue", label, color: null, kind: "overdue", columnId: null, isDone: false }, allItems.filter(isOverdue));
const withAutomaticColumns = (locale: "en" | "de" = "en") => [
  statusBucket(columns[0]!),
  blockedBucket(locale === "de" ? "Blockiert" : "Blocked"),
  statusBucket(columns[1]!),
  statusBucket(columns[2]!),
  overdueBucket(locale === "de" ? "Überfällig" : "Overdue"),
  statusBucket(columns[3]!),
];
// A Wormhole to another Space; the board shows the Wormholes section after the last column.
const wormhole: SpaceWormhole = {
  id: "Worm01",
  sourceSpaceId: "Space1",
  color: "#10b981",
  rank: "1",
  target: {
    spaceId: "Space2",
    spaceName: "Fair logistics",
    spaceColor: "#10b981",
    columnId: "Col101",
    columnName: "Inbox",
    columnIsDone: false,
  },
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
};
const assignedToMe = () => bucketsFor((entry) => entry.assignees?.some((assignee) => assignee.id === me.id) ?? false);

type Scenario = {
  locale: "en" | "de";
  query?: string;
  folded?: string[];
  buckets?: KanbanBucketInitial[];
  canWrite?: boolean;
  wormholes?: SpaceWormhole[];
};
const serverBody = (scenario: Scenario) =>
  renderToString(() =>
    createComponent(KanbanFixture, {
      locale: scenario.locale,
      spaceId: "Space1",
      baseUrl: `/app/spaces/Space1${scenario.query ?? ""}`,
      columns,
      tags: [{ id: "Tag001", spaceId: "Space1", name: "Logistics", color: "#0ea5e9" }],
      wormholes: scenario.wormholes ?? [],
      initialBuckets: scenario.buckets ?? unfiltered(),
      foldedColumns: scenario.folded ?? [],
      selectedItemId: "",
      canWrite: scenario.canWrite ?? true,
      currentUserId: me.id,
    }),
  );

let css = "";
let server: ReturnType<typeof Bun.serve>;
const pages = new Map<string, string>();
const moves: unknown[] = [];
const filterRequests: unknown[] = [];
const columnOrders: unknown[] = [];
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
        const body = (await request.json()) as { columnId: string; completed?: boolean };
        moves.push(body);
        // As the real route: completion changes only when the request asks for it.
        const moved = allItems.find((entry) => entry.id === move[1])!;
        const completedAt = body.completed === undefined ? moved.completedAt : body.completed ? new Date().toISOString() : null;
        return Response.json({ ...moved, columnId: body.columnId, completedAt });
      }
      if (url.pathname === "/api/spaces/Space1/items/filter") {
        // As strict as the real route: the schema answers 400, a tag the Space does not have 404.
        const parsed = ItemFilterSchema.safeParse(await request.json());
        filterRequests.push(parsed.success ? parsed.data : null);
        if (!parsed.success) return Response.json({ message: "Invalid filter" }, { status: 400 });
        if (parsed.data.tagIds?.some((tagId) => tagId !== "Tag001")) return Response.json({ message: "Tag not found" }, { status: 404 });
        // A board with automatic columns asks for them by flag; a status column then leaves their tasks out.
        const automatic = parsed.data.blocked !== undefined || parsed.data.overdue !== undefined;
        const found = automatic
          ? parsed.data.blocked
            ? blockedBucket("Blocked")
            : parsed.data.overdue
              ? overdueBucket("Overdue")
              : statusBucket(columns.find((column) => column.id === parsed.data.columnIds?.[0])!)
          : unfiltered().find((entry) => entry.columnId === parsed.data.columnIds?.[0])!;
        return Response.json({ items: found.items, total: found.total, page: 1, pageSize: 30, totalPages: found.totalPages });
      }
      if (url.pathname === "/api/spaces/Space1/columns/order" && request.method === "PUT") {
        columnOrders.push(await request.json());
        return Response.json({ message: "Columns reordered" });
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
  browser = await launchBrowser();
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
      combinedFilter: visible(window.document.querySelector("[data-spaces-board-filter-menu]")!),
      separateFilters: visible(window.document.querySelector("[data-spaces-board-chips]")!),
    };
  });

/** Drags with the mouse in small steps, as a person does, and releases over the target's center. */
const drag = async (page: Page, from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(
      from.x + from.width / 2 + ((to.x - from.x - from.width / 2) * step) / 12,
      from.y + from.height / 2 + ((to.y - from.y - from.height / 2) * step) / 12,
    );
  }
};
const center = async (locator: ReturnType<Page["locator"]>) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const cardHandle = async (page: Page, title: string) => {
  const card = page.locator("article").filter({ hasText: title });
  await card.hover();
  return (await card.locator("[data-dnd-card-handle]").boundingBox())!;
};
const columnTitles = (page: Page) =>
  page
    .locator('[role="region"] section[data-spaces-kanban-column] h3')
    .evaluateAll((titles) => titles.map((title) => title.firstChild?.textContent ?? ""));
/** What the drag-and-drop live regions last told screen readers. */
const dragAnnouncements = (page: Page) => page.locator('body > [role="status"][aria-live="polite"]').allTextContents();
/** The toast rail; the live region repeats each toast's text for screen readers. */
const notifications = (page: Page, locale: "en" | "de" = "en") =>
  page.getByRole("region", { name: locale === "de" ? "Benachrichtigungen" : "Notifications" });
const cardsIn = (page: Page, key: string) =>
  page
    .locator(`[data-spaces-kanban-column="${key}"] [data-spaces-kanban-card]`)
    .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.itemId));

describe("Spaces Kanban board in a browser", () => {
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

  test("a card dropped on a folded column moves to the top of that column, also while a filter hides cards", async () => {
    const page = await open(desktop, { locale: "en", folded: ["column:Col003"], query: "?assignedTo=unassigned" });
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
      // No neighbor: the server puts the card at the top of the whole column, above cards a filter hides.
      expect(moves).toEqual([{ columnId: "Col003" }]);
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
  const allFilters = "?assignedTo=assigned&priority=urgent,high,medium,low&deadline=overdue&activity=inactive&tags=Tag001&q=banners";
  for (const locale of ["de", "en"] as const) {
    test(`${locale}: with every filter active, the toolbar keeps every control inside its row`, async () => {
      // The separate chips start at a 68rem toolbar; the page pads the toolbar by 8 px a side.
      for (const width of [900, 960, 1040, 1120, 1280]) {
        const page = await open({ width, height: 800, touch: false }, { locale, query: allFilters });
        try {
          const fit = await page.evaluate(() => {
            const toolbar = window.document.querySelector("[data-spaces-board-toolbar]")!;
            const right = toolbar.getBoundingClientRect().right;
            const chips = window.document.querySelector<HTMLElement>("[data-spaces-board-chips]")!;
            const controls = Array.from(toolbar.querySelectorAll("button, a, input")).filter(
              (control) => control.getBoundingClientRect().width > 0 && !chips.contains(control),
            );
            return {
              outside: controls.filter((control) => control.getBoundingClientRect().right > right + 0.5).length,
              separate: getComputedStyle(chips).display !== "none",
              chipsClipped: chips.scrollWidth > chips.clientWidth,
              clear: controls.some((control) => control.getAttribute("href") === "/app/spaces/Space1"),
            };
          });
          expect({ width, ...fit }).toEqual({ width, outside: 0, separate: width >= 1120, chipsClipped: false, clear: width >= 1120 });
        } finally {
          await page.context().close();
        }
      }
    }, 60_000);
  }

  test("desktop: applying a filter moves no other toolbar control", async () => {
    const page = await open({ width: 1280, height: 800, touch: false }, { locale: "de" });
    try {
      const positions = () =>
        page.evaluate(() =>
          Array.from(
            window.document.querySelectorAll(
              "[data-spaces-board-toolbar] form, [data-spaces-board-chips] > *, [data-spaces-kanban-shortcuts]",
            ),
          ).map((element) => {
            const rect = element.getBoundingClientRect();
            return [Math.round(rect.left), Math.round(rect.width)];
          }),
        );
      const before = await positions();
      await page.getByRole("button", { name: "Zuständigkeit" }).click();
      await page.getByRole("menuitemradio", { name: "Jemandem zugewiesen" }).click();
      await page.waitForURL((url) => url.searchParams.get("assignedTo") === "assigned");
      expect(await positions()).toEqual(before);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("phone: the first filter from the combined menu moves neither the search nor the menu button", async () => {
    const page = await open(phone, { locale: "de" });
    try {
      const positions = () =>
        page.evaluate(() =>
          Array.from(
            window.document.querySelectorAll(
              "[data-spaces-board-toolbar] form, [data-spaces-board-filter-menu], [data-spaces-kanban-shortcuts]",
            ),
          ).map((element) => {
            const rect = element.getBoundingClientRect();
            return [Math.round(rect.left), Math.round(rect.width)];
          }),
        );
      const before = await positions();
      await page.getByRole("button", { name: "Filter" }).tap();
      await page.getByRole("menuitemradio", { name: "Mir zugewiesen" }).tap();
      await page.waitForURL((url) => url.searchParams.get("assignedTo") === "me");
      expect(await positions()).toEqual(before);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("filter values the API would reject do not break a column refresh", async () => {
    const page = await open(desktop, { locale: "en", query: "?tags=Gone01&assignedTo=bogus&priority=Urgent&deadline=soon" });
    try {
      filterRequests.splice(0);
      const refreshed = page.waitForResponse((response) => response.url().endsWith("/items/filter"));
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("spaces-data-invalidated", { detail: { domains: ["view"], cursor: null, itemId: null, cover: () => undefined } }),
        ),
      );
      await refreshed;
      await page.waitForFunction(() => !window.document.querySelector('[role="region"] button.text-red-600'));
      // Nothing valid remains of the URL filter, so the board is unfiltered: one plain page per column.
      expect(filterRequests).toHaveLength(4);
      for (const request of filterRequests) expect(request).toMatchObject({ assignedTo: "all", deadlineFilter: "all" });
      expect(
        filterRequests.some((request) => (request as { tagIds?: string[] }).tagIds || (request as { priority?: string[] }).priority),
      ).toBe(false);
      expect(await page.locator('[role="region"] button.text-red-600').count()).toBe(0);
      expect(await page.locator("[data-spaces-board-chips] [data-active]").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const canWrite of [true, false]) {
    test(`the shortcuts button opens the list on a tap and names ${canWrite ? "the edit shortcuts" : "no edit shortcuts for a reader"}`, async () => {
      const page = await open(phone, { locale: "en", canWrite });
      try {
        await page.locator("[data-spaces-kanban-shortcuts]").tap();
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await dialog.waitFor();
        expect(await dialog.textContent()).toContain("Open the card");
        expect((await dialog.textContent())?.includes("Assign it to you")).toBe(canWrite);
        // The board's own description for screen readers names the same shortcuts.
        expect((await page.locator("#spaces-kanban-shortcuts-Space1").textContent())?.includes("M assigns")).toBe(canWrite);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
  test("automatic columns show blocked and overdue tasks only there, with the status as a badge; Blocked wins", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      expect(await columnTitles(page)).toEqual(["To do", "Blocked", "In progress", "Review", "Overdue", "Done"]);
      expect(await cardsIn(page, "virtual:blocked")).toEqual(["Item08", "Item10"]);
      expect(await cardsIn(page, "virtual:overdue")).toEqual(["Item09"]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item02", "Item03"]);
      expect(await cardsIn(page, "column:Col003")).toEqual(["Item06"]);
      expect(await page.locator('[role="region"] header > span[title] > [aria-hidden="true"]').allTextContents()).toEqual([
        "3",
        "2",
        "2",
        "1",
        "1",
        "1",
      ]);
      const badge = (id: string) => page.locator(`article:has([data-item-id="${id}"]) [data-spaces-kanban-card-status]`);
      expect(await badge("Item08").getAttribute("title")).toBe("Status: To do");
      expect(await badge("Item10").getAttribute("title")).toBe("Status: Review");
      expect(await badge("Item09").getAttribute("title")).toBe("Status: In progress");
      expect(await badge("Item01").count()).toBe(0);
      // Blocked wins; the overdue state stays visible as a badge there, and only there.
      expect(await page.locator('article:has([data-item-id="Item10"]) [data-spaces-kanban-card-overdue]').count()).toBe(1);
      expect(await page.locator('article:has([data-item-id="Item09"]) [data-spaces-kanban-card-overdue]').count()).toBe(0);

      // Hovering a column header or its menu moves nothing.
      const at = await layout(page);
      await page.locator('[data-spaces-kanban-column="virtual:blocked"] [data-spaces-kanban-column-handle]').hover();
      expect(await layout(page)).toEqual(at);
      await page.locator('[data-spaces-kanban-column-menu="virtual:blocked"]').hover();
      expect(await layout(page)).toEqual(at);

      // Arrow keys walk through an automatic column like any other.
      await page.locator('[data-item-id="Item01"]').focus();
      await page.keyboard.press("ArrowRight");
      expect(await page.evaluate(() => (window.document.activeElement as HTMLElement | null)?.dataset.itemId)).toBe("Item08");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an automatic column refuses a dropped card and says so", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      moves.splice(0);
      await drag(
        page,
        await cardHandle(page, "Ask the bakery"),
        await center(page.locator('[data-spaces-kanban-column="virtual:blocked"] article').first()),
      );
      await page.waitForSelector('[data-spaces-kanban-column="virtual:blocked"] [data-spaces-kanban-no-drop]');
      expect(await page.locator("[data-spaces-kanban-no-drop]").textContent()).toContain("Cards can't be dropped here");
      expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(0);
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(moves).toEqual([]);
      expect(await page.locator("[data-spaces-kanban-no-drop]").count()).toBe(0);
      expect(await cardsIn(page, "column:Col001")).toContain("Item02");
      // Screen readers hear that nothing moved, not that the card was dropped.
      expect(await dragAnnouncements(page)).toContain("Ask the bakery about a stand not moved; Blocked fills itself");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: a task someone else claimed moves between open statuses as it is, and into done after one take-over question`, async () => {
      const de = locale === "de";
      const page = await open(desktop, { locale });
      const question = page.getByRole("dialog", { name: de ? "Aufgabe übernehmen" : "Take over task" });
      const toDone = async () =>
        drag(
          page,
          await cardHandle(page, "Book the stage"),
          await center(page.locator('[data-spaces-kanban-column="column:Col004"] article').first()),
        );
      try {
        moves.splice(0);
        const before = await layout(page);
        await toDone();
        // Claims coordinate work and do not lock it: the done status takes the drop.
        expect(await page.locator("[data-spaces-kanban-no-drop]").count()).toBe(0);
        await page.mouse.up();
        await question.waitFor();
        expect(await question.textContent()).toContain(
          de ? "Von Kim Example übernommen – übernehmen und abschließen?" : "Claimed by Kim Example – take over and complete?",
        );
        // Cancel: nothing is saved, the card is back where it was, nothing moved, and nothing reports an error.
        await question.getByRole("button", { name: de ? "Abbrechen" : "Cancel" }).click();
        await question.waitFor({ state: "detached" });
        await page.waitForTimeout(200);
        expect(moves).toEqual([]);
        expect(await cardsIn(page, "column:Col002")).toEqual(["Item04", "Item05"]);
        const after = await layout(page);
        expect({ cards: after.cards, columns: after.columns }).toEqual({ cards: before.cards, columns: before.columns });
        expect(await page.locator("[data-k2b-toast]").count()).toBe(0);

        // Between open statuses the claim does not matter, and the move sends no completion state at all.
        await drag(
          page,
          await cardHandle(page, "Book the stage"),
          await center(page.locator('[data-spaces-kanban-column="column:Col003"] article').first()),
        );
        const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item04/move"));
        await page.mouse.up();
        await moved;
        expect(await question.count()).toBe(0);
        expect(moves).toEqual([{ columnId: "Col003", beforeItemId: "Item06" }]);

        // Confirm: the claim is taken over and the task completed in the same request.
        await toDone();
        await page.mouse.up();
        await question.waitFor();
        const completed = page.waitForResponse((response) => response.url().endsWith("/items/Item04/move"));
        await question.getByRole("button", { name: de ? "Übernehmen und abschließen" : "Take over and complete" }).click();
        await completed;
        expect(moves[1]).toMatchObject({
          columnId: "Col004",
          completed: true,
          claimId: "44444444-4444-4444-8444-444444444444",
          force: true,
        });
        await page.waitForFunction(() => document.querySelector('[data-spaces-kanban-column="column:Col004"] [data-item-id="Item04"]'));
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a card picked up in an automatic column is not refused there and has no target over the status it has", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      moves.splice(0);
      const handle = await cardHandle(page, "Hang the signs");
      await drag(page, handle, { x: handle.x + 30, y: handle.y + 60 });
      expect(await page.locator("[data-spaces-kanban-no-drop]").count()).toBe(0);
      // Over "To do", the status it already has: no drop line, no highlighted column, and nothing saved.
      const own = await center(page.locator('[data-spaces-kanban-column="column:Col001"] article').first());
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(handle.x + 30 + ((own.x - handle.x - 30) * step) / 12, handle.y + 60 + ((own.y - handle.y - 60) * step) / 12);
      }
      expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(0);
      expect(await page.locator('[data-spaces-kanban-column="column:Col001"] .bg-\\[var\\(--ui-selected\\)\\]').count()).toBe(0);
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(moves).toEqual([]);
      expect(await dragAnnouncements(page)).toContain("Hang the signs not moved");
      expect(await cardsIn(page, "virtual:blocked")).toEqual(["Item08", "Item10"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a card dragged out of Blocked into an open status stays there with its new status; one done leaves Overdue", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      moves.splice(0);
      await drag(
        page,
        await cardHandle(page, "Hang the signs"),
        await center(page.locator('[data-spaces-kanban-column="column:Col002"] article').first()),
      );
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item08/move"));
      await page.mouse.up();
      await moved;
      expect(moves).toEqual([{ columnId: "Col002", beforeItemId: "Item04" }]);
      await notifications(page).getByText("Moved to In progress. It shows under Blocked until its blockers are done.").waitFor();
      expect(await cardsIn(page, "virtual:blocked")).toEqual(["Item08", "Item10"]);
      expect(await page.locator('article:has([data-item-id="Item08"]) [data-spaces-kanban-card-status]').getAttribute("title")).toBe(
        "Status: In progress",
      );
      expect(await cardsIn(page, "column:Col002")).toEqual(["Item04", "Item05"]);

      await drag(
        page,
        await cardHandle(page, "Pay the deposit"),
        await center(page.locator('[data-spaces-kanban-column="column:Col004"] article').first()),
      );
      const completed = page.waitForResponse((response) => response.url().endsWith("/items/Item09/move"));
      await page.mouse.up();
      await completed;
      expect(moves.at(-1)).toMatchObject({ columnId: "Col004", completed: true });
      await page.waitForFunction(
        () => !window.document.querySelector('[data-spaces-kanban-column="virtual:overdue"] [data-item-id="Item09"]'),
      );
      expect(await cardsIn(page, "column:Col004")).toContain("Item09");

      // Reopened while its deadline is still past, it goes straight back to Overdue and says why.
      await drag(
        page,
        await cardHandle(page, "Pay the deposit"),
        await center(page.locator('[data-spaces-kanban-column="column:Col002"] article').first()),
      );
      const reopened = page.waitForResponse((response) => response.url().endsWith("/items/Item09/move"));
      await page.mouse.up();
      // It lands in Overdue, not in the status it was dropped on.
      await page.waitForSelector('[data-spaces-kanban-column="virtual:overdue"] [data-item-id="Item09"]');
      expect(await cardsIn(page, "column:Col002")).toEqual(["Item04", "Item05"]);
      await reopened;
      expect(moves.at(-1)).toMatchObject({ columnId: "Col002", completed: false });
      await notifications(page).getByText("Moved to In progress. It shows under Overdue until it is done.").waitFor();
      expect(await cardsIn(page, "virtual:overdue")).toEqual(["Item09"]);
      expect(await cardsIn(page, "column:Col004")).not.toContain("Item09");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("people who may change statuses reorder columns by dragging a header, for everyone", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      columnOrders.splice(0);
      const handle = page.locator('[data-spaces-kanban-column="column:Col003"] [data-spaces-kanban-column-handle]');
      const target = (await page.locator('[data-spaces-kanban-column="column:Col001"]').boundingBox())!;
      await drag(page, (await handle.boundingBox())!, { x: target.x + 20, y: target.y + 40 });
      await page.waitForSelector("[data-spaces-kanban-column-drop-indicator]");
      const saved = page.waitForResponse((response) => response.url().endsWith("/columns/order"));
      await page.mouse.up();
      await saved;
      expect(columnOrders).toEqual([{ columnIds: ["Col003", "Col001", "blocked", "Col002", "overdue", "Col004"] }]);
      expect(await columnTitles(page)).toEqual(["Review", "To do", "Blocked", "In progress", "Overdue", "Done"]);
      expect(await page.locator("[data-spaces-kanban-column-drop-indicator]").count()).toBe(0);
      // Screen readers hear the saved move, not that the column stayed where it was.
      await page.waitForFunction(() => window.document.querySelector("[data-spaces-kanban-column-status]")?.textContent !== "");
      expect(await page.locator("[data-spaces-kanban-column-status]").textContent()).toBe("Review is now column 1 of 6");
      expect(await dragAnnouncements(page)).not.toContain("Column Review not moved");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a dragged column's drop line sits centred in the gap, also next to folded and automatic columns and before the Wormholes, and moves nothing", async () => {
    // Each drag skips the two places beside the column itself, so two drags reach every place. With Wormholes shown,
    // only the end changes: a real gap then follows the last column.
    const variants = [
      {
        wormholes: [],
        drags: [
          ["column:Col004", [0, 1, 2, 3, 4]],
          ["column:Col001", [2, 3, 4, 5, 6]],
        ],
      },
      { wormholes: [wormhole], drags: [["column:Col001", [5, 6]]] },
    ] as const;
    for (const { wormholes, drags } of variants) {
      // Wide enough for the whole board: To do | Blocked (folded) | In progress (folded) | Review | Overdue | Done.
      const page = await open(
        { width: 1440, height: 900, touch: false },
        { locale: "en", buckets: withAutomaticColumns(), folded: ["virtual:blocked", "column:Col002"], wormholes: [...wormholes] },
      );
      try {
        const boxes = () =>
          page.locator('[role="region"] section[data-spaces-kanban-column]').evaluateAll((sections) =>
            sections.map((section) => {
              const rect = section.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
            }),
          );
        columnOrders.splice(0);
        const before = await boxes();
        expect(before.length).toBe(6);
        const wormholesLeft = await page
          .locator('[role="region"] section:not([data-spaces-kanban-column])')
          .evaluateAll((sections) => sections.map((section) => section.getBoundingClientRect().left));
        expect(wormholesLeft.length).toBe(wormholes.length);
        // Between two neighbours the line's centre is the gap's midpoint; at the board's ends it lies on the outer column edge.
        const expected = (index: number) =>
          index === 0
            ? before[0]!.left + 1
            : index === before.length
              ? wormholesLeft.length > 0
                ? (before.at(-1)!.right + wormholesLeft[0]!) / 2
                : before.at(-1)!.right - 1
              : (before[index - 1]!.right + before[index]!.left) / 2;
        const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const misplaced: unknown[] = [];
        const shifted: unknown[] = [];
        for (const [key, indices] of drags) {
          const handle = (await page.locator(`[data-spaces-kanban-column="${key}"] [data-spaces-kanban-column-handle]`).boundingBox())!;
          await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
          await page.mouse.down();
          for (const index of indices) {
            const x = index < before.length ? before[index]!.left + 6 : before.at(-1)!.right - 6;
            await page.mouse.move(x, before[0]!.top + 80, { steps: 10 });
            await frames();
            const lines = await page
              .locator("[data-spaces-kanban-column-drop-indicator]")
              .evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect()).map((rect) => rect.left + rect.width / 2),
              );
            if (lines.length !== 1 || Math.abs(lines[0]! - expected(index)) > 1)
              misplaced.push({ key, index, lines, expected: expected(index) });
            if (JSON.stringify(await boxes()) !== JSON.stringify(before)) shifted.push({ key, index });
          }
          // Released over its own place, the column stays and the order is not saved.
          await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2, { steps: 10 });
          await frames();
          await page.mouse.up();
          await frames();
        }
        expect({ wormholes: wormholes.length, misplaced, shifted }).toEqual({ wormholes: wormholes.length, misplaced: [], shifted: [] });
        expect(columnOrders).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  test("a card previews a Markdown description as plain text and still clamps it to three lines", async () => {
    const raffle = item("Item11", "Col001", "Plan the raffle", {
      description: `**Goal:** sell every ticket before noon

## Prizes
- [ ] Ask the \`bike shop\` for a voucher
- See [the list](https://example.com/prizes) and _confirm_ the hamper

${"Keep the stand calm and friendly. ".repeat(8)}`,
    });
    const buckets = unfiltered().map((entry) =>
      entry.key === "column:Col001" ? { ...entry, items: [raffle, ...entry.items], total: entry.total + 1 } : entry,
    );
    const visible =
      "Goal: sell every ticket before noon Prizes Ask the bike shop for a voucher See the list and confirm the hamper Keep the stand";
    for (const javaScript of [false, true]) {
      const page = await open(desktop, { locale: "en", buckets }, { javaScript });
      try {
        const preview = await page.locator('[data-spaces-kanban-card][data-item-id="Item11"] p.line-clamp-3').evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            text: element.textContent,
            lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight)),
            clipped: element.scrollHeight > element.clientHeight,
          };
        });
        expect({ ...preview, text: preview.text?.slice(0, visible.length) }).toEqual({ text: visible, lines: 3, clipped: true });
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  test("keyboard: a column header menu moves a column, announces it, and keeps focus", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      columnOrders.splice(0);
      const menu = page.locator('[data-spaces-kanban-column-menu="virtual:blocked"]');
      await menu.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move right" }).waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.document.querySelector("[data-spaces-kanban-column-status]")?.textContent !== "");
      expect(columnOrders).toEqual([{ columnIds: ["Col001", "Col002", "blocked", "Col003", "overdue", "Col004"] }]);
      expect(await columnTitles(page)).toEqual(["To do", "In progress", "Blocked", "Review", "Overdue", "Done"]);
      expect(await page.locator("[data-spaces-kanban-column-status]").textContent()).toBe("Blocked is now column 3 of 6");
      await page.waitForFunction(() => window.document.activeElement?.getAttribute("data-spaces-kanban-column-menu") === "virtual:blocked");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("readers get no drag affordance and no column menu", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns(), canWrite: false });
    try {
      expect(await page.locator("[data-spaces-kanban-column-handle]").count()).toBe(0);
      expect(await page.locator("[data-spaces-kanban-column-menu]").count()).toBe(0);
      expect(await page.locator("[data-dnd-card-handle]").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a folded automatic column is a narrow strip that refuses drops", async () => {
    const page = await open(desktop, { locale: "de", buckets: withAutomaticColumns("de"), folded: ["virtual:blocked"] });
    try {
      moves.splice(0);
      const strip = page.locator('[data-spaces-kanban-fold="virtual:blocked"]');
      expect(await strip.getAttribute("aria-label")).toBe("Blockiert ausklappen, 2 Einträge");
      expect((await page.locator('[data-spaces-kanban-column="virtual:blocked"]').boundingBox())!.width).toBe(40);
      await drag(page, await cardHandle(page, "Ask the bakery"), await center(strip));
      await page.waitForSelector('[data-spaces-kanban-fold="virtual:blocked"][data-spaces-kanban-no-drop]');
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(moves).toEqual([]);
      expect(await dragAnnouncements(page)).toContain("Ask the bakery about a stand nicht verschoben; Blockiert füllt sich von selbst");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("phone: automatic columns and their header controls fit at 390 px, and the column menu works by tap", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await open(phone, { locale: "de", buckets: withAutomaticColumns("de") }, { theme });
      try {
        const fit = await page.evaluate(() => {
          const sections = Array.from(window.document.querySelectorAll<HTMLElement>('[role="region"] section[data-spaces-kanban-column]'));
          return {
            documentOverflow: window.document.documentElement.scrollWidth > window.document.documentElement.clientWidth,
            widths: sections.map((section) => Math.round(section.getBoundingClientRect().width)),
            headerOverflow: sections.some((section) => {
              const header = section.querySelector("header")!;
              const right = header.getBoundingClientRect().right;
              return Array.from(header.querySelectorAll("button")).some((button) => button.getBoundingClientRect().right > right + 0.5);
            }),
            headerHeights: [
              ...new Set(sections.map((section) => Math.round(section.querySelector("header")!.getBoundingClientRect().height))),
            ],
          };
        });
        expect(fit).toEqual({
          documentOverflow: false,
          widths: [288, 288, 288, 288, 288, 288],
          headerOverflow: false,
          headerHeights: [fit.headerHeights[0]!],
        });

        columnOrders.splice(0);
        await page.locator('[data-spaces-kanban-column-menu="virtual:blocked"]').tap();
        await page.getByRole("menuitem", { name: "Nach rechts verschieben" }).tap();
        await page.waitForFunction(() => window.document.querySelector("[data-spaces-kanban-column-status]")?.textContent !== "");
        expect(columnOrders).toEqual([{ columnIds: ["Col001", "Col002", "blocked", "Col003", "overdue", "Col004"] }]);
        expect(await columnTitles(page)).toEqual(["To do", "In progress", "Blockiert", "Review", "Überfällig", "Done"]);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  test("the worker's ring on a card stays whole beside the next avatar and keeps the avatar size", async () => {
    for (const [view, theme] of [
      [desktop, "light"],
      [phone, "dark"],
    ] as const) {
      const page = await open(view, { locale: "en" }, { theme });
      try {
        const card = page.locator('[data-item-id="Item04"]');
        await card.scrollIntoViewIfNeeded();
        const area = (await page.locator("article", { has: card }).boundingBox())!;
        await page.screenshot({
          path: `/tmp/spaces-kanban-claim-card-${view.width}-${theme}.png`,
          clip: { x: area.x - 8, y: area.y - 8, width: area.width + 16, height: area.height + 16 },
        });
        const stack = await card.evaluate((element) => {
          const holder = element.querySelector("[data-spaces-claim-badge] .k2b-avatar")!;
          const holderBox = holder.getBoundingClientRect();
          const next = holder.closest("[data-spaces-claim-badge]")!.nextElementSibling!.getBoundingClientRect();
          // No ancestor up to the card clips the ring that reaches 4 px past the avatar.
          const clipped = [] as string[];
          for (let node = holder.parentElement; node && node !== element.parentElement; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.overflow === "visible") continue;
            const box = node.getBoundingClientRect();
            if (
              holderBox.left - 4 < box.left ||
              holderBox.right + 4 > box.right ||
              holderBox.top - 4 < box.top ||
              holderBox.bottom + 4 > box.bottom
            )
              clipped.push(node.className);
          }
          return {
            clipped,
            ring: (() => {
              const style = getComputedStyle(holder);
              // An outline leaves the gap transparent, so it matches the card when hovered or selected.
              return [style.outlineStyle, style.outlineWidth, style.outlineOffset, style.boxShadow].join(" ");
            })(),
            sizes: [holderBox.width, next.width],
            // The ring reaches 4 px past the avatar; the next avatar starts at the ring's outer edge.
            gap: Math.round(next.left - holderBox.right),
          };
        });
        expect(stack.clipped).toEqual([]);
        expect(stack.ring).toBe("solid 2px 2px none");
        expect(stack.sizes[0]).toBe(stack.sizes[1]);
        expect(stack.gap).toBe(4);
        const before = await layout(page);
        await card.hover();
        expect(await layout(page)).toEqual(before);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  // A swipe through the browser's touch pipeline needs Chromium's input protocol: Playwright drives WebKit's touch
  // input only as a whole tap.
  test.skipIf(browserName === "webkit")(
    "phone: a swipe that starts on a column title scrolls the board and never reorders it",
    async () => {
      const page = await open(phone, { locale: "en", buckets: withAutomaticColumns() });
      try {
        columnOrders.splice(0);
        const board = page.locator('[role="region"]');
        await board.evaluate((element) => {
          element.scrollLeft = 100;
        });
        const title = (await page.locator('[data-spaces-kanban-column="virtual:blocked"] h3').boundingBox())!;
        const y = title.y + title.height / 2;
        let x = Math.min(title.x + title.width - 8, 380);
        // A plain swipe through the browser's touch pipeline, no hold: one finger moving left in small steps.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let step = 0; step < 15; step++) {
          x -= 24;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
          await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(300);
        expect(columnOrders).toEqual([]);
        expect(await columnTitles(page)).toEqual(["To do", "Blocked", "In progress", "Review", "Overdue", "Done"]);
        expect(await board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );
});
