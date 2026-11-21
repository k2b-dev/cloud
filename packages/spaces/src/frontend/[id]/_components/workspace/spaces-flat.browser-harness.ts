import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceColumn, SpaceItem, SpaceTag, SpaceWormhole } from "@/contracts";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";
import type { KanbanBucketInitial } from "../kanban/types";
import type { SpaceItemDetail } from "./workspace-types";

/**
 * A whole Space, flat (Cloud flach), rendered on the server and hydrated by its real island bundle, with invented
 * content from the approved mockup: the Website-Relaunch Space with four statuses. The browser test and a local
 * preview share it.
 */
const TIME = "2026-11-21T09:00:00+01:00";
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-flat-browser-"));
registerSsrTestPlugin({
  dev: false,
  verbose: false,
  rootDir: root,
  componentRoots: [resolve(import.meta.dir, "../../..")],
});
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpacesFlatFixture } = await import("./spaces-flat.browser-fixture");
const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];

export const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "Offen", color: "#71717a", rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In Arbeit", color: "#2563eb", rank: "2", isDone: false },
  { id: "Col003", spaceId: "Space1", name: "Prüfung", color: "#ca8a04", rank: "3", isDone: false },
  { id: "Col004", spaceId: "Space1", name: "Erledigt", color: "#16a34a", rank: "4", isDone: true },
];
const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Inhalt", color: "#0e7490" },
  { id: "Tag002", spaceId: "Space1", name: "Design", color: "#7c3aed" },
  { id: "Tag003", spaceId: "Space1", name: "Technik", color: "#b45309" },
  { id: "Tag004", spaceId: "Space1", name: "Recht", color: "#be123c" },
  { id: "Tag005", spaceId: "Space1", name: "Struktur", color: "#4d7c0f" },
];
const person = (index: number, displayName: string) => ({
  id: `${index}${index}${index}${index}${index}${index}${index}${index}-${index}${index}${index}${index}-4${index}${index}${index}-8${index}${index}${index}-${String(index).repeat(12)}`,
  kind: "user" as const,
  displayName,
  avatarHash: null,
});
const ms = person(1, "Mara Sommer");
const jk = person(2, "Jonas Keller");
const ar = person(3, "Anna Roth");
const ft = person(4, "Finn Tamm");
const im = person(5, "Ida Maurer");
export const me = ms;
const tagsNamed = (...names: string[]) => tags.filter((entry) => names.includes(entry.name));
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
  deadlineAllDay: true,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: id,
  completedAt: columnId === "Col004" ? "2026-11-13T10:00:00.000Z" : null,
  createdBy: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  lastActivityAt: "2026-11-20T10:00:00.000Z",
  reactions: [],
  assignees: [],
  tags: [],
  ...extra,
});
const baseItems: SpaceItem[] = [
  item("Item01", "Col001", "Impressum und Datenschutz prüfen lassen", {
    priority: "urgent",
    deadline: "2026-11-18",
    tags: tagsNamed("Recht"),
    assignees: [ar],
    description: "Die Kanzlei braucht die neuen Texte bis Freitag, sonst verschiebt sich der Start.",
  }),
  item("Item02", "Col001", "Startseite: Texte gegenlesen", {
    priority: "high",
    deadline: "2026-11-23",
    tags: tagsNamed("Inhalt"),
    assignees: [ms],
  }),
  item("Item03", "Col001", "Bilder für die Teamseite auswählen", {
    priority: "medium",
    deadline: "2026-11-25",
    tags: tagsNamed("Inhalt", "Design"),
    assignees: [ft, ms],
  }),
  item("Item04", "Col001", "Kontaktformular testen", {
    priority: "medium",
    deadline: "2026-11-27",
    tags: tagsNamed("Technik"),
    assignees: [jk],
  }),
  item("Item05", "Col001", "Weiterleitungen der alten Adressen sammeln", { priority: "low", tags: tagsNamed("Technik") }),
  item("Item06", "Col002", "Navigation und Seitenstruktur festlegen", {
    priority: "high",
    deadline: "2026-11-24",
    tags: tagsNamed("Struktur"),
    assignees: [ms, ft],
    description: "Fünf Hauptpunkte, höchstens zwei Ebenen. Entwurf liegt im Notizbuch.",
  }),
  item("Item07", "Col002", "Produktseiten umziehen", {
    priority: "high",
    deadline: "2026-11-30",
    tags: tagsNamed("Inhalt", "Technik"),
    assignees: [jk],
    estimatedDurationMinutes: 960,
    description: "12 von 30 Seiten sind fertig. Bilder kommen aus dem alten System.",
  }),
  item("Item08", "Col002", "Farben und Schriften aus dem Styleguide übernehmen", {
    priority: "medium",
    deadline: "2026-11-26",
    tags: tagsNamed("Design"),
    assignees: [im],
  }),
  item("Item09", "Col003", "Ladezeit der Startseite messen", {
    priority: "low",
    deadline: "2026-11-21",
    tags: tagsNamed("Technik"),
    assignees: [jk],
  }),
  item("Item10", "Col003", "Kontraste auf allen Seitentypen prüfen", {
    priority: "medium",
    deadline: "2026-11-21",
    tags: tagsNamed("Design"),
    assignees: [im],
  }),
  item("Item11", "Col004", "Hosting-Angebote vergleichen", {
    priority: "medium",
    deadline: "2026-11-13",
    tags: tagsNamed("Technik"),
    assignees: [jk],
  }),
  item("Item12", "Col004", "Zielgruppen und Hauptaufgaben der Seite festhalten", {
    priority: "high",
    deadline: "2026-11-10",
    tags: tagsNamed("Struktur"),
    assignees: [ms],
  }),
];
/** Many tasks, so every column and the list scroll. */
const manyItems = (): SpaceItem[] => [
  ...baseItems,
  ...Array.from({ length: 36 }, (_, index) =>
    item(`More${String(index).padStart(2, "0")}`, columns[index % 3]!.id, `Unterseite ${index + 1} umziehen und prüfen`, {
      priority: (["low", "medium", "high"] as const)[index % 3],
      deadline: `2026-12-${String((index % 28) + 1).padStart(2, "0")}`,
      tags: tagsNamed(index % 2 ? "Inhalt" : "Technik"),
      assignees: index % 4 ? [jk] : [],
    }),
  ),
];
const wormholes: SpaceWormhole[] = [];

const detailOf = (item: SpaceItem): SpaceItemDetail => ({
  item: {
    ...item,
    description: "Formular auf der Kontaktseite mit allen Pflichtfeldern absenden, auch vom Telefon.",
    activeBlockerCount: 1,
  },
  comments: {
    items: [
      {
        id: "Cmt001",
        itemId: item.id,
        recurrenceId: null,
        userId: ar.id,
        userName: ar.displayName,
        userAvatarHash: null,
        content: "Der Datenschutztext kommt am Montag von der Kanzlei. Vorher bitte nicht live testen.",
        createdAt: "2026-11-20T15:40:00.000Z",
        updatedAt: "2026-11-20T15:40:00.000Z",
        canEdit: false,
        canDelete: false,
      },
    ],
    page: 1,
    perPage: 50,
    total: 1,
    hasNext: false,
  },
  commentTarget: { itemId: item.id, recurrenceId: null },
  recurringContext: null,
  references: [],
  links: [],
  attachments: [],
  checklist: [
    {
      id: "Chk001",
      label: "Testadresse eingerichtet",
      completed: true,
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
    },
    {
      id: "Chk002",
      label: "Absenden am Rechner und am Telefon",
      completed: false,
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:00:00.000Z",
    },
  ],
  blockedBy: [],
  blocks: [],
});

export type Scenario = {
  view: "list" | "table" | "kanban";
  many?: boolean;
  detail?: boolean;
  /** The board shows the automatic columns Blocked and Overdue. */
  automatic?: boolean;
  /** Columns this person folded, by key. */
  folded?: string[];
  canWrite?: boolean;
  query?: string;
};

let items: SpaceItem[] = baseItems;
const blocked = (entry: SpaceItem) => !entry.completedAt && entry.activeBlockerCount > 0;
const overdue = (entry: SpaceItem) => !entry.completedAt && !blocked(entry) && entry.deadline !== null && entry.deadline < "2026-11-21";
const automaticBucket = (kind: "blocked" | "overdue", all: SpaceItem[]): KanbanBucketInitial => {
  const shown = all.filter(kind === "blocked" ? blocked : overdue);
  return {
    key: `virtual:${kind}`,
    label: kind === "blocked" ? "Blockiert" : "Überfällig",
    color: null,
    kind,
    columnId: null,
    isDone: false,
    items: shown,
    page: 1,
    totalPages: shown.length ? 1 : 0,
    total: shown.length,
  };
};
const withAutomatic = (all: SpaceItem[]): KanbanBucketInitial[] => {
  const status = bucketsOf(all.filter((entry) => !blocked(entry) && !overdue(entry)));
  return [status[0]!, automaticBucket("blocked", all), status[1]!, status[2]!, automaticBucket("overdue", all), status[3]!];
};
let automatic = false;
const bucketsOf = (all: SpaceItem[]): KanbanBucketInitial[] =>
  columns.map((column) => {
    const shown = all.filter((entry) => entry.columnId === column.id);
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
    };
  });

const serverBody = (scenario: Scenario) => {
  const source = `/app/spaces/Space1?view=${scenario.view}${scenario.query ?? ""}`;
  return renderToString(() =>
    createComponent(SpacesFlatFixture, {
      view: scenario.view,
      source,
      columns,
      tags,
      itemsResult: { items, total: items.length, page: 1, pageSize: 100, totalPages: 1, groupCounts: {} },
      buckets: automatic ? withAutomatic(items) : bucketsOf(items),
      folded: scenario.folded ?? [],
      people: [ms, jk, ar, ft, im].map((entry) => ({ ...entry, uid: entry.displayName.split(" ")[0]!.toLowerCase() })),
      wormholes,
      currentUserId: me.id,
      canWrite: scenario.canWrite ?? true,
      detail: scenario.detail ? detailOf(items.find((entry) => entry.id === "Item04")!) : undefined,
    }),
  );
};

/** Pins only the page's Date, not its timers or frames, so drags and animations run as in a browser. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

export type View = { width: number; height: number; touch: boolean };
export type Harness = {
  url: string;
  /** Moves the server received, in order. */
  moves: Array<{ itemId: string; body: Record<string, unknown> }>;
  open: (view: View, scenario: Scenario, options?: { theme?: "light" | "dark"; video?: string }) => Promise<Page>;
  stop: () => Promise<void>;
};

export const startHarness = async (): Promise<Harness> => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  const pages = new Map<string, string>();
  const moves: Harness["moves"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      const move = /^\/api\/spaces\/Space1\/items\/(\w+)\/move$/.exec(url.pathname);
      if (move && request.method === "POST") {
        const body = (await request.json()) as { columnId: string; completed?: boolean };
        moves.push({ itemId: move[1]!, body });
        const moved = items.find((entry) => entry.id === move[1])!;
        const completedAt = body.completed === undefined ? moved.completedAt : body.completed ? TIME : null;
        const { reactions: _reactions, ...written } = moved;
        return Response.json({ ...written, columnId: body.columnId, completedAt });
      }
      if (url.pathname === "/api/spaces/Space1/items/filter") {
        const body = (await request.json()) as { columnIds?: string[]; blocked?: boolean; overdue?: boolean };
        const found = body.blocked
          ? items.filter(blocked)
          : body.overdue
            ? items.filter(overdue)
            : items.filter(
                (entry) =>
                  (!body.columnIds || body.columnIds.includes(entry.columnId)) && (!automatic || (!blocked(entry) && !overdue(entry))),
              );
        return Response.json({ items: found, total: found.length, page: 1, pageSize: 100, totalPages: found.length ? 1 : 0 });
      }
      if (url.pathname === "/api/spaces/workspace/view") return Response.json({ kind: "kanban", buckets: bucketsOf(items), wormholes });
      const html = pages.get(url.searchParams.get("case") ?? "");
      return html
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("Not found", { status: 404 });
    },
  });
  const browser: Browser = await launchBrowser();
  let counter = 0;
  const pageHtml = (scenario: Scenario, theme: "light" | "dark") =>
    `<!doctype html><html lang="de" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
    "<style>solid-client,solid-island{display:contents}</style></head>" +
    `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh">${serverBody(scenario)}</main>` +
    `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;
  return {
    url: server.url.href,
    moves,
    open: async (view, scenario, options = {}) => {
      items = scenario.many
        ? manyItems()
        : scenario.automatic
          ? baseItems.map((entry) => (entry.id === "Item04" ? { ...entry, activeBlockerCount: 1 } : entry))
          : baseItems;
      automatic = scenario.automatic ?? false;
      const id = `case${++counter}`;
      pages.set(id, pageHtml(scenario, options.theme ?? "light"));
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        ...(options.video ? { recordVideo: { dir: options.video, size: { width: view.width, height: view.height } } } : {}),
      });
      await context.addInitScript(pinPageClock, new Date(TIME).getTime());
      const page = await context.newPage();
      await page.goto(`${server.url}app/spaces/Space1?case=${id}&view=${scenario.view}${scenario.query ?? ""}`);
      await page.evaluate(() => window.document.fonts.ready);
      if (scenario.view === "kanban") await page.waitForSelector(".spaces-kanban-board[data-hydrated]", { timeout: 15_000 });
      else await page.waitForSelector("[data-spaces-item-link]", { timeout: 15_000 });
      await page.waitForTimeout(150);
      return page;
    },
    stop: async () => {
      await browser.close();
      server.stop(true);
    },
  };
};
