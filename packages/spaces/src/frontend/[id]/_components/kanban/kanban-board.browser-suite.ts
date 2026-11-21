import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ItemFilterSchema, type SpaceColumn, type SpaceItem, type SpaceItemReaction, type SpaceWormhole } from "@/contracts";
import { browserName, hoverInPlace, keptThrough, launchBrowser, storedCookie } from "../../../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";
import { kanbanBrowserPart as selectedPart } from "../../../../../test/kanban-browser";
import type { KanbanBucketInitial } from "./types";

// Where the board starts, whether the toolbar stays one row, and how a folded column takes a drop are
// layout questions, so the route renders on the server and then runs its real island bundle in a real browser,
// as the workspace page does. The island bundle resolves Solid from its root, so the scratch root sits
// inside this package's dependencies.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-kanban-browser-"));
const workspaceDir = resolve(import.meta.dir, "../workspace");
registerSsrTestPlugin({
  dev: false,
  verbose: false,
  rootDir: root,
  componentRoots: [workspaceDir, resolve(import.meta.dir, "../filter")],
});

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
  deadlineAllDay: false,
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
const me = { id: "11111111-1111-4111-8111-111111111111", kind: "user" as const, displayName: "Robin Example", avatarHash: null };
const kim = { id: "22222222-2222-4222-8222-222222222222", kind: "user" as const, displayName: "Kim Example", avatarHash: null };
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
let claimedItem: SpaceItem | null = null;
const bucketsFor = (filter?: (entry: SpaceItem) => boolean): KanbanBucketInitial[] =>
  columns.map((column) => {
    const all = items.map((entry) => (entry.id === claimedItem?.id ? claimedItem : entry)).filter((entry) => entry.columnId === column.id);
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
const assignedToMe = () =>
  bucketsFor((entry) => entry.assignees?.some((assignee) => assignee.kind === "user" && assignee.id === me.id) ?? false);

const workspaceColumns: SpaceColumn[] = Array.from({ length: 8 }, (_, index) => ({
  ...columns[index % columns.length]!,
  id: `Column${index}`,
  name: `Project phase ${index + 1}`,
  rank: String(index),
}));
const workspaceItems = Array.from({ length: 80 }, (_, index) =>
  item(`WorkspaceItem${index}`, workspaceColumns[index % workspaceColumns.length]!.id, `Website relaunch task ${index + 1}`),
);
const workspaceBuckets: KanbanBucketInitial[] = workspaceColumns.map((column) =>
  bucket(
    { key: `column:${column.id}`, label: column.name, color: column.color, kind: "column", columnId: column.id, isDone: column.isDone },
    workspaceItems.filter((entry) => entry.columnId === column.id),
  ),
);

type Scenario = {
  workspace?: "kanban" | "table";
  now?: string;
  locale: "en" | "de";
  query?: string;
  folded?: string[];
  buckets?: KanbanBucketInitial[];
  canWrite?: boolean;
  wormholes?: SpaceWormhole[];
  /** Column reloads answer with these buckets and the reactions saved so far, as the real route reads them. */
  served?: boolean;
};
const serverBody = (scenario: Scenario) => {
  if (scenario.now) setSystemTime(new Date(scenario.now));
  try {
    return renderToString(() =>
      createComponent(KanbanFixture, {
        locale: scenario.locale,
        spaceId: "Space1",
        baseUrl: `/app/spaces/Space1${scenario.query ?? ""}`,
        columns: scenario.workspace ? workspaceColumns : columns,
        workspace: scenario.workspace,
        itemsResult: scenario.workspace
          ? { items: workspaceItems, total: workspaceItems.length, page: 1, pageSize: 80, totalPages: 1, groupCounts: {} }
          : undefined,
        tags: [{ id: "Tag001", spaceId: "Space1", name: "Logistics", color: "#0ea5e9" }],
        wormholes: scenario.wormholes ?? [],
        initialBuckets: scenario.workspace ? workspaceBuckets : (scenario.buckets ?? unfiltered()),
        foldedColumns: scenario.folded ?? [],
        selectedItemId: "",
        canWrite: scenario.canWrite ?? true,
        currentUserId: me.id,
      }),
    );
  } finally {
    if (scenario.now) setSystemTime();
  }
};

let css = "";
let server: ReturnType<typeof Bun.serve>;
const pages = new Map<string, string>();
const moves: unknown[] = [];
const filterRequests: unknown[] = [];
const columnOrders: unknown[] = [];
const reactionRequests: Array<{ method: string; item: string; emoji: string }> = [];
const reactionSummaries = new Map<string, SpaceItemReaction[]>();
let servedBuckets: KanbanBucketInitial[] | null = null;
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
      if (url.pathname === "/api/spaces/Space1/items/Item01/claim" && request.method === "POST") {
        const { claimId } = await request.json();
        claimedItem = {
          ...items[0]!,
          claim: {
            id: claimId,
            actor: { kind: "user", id: me.id },
            displayName: me.displayName,
            avatarHash: null,
            claimedAt: "2026-10-02T08:00:00.000Z",
          },
        };
        return Response.json(claimedItem);
      }
      const reactionRoute = /^\/api\/spaces\/Space1\/items\/(\w+)\/reactions\/([^/]+)$/.exec(url.pathname);
      if (reactionRoute && (request.method === "PUT" || request.method === "DELETE")) {
        const itemId = reactionRoute[1]!;
        const emoji = decodeURIComponent(reactionRoute[2]!);
        reactionRequests.push({ method: request.method, item: itemId, emoji });
        const current = reactionSummaries.get(itemId) ?? [];
        const found = current.find((entry) => entry.emoji === emoji);
        const own = request.method === "PUT";
        const count = (found?.count ?? 0) + Number(own) - Number(found?.own ?? false);
        const reactions = found
          ? current.flatMap((entry) => (entry.emoji !== emoji ? [entry] : count > 0 ? [{ ...entry, own, count }] : []))
          : own
            ? [...current, { emoji, count: 1, own: true, people: [] }]
            : current;
        reactionSummaries.set(itemId, reactions);
        return Response.json({ reactions });
      }
      const move = /^\/api\/spaces\/Space1\/items\/(\w+)\/move$/.exec(url.pathname);
      if (move && request.method === "POST") {
        const body = (await request.json()) as { columnId: string; completed?: boolean };
        moves.push(body);
        // As the real route: completion changes only when the request asks for it.
        const moved = [...allItems, ...reactionScenario().buckets!.flatMap((entry) => entry.items)].find((entry) => entry.id === move[1])!;
        const completedAt = body.completed === undefined ? moved.completedAt : body.completed ? new Date().toISOString() : null;
        // As the real route: a write response carries no reactions.
        const { reactions: _reactions, ...written } = moved;
        return Response.json({ ...written, columnId: body.columnId, completedAt });
      }
      if (url.pathname === "/api/spaces/Space1/items/filter") {
        // As strict as the real route: the schema answers 400, a tag the Space does not have 404.
        const parsed = ItemFilterSchema.safeParse(await request.json());
        filterRequests.push(parsed.success ? parsed.data : null);
        if (!parsed.success) return Response.json({ message: "Invalid filter" }, { status: 400 });
        if (parsed.data.tagIds?.some((tagId) => tagId !== "Tag001")) return Response.json({ message: "Tag not found" }, { status: 404 });
        if (servedBuckets) {
          const key = parsed.data.overdue
            ? "virtual:overdue"
            : parsed.data.blocked
              ? "virtual:blocked"
              : `column:${parsed.data.columnIds?.[0]}`;
          const served = servedBuckets.find((entry) => entry.key === key);
          const found = served?.items.map((task) => ({ ...task, reactions: reactionSummaries.get(task.id) ?? [] })) ?? [];
          return Response.json({ items: found, total: found.length, page: 1, pageSize: 30, totalPages: found.length > 0 ? 1 : 0 });
        }
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

type PointerEnvironment = { hover: string; "any-hover": string; pointer: string; "any-pointer": readonly string[] };

// Neither engine emulates a touch primary pointer with a hovering secondary one, so the stylesheet answers the
// pointer media queries itself, as in @k2b/ui's row-action-reveal browser test.
const pointerCss = (source: string, environment: PointerEnvironment) =>
  source.replace(/\((hover|any-hover|pointer|any-pointer)\s*:\s*(hover|none|fine|coarse)\)/g, (_, feature: string, value: string) => {
    const matches =
      feature === "any-pointer"
        ? environment["any-pointer"].some((pointer) => pointer === value)
        : feature === "hover"
          ? environment.hover === value
          : feature === "any-hover"
            ? environment["any-hover"] === value
            : environment.pointer === value;
    return matches ? "(min-width:0)" : "(max-width:0)";
  });

const pageHtml = (scenario: Scenario, theme: "light" | "dark", pointer?: PointerEnvironment) =>
  `<!doctype html><html lang="${scenario.locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${pointer ? pointerCss(css, pointer) : css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  // The workspace main area: a padded flex column the route fills.
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;${scenario.workspace ? "" : "padding:var(--ui-space-shell)"}">${serverBody(scenario)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1280, height: 800, touch: false };

const open = async (
  view: View,
  scenario: Scenario,
  options: { javaScript?: boolean; theme?: "light" | "dark"; pointer?: PointerEnvironment } = {},
) => {
  const id = `case${++caseCounter}`;
  for (const entry of scenario.buckets ?? []) {
    for (const task of entry.items) reactionSummaries.set(task.id, task.reactions ?? []);
  }
  servedBuckets = scenario.served ? (scenario.buckets ?? null) : null;
  pages.set(id, pageHtml(scenario, options.theme ?? "light", options.pointer));
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    javaScriptEnabled: options.javaScript ?? true,
    // The workspace scenarios measure the detail panel where it rests, not while it slides in.
    reducedMotion: scenario.workspace ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  if (scenario.now) await page.clock.setFixedTime(new Date(scenario.now));
  await page.goto(`${server.url}app/spaces/Space1?case=${id}${scenario.query ? `&${scenario.query.slice(1)}` : ""}`);
  await page.evaluate(() => window.document.fonts.ready);
  if (options.javaScript ?? true) {
    if (scenario.workspace === "table") await page.waitForSelector('[data-scrollbar-enhanced="true"]');
    else await rendered(page);
  }
  return page;
};
/** The island has replaced the server markup: hydrated icon buttons drop their server-only native title. */
const rendered = (page: Page) => page.waitForSelector(".spaces-kanban-board[data-hydrated]", { timeout: 15_000 });

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element!.getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const board = window.document.querySelector('[role="region"]')!;
    return {
      toolbar: box(window.document.querySelector("[data-spaces-head-filters]")),
      board: box(board),
      boardScroll: { width: board.scrollWidth, client: board.clientWidth },
      documentScroll: { width: window.document.documentElement.scrollWidth, client: window.document.documentElement.clientWidth },
      columns: Array.from(board.querySelectorAll("section")).map(box),
      cards: Array.from(board.querySelectorAll("article")).map(box),
      /** How far a card's title sits below the card's top edge; its corner buttons must not push it down. */
      titleOffset: Math.round(
        board.querySelector("article .spaces-kanban-card__title")!.getBoundingClientRect().top -
          board.querySelector("article")!.getBoundingClientRect().top,
      ),
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
/** Where a pointer picks a card up: the whole card drags (K7). */
const cardHandle = async (page: Page, title: string) => (await page.locator("article").filter({ hasText: title }).boundingBox())!;
const columnTitles = (page: Page) =>
  page
    .locator('[role="region"] section[data-spaces-kanban-column] h3')
    .evaluateAll((titles) => titles.map((title) => title.firstChild?.textContent ?? ""));
/** The toast rail; the live region repeats each toast's text for screen readers. */
const notifications = (page: Page, locale: "en" | "de" = "en") =>
  page.getByRole("region", { name: locale === "de" ? "Benachrichtigungen" : "Notifications" });
const cardsIn = (page: Page, key: string) =>
  page
    .locator(`[data-spaces-kanban-column="${key}"] [data-spaces-kanban-card]`)
    .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.itemId));

const waitForCards = (page: Page, key: string, ids: string[]) =>
  page.waitForFunction(
    ([column, expected]) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`[data-spaces-kanban-column="${column}"] [data-spaces-kanban-card]`),
        (card) => card.dataset.itemId,
      ).join() === expected.join(),
    [key, ids] as const,
  );

/** Hover and focus fade the controls in; wait until the fade has finished. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.timeline === document.timeline)
        .map((animation) => animation.finished),
    ),
  );

// Each `kanban-*.browser.test.ts` runs one part in a child process of its own, so every part keeps its own budget
// (#3026). Run directly, the suite runs every part.
const parts = ["board", "head", "columns", "cards"] as const;
export type KanbanPart = (typeof parts)[number];
if (selectedPart !== undefined && !parts.some((part) => part === selectedPart))
  throw new Error(`Unknown SPACES_KANBAN_PART "${selectedPart}"; expected one of ${parts.join(", ")}`);
const describePart = (part: KanbanPart, title: string, define: () => void) => {
  if (selectedPart === undefined || selectedPart === part) describe(title, define);
};

describePart("board", "Spaces Kanban board in a browser", () => {
  for (const [name, view] of [
    ["phone", phone],
    ["desktop", desktop],
  ] as const) {
    test(`${name}: the head and board stay where the server put them`, async () => {
      const scenario: Scenario = { locale: "de", folded: ["column:Col003"] };
      const before = await open(view, scenario, { javaScript: false });
      const server = await layout(before);
      await before.context().close();
      const page = await open(view, scenario);
      try {
        const client = await layout(page);
        expect(client).toEqual(server);
        expect(client.titleOffset).toBeLessThanOrEqual(12);
        expect(client.board.top).toBeGreaterThanOrEqual(client.toolbar.top + client.toolbar.height);
        expect(client.documentScroll.width).toBe(client.documentScroll.client);
        // The folded column is a narrow strip; open columns share the width, and on a phone they keep theirs and scroll sideways.
        const widths = client.columns.map((column) => column.width);
        expect(widths[2]).toBe(40);
        expect(new Set([widths[0], widths[1], widths[3]]).size).toBe(1);
        expect(widths[0]).toBe(view === phone ? 318 : Math.max(widths[0]!, 240));
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
      await hoverInPlace(page.locator("article").first());
      expect(await layout(page)).toEqual(at);
      await hoverInPlace(page.locator('[data-spaces-kanban-column-menu="column:Col002"]'));
      expect(await layout(page)).toEqual(at);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a column folds and unfolds by keyboard, keeps focus, and remembers it in the settings cookie", async () => {
    const page = await open(phone, { locale: "en" });
    try {
      // The column's "…" menu folds it; the strip that takes its place takes the focus.
      await page.locator('[data-spaces-kanban-column-menu="column:Col002"]').click();
      await page.getByRole("menuitem", { name: "Fold In progress" }).click();
      const fold = page.locator('[data-spaces-kanban-fold="column:Col002"]');
      await page.waitForSelector('[data-spaces-kanban-fold="column:Col002"][aria-expanded="false"]');
      expect(await page.evaluate(() => window.document.activeElement?.getAttribute("data-spaces-kanban-fold"))).toBe("column:Col002");
      expect(await fold.getAttribute("aria-label")).toBe("Unfold In progress, 2 items");
      const settings = async () => {
        const cookie = await storedCookie(page, "settings-app-spaces");
        return cookie ? JSON.parse(decodeURIComponent(cookie.value)).spaces.Space1 : undefined;
      };
      expect((await settings())?.foldedColumns).toEqual(["column:Col002"]);
      expect(await page.locator('[data-bucket-key="column:Col002"]').count()).toBe(0);

      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-spaces-kanban-column="column:Col002"] [data-spaces-kanban-column-menu]');
      await page.waitForFunction(() => window.document.activeElement?.getAttribute("data-spaces-kanban-column-menu") === "column:Col002");
      expect((await settings())?.foldedColumns).toBeUndefined();
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describePart("head", "Spaces Kanban board in a browser", () => {
  test("a filter loads the narrowed board in place, keeps it in the URL, and counts what it hides", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      await page.getByRole("button", { name: "Assignment" }).click();
      await page.getByRole("menuitemradio", { name: "Assigned to me" }).click();
      await page.waitForURL((url) => url.searchParams.get("assignedTo") === "me");
      await page.keyboard.press("Escape");
      expect(await page.locator('[role="region"] header span[title] > [aria-hidden="true"]').allTextContents()).toEqual([
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
    test(`${locale}: active head chips and Reset stay reachable at every width`, async () => {
      for (const width of [390, 900, 960, 1040, 1120, 1280]) {
        const page = await open({ width, height: 800, touch: false }, { locale, query: allFilters });
        try {
          // The filters stand in the status row and scroll there themselves.
          const head = page.locator("[data-spaces-head-filters]");
          const group = head;
          expect(await head.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("nowrap");
          const controls = head.locator("button:visible, a:visible, input:visible");
          expect(await controls.count()).toBeGreaterThan(0);
          for (const control of await controls.all()) {
            // Chips share one row and the filter bar scrolls to every control, including Reset.
            await control.scrollIntoViewIfNeeded();
            const box = (await control.boundingBox())!;
            const clip = (await group.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(clip.x - 0.5);
            expect(box.x + box.width).toBeLessThanOrEqual(clip.x + clip.width + 0.5);
          }
          const reset = page.getByRole("link", { name: locale === "de" ? "Zurücksetzen" : "Reset", exact: true });
          await reset.focus();
          expect(await reset.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        } finally {
          await page.context().close();
        }
      }
    }, 60_000);
  }

  for (const view of [desktop, phone]) {
    test(`${view.width}px: a head chip applies its filter and moves neither the search, its own start, the menu, nor the board`, async () => {
      const page = await open(view, { locale: "de" });
      try {
        // The active chip names its value and Reset appears after the chips; nothing before them and nothing below may move.
        const positions = () =>
          page.evaluate(() => {
            const box = (element: Element | null) => {
              const rect = element!.getBoundingClientRect();
              return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width) };
            };
            const chip = Array.from(window.document.querySelectorAll("[data-spaces-head-filters] button")).find((button) =>
              button.textContent?.includes("Zuständigkeit"),
            )!;
            const start = box(chip);
            return {
              search: box(window.document.querySelector("[data-spaces-head-filters] input")),
              chip: { left: start.left, top: start.top },
              menu: box(window.document.querySelector("[data-spaces-menu]")),
              board: box(window.document.querySelector('[role="region"]')),
            };
          });
        const before = await positions();
        const chip = page.getByRole("button", { name: "Zuständigkeit" });
        if (view.touch) await chip.tap();
        else await chip.click();
        const option = page.getByRole("menuitemradio", { name: "Mir zugewiesen" });
        if (view.touch) await option.tap();
        else await option.click();
        await page.waitForURL((url) => url.searchParams.get("assignedTo") === "me");
        await page.getByRole("link", { name: "Zurücksetzen", exact: true }).waitFor();
        expect(await page.locator("[data-spaces-head-filters] [data-active]").count()).toBeGreaterThan(0);
        expect(await positions()).toEqual(before);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("filter values the API would reject do not break a column refresh", async () => {
    const page = await open(desktop, { locale: "en", query: "?tags=Gone01&assignedTo=bogus&priority=Urgent&deadline=soon" });
    const remaining = Promise.withResolvers<void>();
    try {
      // Keep later requests behind a gate: one response must never stand in for the whole refresh.
      await page.route("**/items/filter", async (route) => {
        const filter = ItemFilterSchema.parse(route.request().postDataJSON());
        if (!filter.columnIds?.includes(columns[0]!.id)) await remaining.promise;
        await route.continue();
      });
      filterRequests.splice(0);
      const refreshed = columns.map((column) =>
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/items/filter") &&
            ItemFilterSchema.parse(response.request().postDataJSON()).columnIds?.includes(column.id) === true,
        ),
      );
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("spaces-data-invalidated", { detail: { domains: ["view"], cursor: null, itemId: null, cover: () => undefined } }),
        ),
      );
      await refreshed[0];
      expect(filterRequests).toHaveLength(1);
      remaining.resolve();
      const responses = await Promise.all(refreshed);
      await Promise.all(responses.map((response) => response.finished()));
      await page.waitForFunction(() => !window.document.querySelector('[role="region"] button.text-red-600'));
      // Nothing valid remains of the URL filter, so the board is unfiltered: one plain page per column.
      expect(filterRequests).toHaveLength(4);
      for (const request of filterRequests) expect(request).toMatchObject({ assignedTo: "all", deadlineFilter: "all" });
      expect(
        filterRequests.some((request) => (request as { tagIds?: string[] }).tagIds || (request as { priority?: string[] }).priority),
      ).toBe(false);
      expect(await page.locator('[role="region"] button.text-red-600').count()).toBe(0);
      expect(await page.locator("[data-spaces-head-filters] [data-active]").count()).toBe(0);
    } finally {
      remaining.resolve();
      await page.unrouteAll({ behavior: "wait" });
      await page.context().close();
    }
  }, 30_000);

  for (const canWrite of [true, false]) {
    test(`the head menu opens the shortcut list on a tap and names ${canWrite ? "the edit shortcuts" : "no edit shortcuts for a reader"}`, async () => {
      const page = await open(phone, { locale: "en", canWrite });
      try {
        await page.locator("[data-spaces-menu]").tap();
        await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).tap();
        const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await dialog.waitFor();
        expect(await dialog.textContent()).toContain("Open the card");
        expect((await dialog.textContent())?.includes("Assign it to you")).toBe(canWrite);
        expect((await dialog.textContent())?.includes("On its grip: pick up, move, and drop or cancel")).toBe(canWrite);
        // Each Kbd holds one visible cap per key next to its spoken name, so read the caps.
        expect(await dialog.locator(".k2b-kbd__key").allTextContents()).toEqual(
          canWrite ? ["←", "↑", "→", "↓", "↵", "M", "D", "Space", "←", "↑", "→", "↓", "Esc"] : ["←", "↑", "→", "↓", "↵"],
        );
        // The board's own description for screen readers names the same shortcuts.
        expect((await page.locator("#spaces-kanban-shortcuts-Space1").textContent())?.includes("M assigns")).toBe(canWrite);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});

describePart("columns", "Spaces Kanban board in a browser", () => {
  test("automatic columns show blocked and overdue tasks only there, with the status as a badge; Blocked wins", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      expect(await columnTitles(page)).toEqual(["To do", "Blocked", "In progress", "Review", "Overdue", "Done"]);
      expect(await cardsIn(page, "virtual:blocked")).toEqual(["Item08", "Item10"]);
      expect(await cardsIn(page, "virtual:overdue")).toEqual(["Item09"]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item02", "Item03"]);
      expect(await cardsIn(page, "column:Col003")).toEqual(["Item06"]);
      expect(await page.locator('[role="region"] header span[title] > [aria-hidden="true"]').allTextContents()).toEqual([
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
      // The footer lies outside the card link, so it describes the link: a focused card still says its status and Overdue.
      const described = await page.evaluate(() => {
        const link = document.querySelector<HTMLElement>('a[data-spaces-kanban-card][data-item-id="Item10"]')!;
        const meta = document.getElementById(link.getAttribute("aria-describedby") ?? "")!.cloneNode(true) as HTMLElement;
        for (const hidden of meta.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
        return meta.textContent?.replace(/\s+/g, " ").trim();
      });
      expect(described).toContain("Status: Review");
      expect(described).toContain("Overdue");
      if (browserName === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        const { nodes } = await cdp.send("Accessibility.getFullAXTree");
        const card = nodes.find((node) => node.role?.value === "link" && node.name?.value === "Print the badges");
        expect(String(card?.description?.value)).toContain("Status: Review");
        expect(String(card?.description?.value)).toContain("Overdue");
        await cdp.detach();
      }

      // Hovering a column header or its menu moves nothing.
      const at = await layout(page);
      await hoverInPlace(page.locator('[data-spaces-kanban-column="virtual:blocked"] h3'));
      expect(await layout(page)).toEqual(at);
      await hoverInPlace(page.locator('[data-spaces-kanban-column-menu="virtual:blocked"]'));
      expect(await layout(page)).toEqual(at);

      // Arrow keys walk through an automatic column like any other.
      await page.locator('[data-item-id="Item01"]').focus();
      await page.keyboard.press("ArrowRight");
      expect(await page.evaluate(() => (window.document.activeElement as HTMLElement | null)?.dataset.itemId)).toBe("Item08");
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
        expect(await page.locator('[data-spaces-kanban-column="column:Col004"][data-sortable-target]').count()).toBe(1);
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
});

describePart("cards", "Spaces Kanban board in a browser", () => {
  test("a card previews a Markdown description as plain text on one line with an ellipsis (K15)", async () => {
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
      const page = await open(desktop, { locale: "en", buckets, served: true }, { javaScript });
      try {
        const preview = await page
          .locator('article:has([data-spaces-kanban-card][data-item-id="Item11"]) .spaces-kanban-card__desc')
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              text: element.textContent,
              ellipsis: style.textOverflow,
              lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight)),
              clipped: element.scrollWidth > element.clientWidth,
            };
          });
        expect({ ...preview, text: preview.text?.slice(0, visible.length) }).toEqual({
          text: visible,
          ellipsis: "ellipsis",
          lines: 1,
          clipped: true,
        });
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);
});

describePart("columns", "Spaces Kanban board in a browser", () => {
  test("keyboard: a column header menu moves a column, announces it, and keeps focus", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      columnOrders.splice(0);
      const menu = page.locator('[data-spaces-kanban-column-menu="virtual:blocked"]');
      await menu.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Move right" }).waitFor();
      // Fold, Move left, Move right.
      await page.keyboard.press("ArrowDown");
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

  test("readers get no drag affordance, and their column menu only folds", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns(), canWrite: false });
    try {
      expect(await page.locator("[data-sortable-handle]").count()).toBe(0);
      expect(await page.locator("[data-spaces-kanban-card-menu]").count()).toBe(0);
      await page.locator('[data-spaces-kanban-column-menu="column:Col001"]').click();
      await page.getByRole("menuitem", { name: "Fold To do" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Move right" }).count()).toBe(0);
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
          widths: [318, 318, 318, 318, 318, 318],
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
});

describePart("cards", "Spaces Kanban board in a browser", () => {
  test("the assigned worker leads one avatar stack in the server frame, after hydration, and after reload", async () => {
    const scenario: Scenario = { locale: "en" };
    /** The stack of "Book the stage" (Kim works on it, Robin is assigned too): avatar names, rings, overflow, and box. */
    const stackOf = async (page: Page) => {
      const stack = page.locator('article:has([data-spaces-kanban-card][data-item-id="Item04"]) [class="flex shrink-0 -space-x-1"]');
      expect(await stack.count()).toBe(1);
      return {
        avatars: await stack
          .locator(".k2b-avatar")
          .evaluateAll((avatars) => avatars.map((avatar) => [avatar.getAttribute("aria-label"), avatar.getAttribute("data-ring")])),
        overflow: (await stack.textContent())?.includes("+") ?? false,
        box: await stack.boundingBox(),
      };
    };
    const expected = [
      ["Kim Example is on it", "success"],
      ["Robin Example avatar", null],
    ];
    const before = await open(desktop, scenario, { javaScript: false });
    const server = await stackOf(before);
    await before.context().close();
    expect(server.avatars).toEqual(expected);
    expect(server.overflow).toBe(false);
    const page = await open(desktop, scenario);
    try {
      expect(await stackOf(page)).toEqual(server);
      await page.reload();
      await rendered(page);
      expect(await stackOf(page)).toEqual(server);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("claiming a card refreshes its assigned avatar with one ring in the same card element and keeps its height", async () => {
    claimedItem = null;
    const page = await open(desktop, { locale: "en" });
    try {
      const card = page.locator("article", { has: page.locator('[data-spaces-kanban-card][data-item-id="Item01"]') });
      expect(await card.locator('[data-ring="success"]').count()).toBe(0);
      expect(
        await keptThrough(card, async () => {
          await card.hover();
          await card.getByRole("button", { name: "I'm on it", exact: true }).click();
          await card.locator('[data-ring="success"]').waitFor();
        }),
      ).toEqual({ replaced: false, heightChange: 0 });
      expect(await card.locator('[data-ring="success"]').count()).toBe(1);
      expect(await card.getByRole("img", { name: "You're on it", exact: true }).count()).toBe(1);
      expect(await card.getByRole("img", { name: "Robin Example avatar", exact: true }).count()).toBe(0);
    } finally {
      claimedItem = null;
      await page.context().close();
    }
  }, 60_000);

  test("the worker's ring on a card stays whole beside the next avatar and keeps the avatar size", async () => {
    for (const [view, theme] of [
      [desktop, "light"],
      [phone, "dark"],
    ] as const) {
      const page = await open(view, { locale: "en" }, { theme });
      try {
        const card = page.locator('article:has([data-item-id="Item04"])');
        await card.scrollIntoViewIfNeeded();
        const area = (await card.boundingBox())!;
        await page.screenshot({
          path: `/tmp/spaces-kanban-claim-card-${view.width}-${theme}.png`,
          clip: { x: area.x - 8, y: area.y - 8, width: area.width + 16, height: area.height + 16 },
        });
        const stack = await card.evaluate((element) => {
          const holder = element.querySelector("[data-spaces-claim-badge] .k2b-avatar")!;
          const holderBox = holder.getBoundingClientRect();
          const next = holder.closest("[data-spaces-claim-badge]")!.nextElementSibling!.getBoundingClientRect();
          // No ancestor up to the card clips the ring, which lies inside the avatar's own box.
          const clipped = [] as string[];
          for (let node = holder.parentElement; node && node !== element.parentElement; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.overflow === "visible") continue;
            const box = node.getBoundingClientRect();
            if (holderBox.left < box.left || holderBox.right > box.right || holderBox.top < box.top || holderBox.bottom > box.bottom)
              clipped.push(node.className);
          }
          const style = getComputedStyle(holder);
          return {
            clipped,
            // The ring is the avatar's border behind a transparent gap, so the gap matches the card when hovered or
            // selected, and nothing paints outside the avatar.
            ring: [holder.getAttribute("data-ring"), style.borderTopWidth, style.outlineStyle, style.boxShadow].join(" "),
            sizes: [holderBox.width, next.width],
            // The next avatar starts where the holder's ring ends instead of covering it.
            gap: Math.round(next.left - holderBox.right),
          };
        });
        expect(stack.clipped).toEqual([]);
        expect(stack.ring).toBe("success 2px none none");
        expect(stack.sizes[0]).toBe(stack.sizes[1]);
        expect(stack.gap).toBe(0);
        const before = await layout(page);
        await hoverInPlace(card);
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
        expect(await board.evaluate((element) => element.scrollLeft)).toBeGreaterThanOrEqual(100);
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );
});

// Reactions live only in these buckets; the default board keeps its original card geometry.
const reactionNow = "2026-10-17T12:00:00.000Z";
const cardReactions: SpaceItemReaction[] = ["👍", "❤️", "🎉", "👀", "🚀"].map((emoji, index) => ({
  emoji,
  count: index === 1 ? 2 : 1,
  own: index === 1,
  people: [{ kind: "user", id: kim.id, displayName: kim.displayName }],
}));
const reactionScenario = (canWrite = true): Scenario => ({
  locale: "en",
  served: true,
  now: reactionNow,
  canWrite,
  buckets: [
    bucket({ key: "column:Col001", label: "To do", color: columns[0]!.color, kind: "column", columnId: "Col001", isDone: false }, [
      item("React01", "Col001", "Discuss the fair", { updatedAt: reactionNow, reactions: cardReactions }),
      item("React02", "Col001", "Order the signs", { updatedAt: reactionNow, deadline: "2026-10-18T12:00:00.000Z", assignees: [me] }),
      item("React03", "Col001", "Keep the queue steady", { updatedAt: reactionNow }),
    ]),
    bucket({ key: "virtual:overdue", label: "Overdue", color: null, kind: "overdue", columnId: null, isDone: false }, [
      item("ReactFull", "Col001", "Confirm all the stands", {
        updatedAt: reactionNow,
        deadline: "2026-10-16",
        deadlineAllDay: true,
        assignees: [me, kim],
      }),
    ]),
  ],
});
const reactionCard = (page: Page, id = "React01") => page.locator(`article:has(a[data-spaces-kanban-card][data-item-id="${id}"])`);
const reactionChip = (page: Page, emoji = "👍", id = "React01") => reactionCard(page, id).locator(`[data-reaction-key="${emoji}"]`);
const watchReactionNavigation = (page: Page) =>
  page.evaluate(() => {
    history.replaceState(null, "", window.location.pathname);
    document.body.dataset.reactionNavigation = "[]";
    window.addEventListener("spaces-detail-navigation", (event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail !== "object" || detail === null || !("href" in detail) || typeof detail.href !== "string") return;
      const opened = JSON.parse(document.body.dataset.reactionNavigation!) as string[];
      opened.push(new URL(detail.href, location.href).searchParams.get("item")!);
      document.body.dataset.reactionNavigation = JSON.stringify(opened);
    });
  });
const pickedReaction = async (page: Page, id: string) => {
  const card = reactionCard(page, id);
  await hoverInPlace(card);
  await card.getByRole("button", { name: "Add reaction", exact: true }).click();
  const emoji = page.locator(".k2b-emoji-picker__option").filter({ hasText: /^👍$/ }).first();
  await emoji.click();
};
const waitForReactionAnswer = (page: Page, id: string) =>
  page.waitForFunction((id) => {
    const chip = document.querySelector(`article:has([data-item-id="${id}"]) [data-reaction-key="👍"]`);
    return chip && !chip.hasAttribute("aria-busy");
  }, id);
type ReloadWindow = Window & { spacesReloads?: Promise<unknown>[] };
/**
 * How many data reloads the board has started. A saved reaction reloads the item's column, and the card stays the
 * same element through it, so a test waits for the reloads themselves: it records the work each listener covers.
 */
const reloadsSoFar = (page: Page) =>
  page.evaluate(() => {
    const scope = window as ReloadWindow;
    if (!scope.spacesReloads) {
      const reloads: Promise<unknown>[] = [];
      scope.spacesReloads = reloads;
      // At the target, capture listeners run before the board's, so every listener's cover call is seen.
      window.addEventListener(
        "spaces-data-invalidated",
        (event) => {
          if (!(event instanceof CustomEvent)) return;
          const detail = event.detail as { cover: (promise: Promise<void>) => void };
          const covered: Promise<unknown>[] = [];
          const cover = detail.cover;
          detail.cover = (promise) => {
            covered.push(promise.catch(() => undefined));
            cover(promise);
          };
          // Listeners cover their work during the dispatch, so the list is complete one microtask later.
          reloads.push(Promise.resolve().then(() => Promise.all(covered)));
        },
        { capture: true },
      );
    }
    return scope.spacesReloads.length;
  });
/** Waits until a reload started after `from`, every reload so far has finished, and the board has drawn the result. */
const waitForReloadsAfter = async (page: Page, from: number) => {
  await page.waitForFunction((from) => ((window as ReloadWindow).spacesReloads?.length ?? 0) > from, from);
  await page.evaluate(async () => {
    await Promise.all((window as ReloadWindow).spacesReloads ?? []);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
};

describePart("cards", "Spaces Kanban reactions", () => {
  test("chips are sibling controls, toggle without navigation, and +n and footer background open the item", async () => {
    reactionRequests.splice(0);
    const page = await open(desktop, reactionScenario());
    try {
      await watchReactionNavigation(page);
      expect(await page.locator("a[data-spaces-kanban-card] button").count()).toBe(0);
      expect(await reactionCard(page).locator(".k2b-reaction-bar__chip").count()).toBe(3);
      const href = page.url();
      for (const [emoji, method] of [
        ["👍", "PUT"],
        ["❤️", "DELETE"],
      ] as const) {
        const answer = page.waitForResponse((response) => response.url().includes("/reactions/") && response.request().method() === method);
        const from = await reloadsSoFar(page);
        await reactionChip(page, emoji).click();
        expect((await answer).ok()).toBe(true);
        // The saved reaction reloads the column; the next step reads the reloaded card.
        await waitForReloadsAfter(page, from);
        await page.waitForFunction(() => !document.querySelector('article:has([data-item-id="React01"]) [aria-busy="true"]'));
      }
      expect(reactionRequests).toEqual([
        { method: "PUT", item: "React01", emoji: "👍" },
        { method: "DELETE", item: "React01", emoji: "❤️" },
      ]);
      expect(page.url()).toBe(href);
      expect(await page.locator("body").getAttribute("data-reaction-navigation")).toBe("[]");
      // Pointer-transparent text must hit the stretched link under it; Locator.click would correctly see an overlay.
      const more = reactionCard(page).locator(".k2b-reaction-bar__more");
      expect(await more.textContent()).toContain("+2");
      const at = await center(more);
      await page.mouse.click(at.x, at.y);
      await page.waitForFunction(() => document.body.dataset.reactionNavigation === '["React01"]');
      await page.evaluate(() => {
        history.replaceState(null, "", location.pathname);
        document.body.dataset.reactionNavigation = "[]";
      });
      const footer = (await reactionCard(page).locator("[data-spaces-kanban-card-footer]").boundingBox())!;
      // The reserved strip left of the claim control is footer background, clear of the chips and +n.
      await page.mouse.click(footer.x + footer.width - 28, footer.y + footer.height - 2);
      await page.waitForFunction(() => document.body.dataset.reactionNavigation === '["React01"]');
      expect(reactionRequests).toHaveLength(2);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a first reaction fits beside a deadline and one assignee without moving any card", async () => {
    const page = await open(desktop, reactionScenario());
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.route("**/reactions/*", async (route) => {
        const response = await route.fetch();
        await answered;
        await route.fulfill({ response });
      });
      const before = await layout(page);
      await pickedReaction(page, "React02");
      expect(await reactionChip(page, "👍", "React02").getAttribute("aria-busy")).toBe("true");
      expect(await layout(page)).toEqual(before);
      const from = await reloadsSoFar(page);
      release();
      await waitForReloadsAfter(page, from);
      await waitForReactionAnswer(page, "React02");
      expect(await layout(page)).toEqual(before);
      const centers = await reactionCard(page, "React02")
        .locator("[data-spaces-kanban-card-footer]")
        .evaluate((footer) => {
          // The metadata wrapper takes no box; its first item is the deadline.
          const first = footer.querySelector('[id^="spaces-kanban-card-meta-"]')!.firstElementChild!.getBoundingClientRect();
          const group = footer.querySelector(".spaces-card-reactions")!.getBoundingClientRect();
          return [first.top + first.height / 2, group.top + group.height / 2];
        });
      expect(centers[1]).toBe(centers[0]);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.context().close();
    }
  }, 30_000);

  test("a full footer wraps the reaction group once and grows by one row", async () => {
    const page = await open(desktop, reactionScenario());
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const card = reactionCard(page, "ReactFull");
      const footer = card.locator("[data-spaces-kanban-card-footer]");
      expect(await footer.locator("[data-spaces-kanban-card-status]").count()).toBe(1);
      // Status, deadline, and two avatars leave room for "Add reaction" but not for a chip beside it.
      await page.route("**/reactions/*", async (route) => {
        const response = await route.fetch();
        await answered;
        await route.fulfill({ response });
      });
      const geometry = () =>
        footer.evaluate((row) => {
          const group = row.querySelector(".spaces-card-reactions")!;
          const chip = group.querySelector(".k2b-reaction-bar__chip");
          // The metadata wrapper takes no box; its items are the row's other flex items.
          const meta = Array.from(row.querySelector('[id^="spaces-kanban-card-meta-"]')!.children);
          const first = meta[0]!.getBoundingClientRect();
          const bar = group.getBoundingClientRect();
          return {
            height: row.closest("article")!.getBoundingClientRect().height,
            firstTop: first.top,
            firstRowBottom: Math.max(...meta.map((child) => child.getBoundingClientRect().bottom)),
            groupTop: bar.top,
            groupHeight: bar.height,
            gap: Number.parseFloat(getComputedStyle(row).rowGap),
            chipHeight: chip?.getBoundingClientRect().height,
          };
        });
      const before = await geometry();
      expect(before.groupTop).toBeLessThan(before.firstRowBottom);
      await pickedReaction(page, "ReactFull");
      const pending = await geometry();
      expect(pending.groupTop).toBeGreaterThan(pending.firstTop);
      expect(pending.groupHeight).toBe(pending.chipHeight!);
      expect(pending.groupTop).toBe(before.firstRowBottom + before.gap);
      expect(pending.height - before.height).toBe(pending.groupHeight + pending.gap);
      const from = await reloadsSoFar(page);
      release();
      await waitForReloadsAfter(page, from);
      await waitForReactionAnswer(page, "ReactFull");
      expect(await geometry()).toEqual(pending);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.context().close();
    }
  }, 30_000);

  test("desktop hover and keyboard focus reveal Add reaction without shifting boxes; touch hides it", async () => {
    const page = await open(desktop, reactionScenario());
    try {
      const card = reactionCard(page);
      const add = card.locator(".k2b-reaction-bar__add");
      const boxes = async () => ({
        card: await card.boundingBox(),
        chips: await card.locator(".k2b-reaction-bar__chip").evaluateAll((chips) =>
          chips.map((chip) => {
            const { x, y, width, height } = chip.getBoundingClientRect();
            return { x, y, width, height };
          }),
        ),
        // getBoundingClientRect also measures its reserved place while visibility is hidden on touch.
        add: await add.locator("button").evaluate((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        }),
      });
      await page.mouse.move(0, 0);
      await settled(page);
      expect(await add.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
      const before = await boxes();
      await hoverInPlace(card);
      await settled(page);
      expect(await add.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await boxes()).toEqual(before);
      await page.mouse.move(0, 0);
      await reactionChip(page).focus();
      await settled(page);
      expect(await add.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await boxes()).toEqual(before);
      await page.evaluate(() => (document.documentElement.dataset.k2bInput = "touch"));
      expect(await add.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
      expect(await boxes()).toEqual(before);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a moved card keeps its chips although the move response carries no reactions", async () => {
    const page = await open(desktop, reactionScenario());
    try {
      // Hold the refresh after the drop, so the card shows what the move response left.
      await page.route("**/items/filter", () => undefined);
      const grip = reactionCard(page).locator("[data-sortable-handle]");
      await grip.focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/React01/move"));
      await page.keyboard.press("Space");
      await moved;
      await waitForCards(page, "column:Col001", ["React02", "React01", "React03"]);
      expect(await reactionCard(page).locator(".k2b-reaction-bar__chip").count()).toBe(3);
      expect(await reactionCard(page).locator(".k2b-reaction-bar__more").textContent()).toContain("+2");
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: a chip keeps the focus and its element when its saved reaction reloads the column, and Enter again removes it", async () => {
    reactionRequests.splice(0);
    const page = await open(desktop, reactionScenario());
    try {
      await reactionCard(page).locator("[data-sortable-handle]").focus();
      for (let step = 0; step < 2; step++) await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-reaction-key"))).toBe("👍");
      const chip = await page.evaluateHandle(() => document.activeElement);
      const from = await reloadsSoFar(page);
      const saved = page.waitForResponse((response) => response.url().includes("/reactions/") && response.request().method() === "PUT");
      await page.keyboard.press("Enter");
      await saved;
      await waitForReloadsAfter(page, from);
      // The reload keeps the card, so the focused chip stays the same element.
      expect(await chip.evaluate((element) => element !== null && element === document.activeElement && element.isConnected)).toBe(true);
      await chip.dispose();
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("data-reaction-key") === "👍" &&
          Boolean(document.activeElement.closest('article:has([data-item-id="React01"])')),
      );
      const removed = page.waitForResponse(
        (response) => response.url().includes("/reactions/") && response.request().method() === "DELETE",
      );
      await page.keyboard.press("Enter");
      await removed;
      expect(reactionRequests.map(({ method, emoji }) => `${method} ${emoji}`)).toEqual(["PUT 👍", "DELETE 👍"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("writer Tab order is grip, card link, chips, Add reaction, claim, card menu", async () => {
    const page = await open(desktop, reactionScenario());
    try {
      const card = reactionCard(page);
      const grip = card.locator("[data-sortable-handle]");
      await grip.focus();
      expect(await grip.evaluate((element) => element === document.activeElement)).toBe(true);
      for (const selector of [
        "a[data-spaces-kanban-card]",
        '[data-reaction-key="👍"]',
        '[data-reaction-key="❤️"]',
        '[data-reaction-key="🎉"]',
        'button[aria-label="Add reaction"]',
        "[data-spaces-claim-action]",
        "[data-spaces-kanban-card-menu]",
      ]) {
        await page.keyboard.press("Tab");
        expect(await card.locator(selector).evaluate((element) => element === document.activeElement)).toBe(true);
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("readers get labelled images, no add button or chip tab stops, and a 56 px row", async () => {
    const page = await open(desktop, reactionScenario(false));
    try {
      const chips = reactionCard(page).locator(".k2b-reaction-bar__chip");
      expect(await chips.count()).toBe(3);
      expect(
        await chips.evaluateAll((elements) =>
          elements.every(
            (element) =>
              element.getAttribute("role") === "img" &&
              Boolean(element.getAttribute("aria-label")) &&
              (element as HTMLElement).tabIndex < 0,
          ),
        ),
      ).toBe(true);
      expect(await page.locator(".k2b-reaction-bar__add").count()).toBe(0);
      // A card is a row of its column: 56 px with one title line, also without reactions (K7).
      expect(Math.round((await reactionCard(page, "React03").boundingBox())!.height)).toBe(56);
      const link = reactionCard(page).locator("a[data-spaces-kanban-card]");
      await link.focus();
      await page.keyboard.press("Tab");
      expect(
        await reactionCard(page, "React02")
          .locator("a[data-spaces-kanban-card]")
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the server frame and hydrated board agree with reactions in light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      const scenario = reactionScenario();
      const serverPage = await open(desktop, scenario, { javaScript: false, theme });
      let serverLayout: Awaited<ReturnType<typeof layout>>;
      try {
        serverLayout = await layout(serverPage);
      } finally {
        await serverPage.context().close();
      }
      const page = await open(desktop, scenario, { theme });
      try {
        expect(await layout(page)).toEqual(serverLayout);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);
});
