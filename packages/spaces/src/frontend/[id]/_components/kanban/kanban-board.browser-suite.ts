import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ItemFilterSchema, type SpaceColumn, type SpaceItem, type SpaceItemReaction, type SpaceWormhole } from "@/contracts";
import { browserName, keptThrough, launchBrowser, storedCookie } from "../../../../../../ui/test/browser";
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
const tabletWithMouse: PointerEnvironment = { hover: "none", "any-hover": "hover", pointer: "coarse", "any-pointer": ["coarse", "fine"] };

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
const tablet: View = { width: 820, height: 1180, touch: true };
const iPadLandscape: View = { width: 1180, height: 820, touch: true };
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
/** A finger's pointer event, dispatched in the page: Playwright drives WebKit's touch input only as a whole tap. */
const touchPointer = (
  locator: ReturnType<Page["locator"]>,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  point: { x: number; y: number },
) =>
  locator.evaluate(
    (element, { type, pointerId, point }) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerType: "touch",
          pointerId,
          isPrimary: true,
          button: type === "pointermove" ? -1 : 0,
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
        }),
      ),
    { type, pointerId, point },
  );
/** Whether the board kept a finger's move from scrolling it; the board reads no touch data, so a plain event will do. */
const touchMovePrevented = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((element) => {
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
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
const announcements = (page: Page) => page.locator('[data-k2b-live] [data-politeness="polite"] > div').allTextContents();
const waitForAnnouncement = async (page: Page, text: string) => {
  await page.waitForFunction(
    (text) =>
      Array.from(document.querySelectorAll('[data-k2b-live] [data-politeness="polite"] > div')).some((line) => line.textContent === text),
    text,
  );
  expect(await announcements(page)).toContain(text);
};
const focusedGrip = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-spaces-kanban-grip"));
const waitForGripFocus = async (page: Page, itemId: string) => {
  await page.waitForFunction((id) => document.activeElement?.getAttribute("data-spaces-kanban-grip") === id, itemId);
  expect(await focusedGrip(page)).toBe(itemId);
};
/** The toast rail; the live region repeats each toast's text for screen readers. */
const notifications = (page: Page, locale: "en" | "de" = "en") =>
  page.getByRole("region", { name: locale === "de" ? "Benachrichtigungen" : "Notifications" });
const cardsIn = (page: Page, key: string) =>
  page
    .locator(`[data-spaces-kanban-column="${key}"] [data-spaces-kanban-card]`)
    .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.itemId));

/** Cards with the same accent border as a keyboard pick-up, resolved by the browser in the current theme. */
const liftedCards = async (page: Page) => {
  // Let the existing border-color transition finish before comparing resolved colors.
  await page
    .locator('[role="region"] article')
    .evaluateAll((cards) => Promise.all(cards.flatMap((card) => card.getAnimations().map((animation) => animation.finished))));
  return page.locator('[role="region"] article').evaluateAll((cards) =>
    cards.flatMap((card) => {
      const probe = document.createElement("span");
      probe.hidden = true;
      probe.style.color = "var(--ui-app-accent-border)";
      card.append(probe);
      const lifted = getComputedStyle(card).borderTopColor === getComputedStyle(probe).color;
      probe.remove();
      return lifted ? [card.querySelector("[data-spaces-kanban-card]")?.getAttribute("data-item-id")] : [];
    }),
  );
};

/** Waits, without a fixed sleep, until exactly these cards show the lift border and its transition has finished. */
const waitForLiftedCards = (page: Page, ids: string[]) =>
  page.waitForFunction((expected) => {
    const lifted = Array.from(document.querySelectorAll('[role="region"] article')).flatMap((card) => {
      const probe = document.createElement("span");
      probe.hidden = true;
      probe.style.color = "var(--ui-app-accent-border)";
      card.append(probe);
      const accent = getComputedStyle(card).borderTopColor === getComputedStyle(probe).color;
      probe.remove();
      return accent ? [card.querySelector("[data-spaces-kanban-card]")?.getAttribute("data-item-id")] : [];
    });
    return lifted.join() === expected.join();
  }, ids);

const waitForCards = (page: Page, key: string, ids: string[]) =>
  page.waitForFunction(
    ([column, expected]) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`[data-spaces-kanban-column="${column}"] [data-spaces-kanban-card]`),
        (card) => card.dataset.itemId,
      ).join() === expected.join(),
    [key, ids] as const,
  );

const cardControls = (page: Page, title: string) =>
  page
    .locator("article")
    .filter({ hasText: title })
    .evaluate((article) => {
      const box = (element: Element) => {
        const { x, y, width, height, top, right } = element.getBoundingClientRect();
        return { x, y, width, height, top, right };
      };
      const control = (selector: string) => {
        const button = article.querySelector(selector);
        if (!button) throw new Error(`Missing card control: ${selector}`);
        let opacity = 1;
        for (let node: Element | null = button; node; node = node === article ? null : node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        const rect = box(button);
        const horizontalReach = (44 - rect.width) / 2 - 2;
        const verticalReach = (44 - rect.height) / 2 - 2;
        const hits = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(selector) === button;
        const centerX = rect.x + rect.width / 2;
        return {
          opacity,
          cursor: getComputedStyle(button).cursor,
          box: rect,
          horizontalReach,
          verticalReach,
          leftHit: hits(rect.x - horizontalReach, rect.y + rect.height / 2),
          topHit: hits(centerX, rect.y - verticalReach),
          // On a one-line card the grip sits right above the claim button: each keeps the strip next to its own box.
          bottomHit: hits(centerX, rect.y + rect.height + verticalReach),
          bottomEdgeHit: hits(centerX, rect.y + rect.height - 1),
        };
      };
      const link = article.querySelector("[data-spaces-kanban-card]")!;
      const linkBox = link.getBoundingClientRect();
      const firstLine = article.querySelector("p")!.getBoundingClientRect();
      return {
        // The last pixel the title's first line can reach still opens the item.
        textEndHit:
          document
            .elementFromPoint(linkBox.right - Number.parseFloat(getComputedStyle(link).paddingRight) - 1, firstLine.top + 2)
            ?.closest("[data-spaces-kanban-card]") === link,
        article: box(article),
        border: {
          top: Number.parseFloat(getComputedStyle(article).borderTopWidth),
          right: Number.parseFloat(getComputedStyle(article).borderRightWidth),
        },
        grip: control("[data-dnd-card-handle]"),
        claim: control("[data-spaces-claim-action]"),
      };
    });
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
const expectGripBox = (state: Awaited<ReturnType<typeof cardControls>>) => {
  expect([state.grip.box.width, state.grip.box.height]).toEqual([20, 20]);
  // Absolute offsets start inside the article's border.
  expect(state.article.right - state.border.right - state.grip.box.right).toBe(6);
  expect(state.grip.box.top - state.article.top - state.border.top).toBe(6);
};
const expectHitArea = (control: Awaited<ReturnType<typeof cardControls>>["grip"]) => {
  expect(control.horizontalReach).toBeGreaterThanOrEqual(6);
  expect(control.verticalReach).toBeGreaterThanOrEqual(6);
  expect(control.leftHit).toBe(true);
  expect(control.topHit).toBe(true);
  expect(control.bottomHit).toBe(true);
  expect(control.bottomEdgeHit).toBe(true);
};

describe("Spaces Kanban board in a browser", () => {
  for (const [name, view] of [
    ["phone", phone],
    ["tablet", tablet],
  ] as const) {
    test(`${name}: touch-only card controls stay visible with larger hit areas and text still opens the item`, async () => {
      const page = await open(view, { locale: "en" });
      try {
        const state = await cardControls(page, "Ask the bakery about a stand");
        expect([state.grip.opacity, state.claim.opacity]).toEqual([1, 1]);
        expectGripBox(state);
        expectHitArea(state.grip);
        expectHitArea(state.claim);
        expect(state.textEndHit).toBe(true);
        // A finger that lands just below the grip, as for a long-press, must not claim the task for everyone.
        const claims: string[] = [];
        page.on("request", (request) => {
          if (request.url().endsWith("/claim")) claims.push(request.url());
        });
        await page.touchscreen.tap(
          state.grip.box.x + state.grip.box.width / 2,
          state.grip.box.y + state.grip.box.height + state.grip.verticalReach,
        );
        await page.waitForTimeout(100);
        expect(claims).toEqual([]);
        // Without the fixture's case parameter the item link differs from the page only in its item, so it opens in place.
        await page.evaluate(() => history.replaceState(null, "", window.location.pathname));
        const opening = page.evaluate(
          () =>
            new Promise<string>((resolve) => {
              window.addEventListener(
                "spaces-detail-navigation",
                (event) => {
                  if (!(event instanceof CustomEvent)) return;
                  const detail: unknown = event.detail;
                  if (typeof detail === "object" && detail !== null && "href" in detail && typeof detail.href === "string")
                    resolve(detail.href);
                },
                { once: true },
              );
            }),
        );
        const text = await center(page.locator('[data-item-id="Item01"] p').first());
        await page.touchscreen.tap(text.x, text.y);
        expect(new URL(await opening, page.url()).searchParams.get("item")).toBe("Item01");
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("desktop: card controls reveal on hover and focus while my release control stays visible", async () => {
    const buckets = unfiltered().map((entry) => ({
      ...entry,
      items: entry.items.map((task) =>
        task.id === "Item05"
          ? {
              ...task,
              claim: {
                id: "55555555-5555-4555-8555-555555555555",
                actor: { kind: "user" as const, id: me.id },
                displayName: me.displayName,
                avatarHash: null,
                claimedAt: "2026-10-01T08:00:00.000Z",
              },
            }
          : task,
      ),
    }));
    const page = await open(desktop, { locale: "en", buckets });
    try {
      const card = page.locator("article").filter({ hasText: "Ask the bakery about a stand" });
      const rest = await cardControls(page, "Ask the bakery about a stand");
      expect([rest.grip.opacity, rest.claim.opacity]).toEqual([0, 0]);
      expect(rest.grip.cursor).toBe("grab");
      const released = await cardControls(page, "Collect insurance quotes");
      expect(released.claim.opacity).toBe(1);
      expect(await page.locator('[data-spaces-claim-action="release"]').count()).toBe(1);
      await card.hover();
      await settled(page);
      const hovered = await cardControls(page, "Ask the bakery about a stand");
      expect([hovered.grip.opacity, hovered.claim.opacity]).toEqual([1, 1]);
      await page.mouse.move(1279, 799);
      await settled(page);
      const parked = await cardControls(page, "Ask the bakery about a stand");
      expect([parked.grip.opacity, parked.claim.opacity]).toEqual([0, 0]);
      await card.locator("[data-spaces-kanban-card]").focus();
      await settled(page);
      const focused = await cardControls(page, "Ask the bakery about a stand");
      expect([focused.grip.opacity, focused.claim.opacity]).toEqual([1, 1]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("tablet with mouse: card controls reveal on focus and keep coarse-pointer hit areas", async () => {
    const page = await open(tablet, { locale: "en" }, { pointer: tabletWithMouse });
    try {
      const rest = await cardControls(page, "Ask the bakery about a stand");
      expect([rest.grip.opacity, rest.claim.opacity]).toEqual([0, 0]);
      await page.locator('[data-item-id="Item02"]').focus();
      await settled(page);
      const focused = await cardControls(page, "Ask the bakery about a stand");
      expect([focused.grip.opacity, focused.claim.opacity]).toEqual([1, 1]);
      expectGripBox(focused);
      expectHitArea(focused.grip);
      expectHitArea(focused.claim);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [name, view] of [
    ["iPad portrait", tablet],
    ["iPad landscape", iPadLandscape],
  ] as const) {
    test.skipIf(browserName === "webkit")(
      `${name}: holding a card's title lifts it and dragging moves it to In progress without selecting text`,
      async () => {
        const page = await open(view, { locale: "en" });
        try {
          moves.splice(0);
          await page.evaluate(() => {
            document.body.dataset.contextMenus = "";
            window.addEventListener("contextmenu", (event) => {
              document.body.dataset.contextMenus += event.defaultPrevented ? "1" : "0";
            });
          });
          const from = await center(page.locator('[data-item-id="Item02"] p').first());
          const to = await center(page.locator('[data-spaces-kanban-column="column:Col002"] article').first());
          const before = await layout(page);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
          await waitForLiftedCards(page, ["Item02"]);
          expect(await liftedCards(page)).toEqual(["Item02"]);
          expect(await layout(page)).toEqual(before);
          for (let step = 1; step <= 20; step++) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: from.x + ((to.x - from.x) * step) / 20, y: from.y + ((to.y - from.y) * step) / 20 }],
            });
            await page.waitForTimeout(16);
          }
          const saved = page.waitForResponse((response) => response.url().endsWith("/items/Item02/move"));
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await saved;
          expect(moves).toContainEqual(expect.objectContaining({ columnId: "Col002" }));
          await page.waitForSelector('[data-spaces-kanban-column="column:Col002"] [data-item-id="Item02"]');
          expect(await cardsIn(page, "column:Col002")).toContain("Item02");
          expect(await liftedCards(page)).toEqual([]);
          expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("");
          expect(await page.locator("body").getAttribute("data-context-menus")).not.toContain("0");
        } finally {
          await page.context().close();
        }
      },
      30_000,
    );
  }

  test.skipIf(browserName === "webkit")(
    "iPad portrait: a quick swipe on a card body scrolls the board without lifting or moving a card",
    async () => {
      const page = await open(tablet, { locale: "en" });
      try {
        moves.splice(0);
        const board = page.locator('[role="region"]');
        await board.evaluate((element) => {
          element.scrollLeft = 100;
        });
        const from = await center(page.locator('[data-item-id="Item04"] p').first());
        await page.evaluate(() => {
          window.addEventListener("pointerdown", (event) => {
            const link = event.target instanceof Element ? event.target.closest("[data-spaces-kanban-card]") : null;
            document.body.dataset.touchPressAccepted = String(link?.hasAttribute("data-spaces-kanban-touch-press"));
          });
        });
        const cdp = await page.context().newCDPSession(page);
        const started = cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
        const swiped = cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x - 24, y: from.y }] });
        await Promise.all([started, swiped]);
        // The card body is accepted only for this finger press, before it becomes a swipe.
        expect(await page.locator("body").getAttribute("data-touch-press-accepted")).toBe("true");
        for (let step = 2; step <= 15; step++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x - 24 * step, y: from.y }] });
          await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(400);
        expect(await board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
        expect(moves).toEqual([]);
        expect(await liftedCards(page)).toEqual([]);
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("");
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

  test.skipIf(browserName === "webkit")(
    "iPad portrait: releasing a held card without moving opens nothing and prevents the touch context menu",
    async () => {
      const page = await open(tablet, { locale: "en" });
      try {
        moves.splice(0);
        await page.evaluate(() => {
          history.replaceState(null, "", window.location.pathname);
          document.body.dataset.openedCard = "false";
          document.body.dataset.contextMenus = "";
          window.addEventListener("spaces-detail-navigation", () => {
            document.body.dataset.openedCard = "true";
          });
          window.addEventListener("contextmenu", (event) => {
            document.body.dataset.contextMenus += event.defaultPrevented ? "1" : "0";
          });
        });
        const from = await center(page.locator('[data-item-id="Item02"] p').first());
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
        await waitForLiftedCards(page, ["Item02"]);
        expect(await liftedCards(page)).toEqual(["Item02"]);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(300);
        expect(moves).toEqual([]);
        expect(await page.locator("body").getAttribute("data-opened-card")).toBe("false");
        expect(await liftedCards(page)).toEqual([]);
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("");
        expect(await page.locator("body").getAttribute("data-context-menus")).not.toContain("0");
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

  // WebKit takes no finger moves from Playwright, so this drives the board's pointer logic with events dispatched in the page.
  test("iPad landscape: a held card keeps the finger from scrolling and moves, while an early swipe stays a scroll", async () => {
    const page = await open(iPadLandscape, { locale: "en" });
    try {
      moves.splice(0);
      // Both events run together so a protocol delay cannot turn the swipe into a hold.
      const next = page.locator('[data-item-id="Item01"] p').first();
      const start = await center(next);
      await next.evaluate((element, start) => {
        for (const type of ["pointerdown", "pointermove"]) {
          element.dispatchEvent(
            new PointerEvent(type, {
              pointerType: "touch",
              pointerId: 8,
              isPrimary: true,
              button: type === "pointermove" ? -1 : 0,
              bubbles: true,
              cancelable: true,
              clientX: start.x + (type === "pointermove" ? 20 : 0),
              clientY: start.y,
            }),
          );
        }
      }, start);
      expect(await touchMovePrevented(next)).toBe(false);
      await page.waitForTimeout(400);
      expect(await liftedCards(page)).toEqual([]);
      await touchPointer(next, "pointermove", 8, { x: start.x + 200, y: start.y });
      await touchPointer(next, "pointerup", 8, { x: start.x + 200, y: start.y });
      await page.waitForTimeout(100);
      expect(moves).toEqual([]);
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("");

      // The swipe runs first: the drop moves this card to another column.
      const title = page.locator('[data-item-id="Item02"] p').first();
      const from = await center(title);
      const to = await center(page.locator('[data-spaces-kanban-column="column:Col002"] article').first());
      await touchPointer(title, "pointerdown", 7, from);
      await waitForLiftedCards(page, ["Item02"]);
      expect(await liftedCards(page)).toEqual(["Item02"]);
      expect(await touchMovePrevented(title)).toBe(true);
      // An engine that opens no menu for this gesture still shows that the board cancels one.
      expect(
        await title.evaluate((element) => {
          const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(true);
      for (let step = 1; step <= 20; step++) {
        await touchPointer(title, "pointermove", 7, {
          x: from.x + ((to.x - from.x) * step) / 20,
          y: from.y + ((to.y - from.y) * step) / 20,
        });
      }
      const saved = page.waitForResponse((response) => response.url().endsWith("/items/Item02/move"));
      await touchPointer(title, "pointerup", 7, to);
      await saved;
      expect(moves).toContainEqual(expect.objectContaining({ columnId: "Col002" }));
      await page.waitForSelector('[data-spaces-kanban-column="column:Col002"] [data-item-id="Item02"]');
      // The moved card ends its held press when it leaves the source column.
      await waitForLiftedCards(page, []);
      expect(await liftedCards(page)).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("iPad landscape: a refresh keeps a held card's press until it leaves its column, then its new card scrolls", async () => {
    claimedItem = null;
    const page = await open(iPadLandscape, { locale: "en" });
    try {
      moves.splice(0);
      const card = page.locator('article:has([data-item-id="Item02"])');
      const title = card.locator("p").first();
      const from = await center(title);
      const refresh = () =>
        page.evaluate(async () => {
          const coverage: Promise<void>[] = [];
          window.dispatchEvent(
            new CustomEvent("spaces-data-invalidated", {
              detail: { domains: ["view"], cursor: null, itemId: null, cover: (promise: Promise<void>) => coverage.push(promise) },
            }),
          );
          await Promise.all(coverage);
        });

      await touchPointer(title, "pointerdown", 9, from);
      await waitForLiftedCards(page, ["Item02"]);
      expect(await keptThrough(card, refresh)).toEqual({ replaced: false, heightChange: 0 });
      expect(await liftedCards(page)).toEqual(["Item02"]);
      expect(await touchMovePrevented(title)).toBe(true);
      await touchPointer(title, "pointerup", 9, from);
      await waitForLiftedCards(page, []);
      expect(moves).toEqual([]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item02", "Item03"]);

      await touchPointer(title, "pointerdown", 10, from);
      await waitForLiftedCards(page, ["Item02"]);
      const moved = await keptThrough(card, async () => {
        // The fixture override also models a card that someone else moved to another column.
        claimedItem = { ...items[1]!, columnId: "Col002" };
        await refresh();
        await page.locator('[data-spaces-kanban-column="column:Col001"] [data-item-id="Item02"]').waitFor({ state: "detached" });
        await page.locator('[data-spaces-kanban-column="column:Col002"] [data-item-id="Item02"]').waitFor();
      });
      expect(moved.replaced).toBe(true);
      expect(await card.count()).toBe(1);
      await waitForLiftedCards(page, []);
      expect(await liftedCards(page)).toEqual([]);
      expect(await touchMovePrevented(title)).toBe(false);
      await touchPointer(title, "pointerup", 10, from);
      expect(moves).toEqual([]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item03"]);
    } finally {
      claimedItem = null;
      await page.context().close();
    }
  }, 30_000);

  test("iPad landscape: writers' cards select no text and open no callout, while readers' cards and the toolbar still select", async () => {
    // Only iOS WebKit knows the callout property, so the stylesheet shows that the card asks for it.
    expect(css).toMatch(/\.\\\[-webkit-touch-callout\\:none\\\]\s*\{[^}]*-webkit-touch-callout:\s*none\s*;[^}]*\}/);
    for (const canWrite of [true, false]) {
      const page = await open(iPadLandscape, { locale: "en", canWrite });
      try {
        expect(
          await page
            .locator('article:has([data-item-id="Item02"])')
            .evaluate((card) => card.classList.contains("[-webkit-touch-callout:none]")),
        ).toBe(canWrite);
        const selection = (selector: string) =>
          page
            .locator(selector)
            .first()
            .evaluate((element) => {
              const style = getComputedStyle(element);
              return [style.userSelect, style.getPropertyValue("-webkit-user-select") || style.userSelect];
            });
        expect(await selection('article:has([data-item-id="Item02"])')).toEqual(
          canWrite ? ["none", "none"] : expect.not.arrayContaining(["none"]),
        );
        expect(await selection("[data-spaces-board-toolbar]")).toEqual(expect.not.arrayContaining(["none"]));
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  // Holding and moving a finger needs Chromium's input protocol: WebKit only supports whole taps.
  test.skipIf(browserName === "webkit")(
    "phone: a long-press on the visible grip moves a card to In progress",
    async () => {
      const page = await open(phone, { locale: "en" });
      try {
        moves.splice(0);
        const state = await cardControls(page, "Ask the bakery about a stand");
        expect(state.grip.opacity).toBe(1);
        const board = page.locator('[role="region"]');
        await board.evaluate((element) => {
          element.scrollLeft = 140;
        });
        const from = await center(
          page.locator("article").filter({ hasText: "Ask the bakery about a stand" }).locator("[data-dnd-card-handle]"),
        );
        const target = (await page.locator('[data-spaces-kanban-column="column:Col002"] article').first().boundingBox())!;
        const to = { x: Math.min(target.x + target.width / 2, 360), y: target.y + target.height / 2 };
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
        // dnd.create waits 120 ms on touch and needs 6 px of movement to activate.
        await page.waitForTimeout(200);
        for (let step = 1; step <= 20; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              {
                x: from.x + ((to.x - from.x) * step) / 20,
                y: from.y + ((to.y - from.y) * step) / 20,
              },
            ],
          });
          await page.waitForTimeout(16);
        }
        const saved = page.waitForResponse((response) => response.url().endsWith("/items/Item02/move"));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await saved;
        expect(moves).toContainEqual(expect.objectContaining({ columnId: "Col002" }));
        await page.waitForSelector('[data-spaces-kanban-column="column:Col002"] [data-item-id="Item02"]');
        expect(await cardsIn(page, "column:Col002")).toContain("Item02");
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

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
        const cookie = await storedCookie(page, "settings-app-spaces");
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

  test("keyboard: Space, ArrowDown, Space on a grip moves a card one slot down, says where, and keeps focus on its grip", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      moves.splice(0);
      filterRequests.splice(0);
      await page.locator('[data-item-id="Item01"]').focus();
      // The claim button sits between the card link and its grip in the tab order.
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-spaces-claim-action"))).toBe("claim");
      await page.keyboard.press("Shift+Tab");
      expect(await focusedGrip(page)).toBe("Item01");
      await page.keyboard.press("Space");
      await waitForAnnouncement(page, "Picked up Order banners for the spring fair");
      await page.keyboard.press("ArrowDown");
      expect(await page.locator('[data-spaces-kanban-column="column:Col001"] [data-spaces-kanban-drop-indicator]').count()).toBe(1);
      await waitForAnnouncement(page, "To do, position 2 of 3");
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item01/move"));
      const refreshed = page.waitForResponse((response) => response.url().endsWith("/items/filter"));
      await page.keyboard.press("Space");
      await moved;
      expect(moves).toEqual([{ columnId: "Col001", afterItemId: "Item02" }]);
      // The board applies the drop inside a view transition, which WebKit can run a few frames after the response.
      await waitForCards(page, "column:Col001", ["Item02", "Item01", "Item03"]);
      await refreshed;
      await waitForAnnouncement(page, "Dropped Order banners for the spring fair in Column To do");
      expect(filterRequests.length).toBeGreaterThan(0);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item02", "Item01", "Item03"]);
      await waitForGripFocus(page, "Item01");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: ArrowRight then ArrowDown places a card at slot 2 of the next column with its status", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      moves.splice(0);
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowRight");
      await waitForAnnouncement(page, "In progress, position 1 of 3");
      await page.keyboard.press("ArrowDown");
      await waitForAnnouncement(page, "In progress, position 2 of 3");
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item01/move"));
      await page.keyboard.press("Enter");
      await moved;
      expect(moves).toEqual([{ columnId: "Col002", afterItemId: "Item04" }]);
      await waitForGripFocus(page, "Item01");
      expect(await cardsIn(page, "column:Col002")).toEqual(["Item04", "Item01", "Item05"]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item02", "Item03"]);
      expect(await page.getByRole("dialog").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: Escape cancels a move: nothing is sent, the line goes, the workspace does not see Escape, and focus stays", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      moves.splice(0);
      // As the workspace controller: an Escape that reaches the window unprevented closes the detail panel.
      await page.evaluate(() => {
        const escapes: string[] = [];
        Object.assign(window, { __workspaceEscapes: escapes });
        window.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && !event.defaultPrevented) escapes.push(event.key);
        });
      });
      const workspaceEscapes = () => page.evaluate<unknown>(() => Reflect.get(window, "__workspaceEscapes"));
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(1);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(moves).toEqual([]);
      expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(0);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item02", "Item03"]);
      await waitForAnnouncement(page, "Cancelled drag for Order banners for the spring fair");
      expect(await workspaceEscapes()).toEqual([]);
      expect(await focusedGrip(page)).toBe("Item01");
      // Without a move in progress, Escape is the workspace's again.
      await page.keyboard.press("Escape");
      expect(await workspaceEscapes()).toEqual(["Escape"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: ArrowRight skips an automatic column", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      moves.splice(0);
      await page.locator('[data-spaces-kanban-grip="Item02"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowRight");
      await waitForAnnouncement(page, "In progress, position 2 of 3");
      expect(await page.locator('[data-spaces-kanban-column="column:Col002"] [data-spaces-kanban-drop-indicator]').count()).toBe(1);
      expect(await page.locator('[data-spaces-kanban-column="virtual:blocked"] [data-spaces-kanban-drop-indicator]').count()).toBe(0);
      expect((await announcements(page)).some((text) => text.startsWith("Blocked, position"))).toBe(false);
      await page.keyboard.press("ArrowLeft");
      // Pickup already announced this position; returning must announce it again.
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-k2b-live] [data-politeness="polite"] > div')).filter(
            (line) => line.textContent === "To do, position 2 of 3",
          ).length === 2,
      );
      expect(await page.locator('[data-spaces-kanban-column="column:Col002"] [data-spaces-kanban-drop-indicator]').count()).toBe(0);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await waitForAnnouncement(page, "Done, position 2 of 2");
      expect(await page.locator('[data-spaces-kanban-column="virtual:overdue"] [data-spaces-kanban-drop-indicator]').count()).toBe(0);
      await page.keyboard.press("Escape");
      expect(moves).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: dropping into Done a task someone else claimed asks the take-over question once", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      moves.splice(0);
      await page.locator('[data-spaces-kanban-grip="Item04"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      const question = page.getByRole("dialog", { name: "Take over task" });
      await question.waitFor();
      expect(await question.count()).toBe(1);
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(moves).toEqual([]);
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item04/move"));
      await question.getByRole("button", { name: "Take over and complete" }).click();
      await moved;
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ columnId: "Col004", completed: true, claimId: "44444444-4444-4444-8444-444444444444", force: true });
      await question.waitFor({ state: "detached" });
      await waitForGripFocus(page, "Item04");
      expect(await cardsIn(page, "column:Col004")).toContain("Item04");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: a picked-up card says where it is in German", async () => {
    const page = await open(desktop, { locale: "de" });
    try {
      moves.splice(0);
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await waitForAnnouncement(page, "Order banners for the spring fair aufgenommen");
      await waitForAnnouncement(page, "To do, Position 1 von 3");
      await page.keyboard.press("ArrowRight");
      await waitForAnnouncement(page, "In progress, Position 1 von 3");
      await page.keyboard.press("Escape");
      await waitForAnnouncement(page, "Verschieben von Order banners for the spring fair abgebrochen");
      expect(moves).toEqual([]);
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item01/move"));
      await page.keyboard.press("Space");
      await moved;
      await waitForAnnouncement(page, "Order banners for the spring fair in Status To do abgelegt");
      expect(moves).toEqual([{ columnId: "Col001", afterItemId: "Item02" }]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item02", "Item01", "Item03"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: dropping without moving says the card was not moved in English and sends nothing", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      moves.splice(0);
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Space");
      await waitForAnnouncement(page, "Order banners for the spring fair not moved");
      expect(moves).toEqual([]);
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item02", "Item03"]);
      expect(await focusedGrip(page)).toBe("Item01");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const cancellation of ["Tab", "refresh"] as const) {
    test(`keyboard: ${cancellation} while picked up cancels the move`, async () => {
      const page = await open(desktop, { locale: "en" });
      try {
        moves.splice(0);
        await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
        await page.keyboard.press("Space");
        await page.keyboard.press("ArrowDown");
        expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(1);
        if (cancellation === "Tab") await page.keyboard.press("Tab");
        else {
          const refreshed = page.waitForResponse((response) => response.url().endsWith("/items/filter"));
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("spaces-data-invalidated", {
                detail: { domains: ["view"], cursor: null, itemId: null, cover: () => undefined },
              }),
            ),
          );
          await refreshed;
        }
        await waitForAnnouncement(page, "Cancelled drag for Order banners for the spring fair");
        expect(moves).toEqual([]);
        expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(0);
        expect(await cardsIn(page, "column:Col001")).toEqual(["Item01", "Item02", "Item03"]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("keyboard: a card dropped on a folded column goes to its top, and the column's strip takes the focus", async () => {
    const page = await open(desktop, { locale: "en", folded: ["column:Col002"] });
    try {
      moves.splice(0);
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowRight");
      // A folded column offers only its top.
      await waitForAnnouncement(page, "In progress, position 1 of 1");
      const moved = page.waitForResponse((response) => response.url().endsWith("/items/Item01/move"));
      await page.keyboard.press("Space");
      await moved;
      expect(moves).toEqual([{ columnId: "Col002" }]);
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-spaces-kanban-fold") === "column:Col002");
      expect(await cardsIn(page, "column:Col001")).toEqual(["Item02", "Item03"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: while a card is picked up, single-key shortcuts wait and the move stays", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      moves.splice(0);
      // As the workspace controller: an unprevented J or K that reaches the window steps the detail panel.
      await page.evaluate(() => {
        const keys: string[] = [];
        Object.assign(window, { __workspaceKeys: keys });
        window.addEventListener("keydown", (event) => {
          if (!event.defaultPrevented) keys.push(event.key);
        });
      });
      const commandShortcuts = () =>
        page.evaluate(() => {
          const detail = { commands: [] as { shortcut?: string }[] };
          window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail }));
          return detail.commands.flatMap((command) => (command.shortcut ? [command.shortcut] : []));
        });
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      // The card's M and D belong to its link, not to the grip that moves it.
      expect(await commandShortcuts()).toEqual([]);
      for (const key of ["j", "k", "m", "d"]) await page.keyboard.press(key);
      expect(await page.evaluate<unknown>(() => Reflect.get(window, "__workspaceKeys"))).toEqual([]);
      expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(1);
      expect(await focusedGrip(page)).toBe("Item01");
      await page.keyboard.press("Escape");
      expect(moves).toEqual([]);
      // Once the card is down, the keys are the workspace's again.
      await page.keyboard.press("j");
      expect(await page.evaluate<unknown>(() => Reflect.get(window, "__workspaceKeys"))).toEqual(["j"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: Up and Down on a card from an automatic column keep its place and say so", async () => {
    const page = await open(desktop, { locale: "en", buckets: withAutomaticColumns() });
    try {
      await page.locator('[data-spaces-kanban-grip="Item08"]').focus();
      await page.keyboard.press("Space");
      await waitForAnnouncement(page, "Blocked, position 1 of 2");
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-k2b-live] [data-politeness="polite"] > div')).filter(
            (line) => line.textContent === "Blocked, position 1 of 2",
          ).length === 2,
      );
      expect(await page.locator("[data-spaces-kanban-drop-indicator]").count()).toBe(0);
      await page.keyboard.press("Escape");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: a click while a dropped card saves ends the focus restore, so its rollback does not pull focus back", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      let fail!: () => void;
      const failing = new Promise<void>((resolve) => {
        fail = resolve;
      });
      await page.route("**/items/Item01/move", async (route) => {
        await failing;
        await route.fulfill({ status: 500, json: { message: "Move failed" } });
      });
      await page.locator('[data-spaces-kanban-grip="Item01"]').focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      const requested = page.waitForRequest((request) => request.url().endsWith("/items/Item01/move"));
      await page.keyboard.press("Space");
      await requested;
      // While the move saves, a spinner stands in for the grip; the person clicks the page's padding, which takes no focus.
      await page.mouse.click(2, 2);
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      fail();
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-spaces-kanban-column="column:Col001"] [data-spaces-kanban-card]'))
            .map((card) => (card as HTMLElement).dataset.itemId)
            .join() === "Item01,Item02,Item03",
      );
      // The grip is back once the move has ended; a restore would focus it in the same task.
      await page.waitForSelector('[data-spaces-kanban-grip="Item01"]', { state: "attached" });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keyboard: the grip has an accessible description of how to move a card", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      const helpId = "spaces-kanban-grip-help-Space1";
      expect(await page.locator(`#${helpId}`).count()).toBe(1);
      expect(await page.locator(`#${helpId}`).textContent()).toBe(
        "Space picks the card up, the arrow keys move it, Space drops it, Escape cancels.",
      );
      expect((await page.locator('[data-spaces-kanban-grip="Item01"]').getAttribute("aria-describedby"))?.split(/\s+/)).toContain(helpId);
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

describe("wide Spaces surfaces beside Detail", () => {
  for (const [width, height] of [
    [1366, 900],
    [1920, 1080],
  ] as const) {
    for (const workspace of ["kanban", "table"] as const) {
      test(`${width}×${height} ${workspace}: one inset and rounded clipping corners`, async () => {
        const page = await open({ width, height, touch: false }, { locale: "en", workspace, query: `?view=${workspace}` });
        try {
          const selector = workspace === "table" ? ".k2b-table-wrap.k2b-detail-trail" : ".k2b-detail-trail";
          const shape = await page.locator(selector).evaluate((viewport) => {
            const token = (name: string) => {
              const probe = document.createElement("div");
              probe.style.width = `var(${name})`;
              viewport.append(probe);
              const pixels = probe.getBoundingClientRect().width;
              probe.remove();
              return pixels;
            };
            const inset = token("--k2b-workspace-detail-inset");
            const radius = token("--k2b-radius-surface");
            const style = getComputedStyle(viewport);
            const paper = viewport.closest(".k2b-paper");
            return {
              inset,
              // Inside a Paper frame the viewport's corner follows the frame's inner curve, one border smaller.
              radius: radius - (paper ? Number.parseFloat(getComputedStyle(paper).borderRightWidth) : 0),
              // The table's viewport sits inside its Paper frame's border; the frame is the surface's outer edge.
              right: (paper ?? viewport).getBoundingClientRect().right,
              panelLeft: document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().left,
              radii: [
                style.borderTopLeftRadius,
                style.borderTopRightRadius,
                style.borderBottomLeftRadius,
                style.borderBottomRightRadius,
              ].map(Number.parseFloat),
              scrollWidth: viewport.scrollWidth,
              clientWidth: viewport.clientWidth,
              scrollHeight: viewport.scrollHeight,
              clientHeight: viewport.clientHeight,
            };
          });
          expect(shape.scrollWidth).toBeGreaterThan(shape.clientWidth);
          expect(shape.right).toBeCloseTo(shape.panelLeft - shape.inset, 1);
          for (const radius of shape.radii) expect(radius).toBeCloseTo(shape.radius, 1);
          if (workspace === "table") {
            expect(shape.scrollHeight).toBeGreaterThan(shape.clientHeight);
            await page.locator(selector).evaluate((viewport) => {
              viewport.scrollTop = 300;
            });
            const sticky = await page.locator(selector).evaluate((viewport) => ({
              scroll: viewport.scrollTop,
              top: viewport.getBoundingClientRect().top,
              header: viewport.querySelector("thead")!.getBoundingClientRect().top,
            }));
            expect(sticky.scroll).toBeGreaterThan(0);
            expect(sticky.header).toBeCloseTo(sticky.top, 0);
          }
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
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
        assignees: [me, kim, { id: "33333333-3333-4333-8333-333333333333", kind: "user", displayName: "Alex Example", avatarHash: null }],
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
  await card.hover();
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

describe("Spaces Kanban reactions", () => {
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
      // Status, deadline, and three avatars leave room for "Add reaction" but not for a chip beside it.
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
      await card.hover();
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

  test("iPad landscape: holding a chip shows names without lifting; holding the body still lifts", async () => {
    const page = await open(iPadLandscape, reactionScenario());
    try {
      await page.evaluate(() => (document.documentElement.dataset.k2bInput = "touch"));
      const chip = reactionChip(page);
      const point = await center(chip);
      await touchPointer(chip, "pointerdown", 71, point);
      await page.waitForTimeout(600);
      const hint = page.locator(".k2b-reaction-bar__hint:popover-open");
      expect(await hint.count()).toBe(1);
      expect(await hint.textContent()).toContain("Kim Example");
      expect(await liftedCards(page)).toEqual([]);
      await touchPointer(chip, "pointerup", 71, point);
      const body = reactionCard(page).locator("a[data-spaces-kanban-card] p").first();
      const from = await center(body);
      await touchPointer(body, "pointerdown", 72, from);
      try {
        await waitForLiftedCards(page, ["React01"]);
        expect(await liftedCards(page)).toEqual(["React01"]);
      } finally {
        await touchPointer(body, "pointerup", 72, from);
      }
      await waitForLiftedCards(page, []);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a moved card keeps its chips although the move response carries no reactions", async () => {
    const page = await open(desktop, reactionScenario());
    try {
      // Hold the refresh after the drop, so the card shows what the move response left.
      await page.route("**/items/filter", () => undefined);
      const grip = reactionCard(page).locator("[data-dnd-card-handle]");
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
      await reactionCard(page).locator("[data-dnd-card-handle]").focus();
      for (let step = 0; step < 3; step++) await page.keyboard.press("Tab");
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

  test("writer Tab order is grip, claim, card link, chips, Add reaction", async () => {
    const page = await open(desktop, reactionScenario());
    try {
      const card = reactionCard(page);
      const grip = card.locator("[data-dnd-card-handle]");
      await grip.focus();
      expect(await grip.evaluate((element) => element === document.activeElement)).toBe(true);
      for (const selector of [
        "[data-spaces-claim-action]",
        "a[data-spaces-kanban-card]",
        '[data-reaction-key="👍"]',
        '[data-reaction-key="❤️"]',
        '[data-reaction-key="🎉"]',
        'button[aria-label="Add reaction"]',
      ]) {
        await page.keyboard.press("Tab");
        expect(await card.locator(selector).evaluate((element) => element === document.activeElement)).toBe(true);
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("readers get labelled images, no add button or chip tab stops, and no reserved empty row", async () => {
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
      const plain = reactionCard(page, "React03");
      const geometry = await plain.evaluate((card) => {
        const footer = card.querySelector<HTMLElement>("[data-spaces-kanban-card-footer]")!;
        const style = getComputedStyle(card);
        const link = card.querySelector("a[data-spaces-kanban-card]")!;
        return {
          minHeight: getComputedStyle(footer).minHeight,
          footerHeight: footer.getBoundingClientRect().height,
          // The old reader card had the same text, padding, borders, and empty footer margin.
          expectedHeight:
            link.getBoundingClientRect().height +
            Number.parseFloat(style.paddingTop) +
            Number.parseFloat(style.paddingBottom) +
            Number.parseFloat(style.borderTopWidth) +
            Number.parseFloat(style.borderBottomWidth) +
            Number.parseFloat(getComputedStyle(footer).marginTop),
          height: card.getBoundingClientRect().height,
        };
      });
      expect(geometry.minHeight).toBe("0px");
      expect(geometry.footerHeight).toBe(0);
      expect(geometry.height).toBe(geometry.expectedHeight);
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
