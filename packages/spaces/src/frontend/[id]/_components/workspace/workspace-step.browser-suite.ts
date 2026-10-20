import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ItemListResult, SpaceColumn, SpaceItem } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { defaultCalendarFilter } from "../calendar/filter";
import { calendarWindow } from "../calendar/range";
import type { KanbanBucketInitial } from "../kanban/types";
import type { SpaceItemDetail, SpacesViewSnapshot } from "./workspace-types";

const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-workspace-step-browser-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  componentRoots: [import.meta.dir, resolve(import.meta.dir, "../detail")],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: WorkspaceStepFixture } = await import("./workspace-step.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];
const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: null, rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "Review", color: null, rank: "2", isDone: false },
  { id: "Col003", spaceId: "Space1", name: "Ready", color: null, rank: "3", isDone: false },
];
const items: SpaceItem[] = Array.from({ length: 40 }, (_, index) => ({
  id: `Item${String(index + 1).padStart(2, "0")}`,
  spaceId: "Space1",
  columnId: index < 2 ? "Col001" : index === 2 ? "Col002" : "Col003",
  title: `Task ${index + 1}`,
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
  rank: String((index + 1) * 1024),
  completedAt: null,
  createdBy: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  assignees: [],
  tags: [],
  claim: null,
}));
const result: ItemListResult = { items, page: 1, pageSize: 50, total: items.length, totalPages: 1 };
const buckets: KanbanBucketInitial[] = columns.map((column) => {
  const cards = items.filter((item) => item.columnId === column.id);
  return {
    key: `column:${column.id}`,
    label: column.name,
    color: column.color,
    kind: "column",
    columnId: column.id,
    isDone: false,
    items: cards,
    page: 1,
    totalPages: 1,
    total: cards.length,
  };
});
const detail = (item: SpaceItem): SpaceItemDetail => ({
  item,
  comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
  commentTarget: { itemId: item.id, recurrenceId: null },
  recurringContext: null,
  references: [],
  links: [],
  attachments: [],
  checklist: [],
  blockedBy: [],
  blocks: [],
});

type View = "list" | "table" | "kanban" | "calendar";
type Scenario = { view: View; folded?: boolean };
const scenarios: Record<string, Scenario> = {
  list: { view: "list" },
  table: { view: "table" },
  kanban: { view: "kanban" },
  folded: { view: "kanban", folded: true },
  calendar: { view: "calendar" },
};
const sourceFor = (name: string, scenario: Scenario) =>
  `/app/spaces/Space1?case=${name}&view=${scenario.view}${scenario.view === "calendar" ? "&cv=month&cd=2026-10-12&item=Item01" : ""}`;
const serverBody = (name: string, scenario: Scenario) =>
  renderToString(() =>
    createComponent(WorkspaceStepFixture, {
      view: scenario.view,
      source: sourceFor(name, scenario),
      columns,
      itemsResult: result,
      buckets,
      foldedColumns: scenario.folded ? ["column:Col002"] : [],
      initialDetail: scenario.view === "calendar" && items[0] ? detail(items[0]) : null,
    }),
  );
const snapshot = (view: View): SpacesViewSnapshot => {
  if (view === "list" || view === "table") return { kind: "list", currentView: view, itemsResult: result };
  if (view === "kanban") return { kind: "kanban", buckets, wormholes: [] };
  return {
    kind: "calendar",
    view: "month",
    date: "2026-10-12T00:00:00.000Z",
    range: calendarWindow("month", new Date("2026-10-12T00:00:00.000Z")),
    filter: defaultCalendarFilter,
    items: [],
    weather: {},
    tray: null,
  };
};

let css = "";
let controller = "";
const pages = new Map<string, string>();
const pageHtml = (name: string, scenario: Scenario) =>
  '<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh">${serverBody(name, scenario)}</main>` +
  `<script>${controller}</script><script type="module">await Promise.all(Array.from(document.querySelectorAll('solid-island'),(e)=>import('/_ssr/'+e.dataset.id+'.js')));document.documentElement.dataset.workspaceStepReady='true'</script></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.flatMap((build) => build.outputs.map((output) => output.text())))),
  ].join("\n");
  // Cloud's shell installs the shared workspace controller once for the document, as this shipped export does.
  const entry = resolve(import.meta.dir, "workspace-step.controller.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(join(ui, "browser/index.js"))};\ninstallAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the workspace controller.");
  controller = await bundle.outputs[0]!.text();
  for (const [name, scenario] of Object.entries(scenarios)) pages.set(name, pageHtml(name, scenario));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      const itemRequest = /^\/api\/spaces\/Space1\/items\/(\w+)\/(detail|comments\/page)$/.exec(url.pathname);
      if (itemRequest) {
        const item = items.find((entry) => entry.id === itemRequest[1]);
        if (!item) return Response.json({ message: "Not found" }, { status: 404 });
        return Response.json(itemRequest[2] === "detail" ? detail(item) : detail(item).comments);
      }
      if (url.pathname === "/api/spaces/workspace/view") {
        const source = new URL(url.searchParams.get("href") ?? "/", "http://spaces.local");
        return Response.json(snapshot(scenarios[source.searchParams.get("case") ?? "list"]?.view ?? "list"));
      }
      if (url.pathname === "/api/spaces/Space1/items/filter") return Response.json(result);
      if (url.pathname === "/api/spaces/Space1/board") return Response.json(buckets);
      if (url.pathname.startsWith("/api/")) return Response.json([]);
      const html = pages.get(url.searchParams.get("case") ?? "list");
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

type Viewport = { width: number; height: number; touch: boolean };
const desktop: Viewport = { width: 1280, height: 800, touch: false };
const open = async (name: string, viewport: Viewport = desktop) => {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Unknown fixture: ${name}`);
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${server.url.toString().replace(/\/$/, "")}${sourceFor(name, scenario)}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.documentElement.dataset.workspaceStepReady === "true");
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
};
const itemLink = (page: Page, itemId: string) => page.locator(`[data-spaces-item-link][href*="item=${itemId}"]`);
const card = (page: Page, itemId: string) => page.locator(`[data-spaces-kanban-card][data-item-id="${itemId}"]`);
const selected = async (page: Page, itemId: string, title: string) => {
  // The URL changes through the History API; waitForURL would also wait for a document load that never comes.
  await page.waitForFunction((id) => new URL(location.href).searchParams.get("item") === id, itemId);
  await page.locator("#k2b-workspace-detail-space-detail-panel").getByRole("heading", { name: title, exact: true }).waitFor();
};

const noStep = async (page: Page, key: "j" | "k") => {
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-test-step-navigation");
    window.addEventListener("spaces-detail-navigation", () => document.documentElement.setAttribute("data-test-step-navigation", "true"));
  });
  await page.keyboard.press(key);
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-test-step-navigation"))).toBe(false);
};

describe(`Spaces workspace detail stepping in ${browserName}`, () => {
  for (const view of ["list", "table"] as const) {
    test(`${view}: J/K follow rows, replace history, retain selection, and stop at the ends`, async () => {
      const page = await open(view);
      try {
        await itemLink(page, "Item01").click();
        await selected(page, "Item01", "Task 1");
        const historyLength = await page.evaluate(() => history.length);
        await page.keyboard.press("j");
        await selected(page, "Item02", "Task 2");
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        if (view === "list") expect(await itemLink(page, "Item02").getAttribute("aria-current")).toBe("true");
        else expect(await itemLink(page, "Item02").locator("xpath=ancestor::tr").getAttribute("data-selected")).toBe("true");
        await page.keyboard.press("k");
        await selected(page, "Item01", "Task 1");
        await noStep(page, "k");
        expect(new URL(page.url()).searchParams.get("item")).toBe("Item01");
        await itemLink(page, "Item40").click();
        await selected(page, "Item40", "Task 40");
        await noStep(page, "j");
        expect(new URL(page.url()).searchParams.get("item")).toBe("Item40");
        expect(
          await page.locator("#k2b-workspace-detail-space-detail-panel").getByRole("heading", { name: "Task 40", exact: true }).count(),
        ).toBe(1);
        await page.goBack();
        await selected(page, "Item01", "Task 1");
        await page.goBack();
        await page.waitForFunction(() => !new URL(location.href).searchParams.has("item"));
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("rapid J J uses the requested selection before either detail load completes", async () => {
    const page = await open("list");
    try {
      await itemLink(page, "Item01").click();
      await selected(page, "Item01", "Task 1");
      // Hold the first response until the second request proves it did not step from the committed item again.
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/items/Item02/detail", async (route) => {
        await held;
        await route.continue();
      });
      try {
        await itemLink(page, "Item01").focus();
        await page.keyboard.press("j");
        await page.keyboard.press("j");
        await selected(page, "Item03", "Task 3");
      } finally {
        release?.();
      }
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("rapid J J from the panel title keeps focus on the panel title", async () => {
    const page = await open("list");
    try {
      await itemLink(page, "Item01").focus();
      await page.keyboard.press("Enter");
      await selected(page, "Item01", "Task 1");
      await page.waitForFunction(() => document.activeElement?.matches("#k2b-workspace-detail-space-detail-panel h2") === true);
      // The first step swaps the panel to its loading state, which removes the focused title.
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/items/Item02/detail", async (route) => {
        await held;
        await route.continue();
      });
      try {
        await page.keyboard.press("j");
        await page.keyboard.press("j");
        await selected(page, "Item03", "Task 3");
      } finally {
        release?.();
      }
      await page.waitForFunction(
        () =>
          document.activeElement?.matches("#k2b-workspace-detail-space-detail-panel h2") === true &&
          document.activeElement.textContent === "Task 3",
      );
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("J while the opening detail still loads keeps the panel's own history entry", async () => {
    const page = await open("list");
    try {
      const historyLength = await page.evaluate(() => history.length);
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/items/Item01/detail", async (route) => {
        await held;
        await route.continue();
      });
      try {
        await itemLink(page, "Item01").focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("j");
      } finally {
        release?.();
      }
      await selected(page, "Item02", "Task 2");
      expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
      await page.goBack();
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("item"));
      await page.locator("#k2b-workspace-detail-space-detail-panel").waitFor({ state: "hidden" });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("kanban: a step to an item that is gone returns the highlight to the open card", async () => {
    const page = await open("kanban");
    try {
      await card(page, "Item02").click();
      await selected(page, "Item02", "Task 2");
      await page.route("**/items/Item03/detail", (route) => route.fulfill({ status: 404, json: { message: "Not found" } }));
      await page.keyboard.press("j");
      await page.getByText("Item not found").waitFor();
      const highlighted = () =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-spaces-kanban-card]"))
          .filter((link) => link.closest("article")?.getAttribute("data-spaces-kanban-card-state") === "selected")
          .map((link) => link.dataset.itemId);
      await page.waitForFunction(`(${highlighted})().join() === "Item02"`);
      expect(new URL(page.url()).searchParams.get("item")).toBe("Item02");
      await page.locator("#k2b-workspace-detail-space-detail-panel").getByRole("heading", { name: "Task 2", exact: true }).waitFor();
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const name of ["kanban", "folded"] as const) {
    test(`${name}: J crosses columns in DOM order and skips folded cards`, async () => {
      const page = await open(name);
      try {
        if (name === "folded") expect(await card(page, "Item03").count()).toBe(0);
        await card(page, "Item02").click();
        await selected(page, "Item02", "Task 2");
        await page.keyboard.press("j");
        const next = name === "folded" ? "Item04" : "Item03";
        await selected(page, next, name === "folded" ? "Task 4" : "Task 3");
        expect(await card(page, next).evaluate((link) => link.closest("article")?.getAttribute("data-spaces-kanban-card-state"))).toBe(
          "selected",
        );
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("j in the panel's comment field stays text", async () => {
    const page = await open("list");
    try {
      await itemLink(page, "Item01").click();
      await selected(page, "Item01", "Task 1");
      await page.keyboard.press("j");
      await selected(page, "Item02", "Task 2");
      const input = page.locator("#k2b-workspace-detail-space-detail-panel").getByRole("textbox", { name: "Add comment" });
      await input.fill("");
      await noStep(page, "j");
      expect(await input.inputValue()).toBe("j");
      expect(new URL(page.url()).searchParams.get("item")).toBe("Item02");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Calendar leaves J unhandled with an item open", async () => {
    const page = await open("calendar");
    try {
      await selected(page, "Item01", "Task 1");
      await page.evaluate(() => {
        const title = document.querySelector("#k2b-workspace-detail-space-detail-panel h2");
        if (!(title instanceof HTMLElement)) throw new Error("Missing panel title");
        title.tabIndex = -1;
        title.focus();
        window.addEventListener(
          "keydown",
          (event) => {
            if (event.key === "j") document.documentElement.setAttribute("data-test-j-prevented", String(event.defaultPrevented));
          },
          { once: true },
        );
      });
      await page.keyboard.press("j");
      expect(await page.locator("html").getAttribute("data-test-j-prevented")).toBe("false");
      expect(new URL(page.url()).searchParams.get("item")).toBe("Item01");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [name, viewport] of [
    ["tablet drawer", { width: 820, height: 1180, touch: true }],
    ["phone sheet", { width: 390, height: 844, touch: true }],
  ] as const) {
    test(`${name}: J reveals the next row inside Main and above the sheet`, async () => {
      const page = await open("list", viewport);
      try {
        // Put an opening row at the bottom of the scrollport; its successor is outside before the step.
        const openingId = "Item25";
        await itemLink(page, openingId).evaluate((link) => {
          const scroller = link.closest("[data-scroll-preserve]");
          const row = link.closest("[data-space-list-row]");
          if (!(scroller instanceof HTMLElement) || !row) throw new Error("Missing List scrollport");
          scroller.scrollTop += row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
        });
        await itemLink(page, openingId).click();
        await selected(page, openingId, "Task 25");
        await itemLink(page, openingId).focus();
        // The workspace reveals the item's link, the element that takes focus, as when a row is opened.
        await page.waitForFunction(() => {
          const link = document.querySelector('[data-spaces-item-link][href*="item=Item26"]');
          const scroller = link?.closest("[data-scroll-preserve]");
          const sheet = document.querySelector("#k2b-workspace-detail-space-detail-panel");
          if (!link || !scroller || !sheet) return false;
          const bottom = Math.min(scroller.getBoundingClientRect().bottom, innerWidth < 640 ? sheet.getBoundingClientRect().top : Infinity);
          return link.getBoundingClientRect().bottom > bottom + 1;
        });
        await page.keyboard.press("j");
        await selected(page, "Item26", "Task 26");
        await page.waitForFunction(() => {
          const link = document.querySelector('[data-spaces-item-link][href*="item=Item26"]');
          const scroller = link?.closest("[data-scroll-preserve]");
          const sheet = document.querySelector("#k2b-workspace-detail-space-detail-panel");
          if (!link || !scroller || !sheet) return false;
          const box = link.getBoundingClientRect();
          const bounds = scroller.getBoundingClientRect();
          const bottom = Math.min(bounds.bottom, innerWidth < 640 ? sheet.getBoundingClientRect().top : Infinity);
          return box.top >= bounds.top - 1 && box.bottom <= bottom + 1;
        });
        expect(await itemLink(page, "Item26").evaluate((link) => link === document.activeElement)).toBe(true);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  const phone: Viewport = { width: 390, height: 844, touch: true };
  test("phone sheet: K reveals the previous row above Main's top", async () => {
    const page = await open("list", phone);
    try {
      // The opening row starts the scrollport, so its predecessor is out of view above.
      await itemLink(page, "Item25").evaluate((link) => {
        const scroller = link.closest("[data-scroll-preserve]");
        const row = link.closest("[data-space-list-row]");
        if (!(scroller instanceof HTMLElement) || !row) throw new Error("Missing List scrollport");
        scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      });
      await itemLink(page, "Item25").click();
      await selected(page, "Item25", "Task 25");
      const revealed = () => {
        const link = document.querySelector('[data-spaces-item-link][href*="item=Item24"]');
        const scroller = link?.closest("[data-scroll-preserve]");
        return Boolean(link && scroller && link.getBoundingClientRect().top >= scroller.getBoundingClientRect().top - 1);
      };
      expect(await page.evaluate(revealed)).toBe(false);
      await page.keyboard.press("k");
      await selected(page, "Item24", "Task 24");
      await page.waitForFunction(revealed);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("phone sheet: J reveals the next Kanban card in the next column", async () => {
    const page = await open("kanban", phone);
    try {
      await card(page, "Item02").click();
      await selected(page, "Item02", "Task 2");
      expect(await card(page, "Item03").evaluate((link) => link.getBoundingClientRect().right)).toBeGreaterThan(390);
      await page.keyboard.press("j");
      await selected(page, "Item03", "Task 3");
      await page.waitForFunction(() => {
        const box = document.querySelector('[data-spaces-kanban-card][data-item-id="Item03"]')?.getBoundingClientRect();
        return Boolean(box && box.left >= 0 && box.right <= innerWidth);
      });
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
