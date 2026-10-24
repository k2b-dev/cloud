import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { appColors } from "@k2b/cloud/ssr/app-color";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../../ui/test/browser";
import { compareNoteOrder } from "../../../../lib/note-order";
import type { SidebarLevel, SidebarNote, SidebarTreeState } from "../../../../lib/sidebar-tree";
import { extractTags } from "../../../lib/tag-extract";
import type { NotebookContext } from "./types";

/** A note of the fake notebook: a sidebar row plus the Markdown its tags come from. */
type NoteTreeNode = SidebarNote & { contentMd: string; children: NoteTreeNode[] };

// Icon size, row alignment, theme colours and the accessible names of the tree need real layout and a real
// accessibility tree, so the real sidebar runs in a browser with the shipped stylesheets.
const buildHarness = async (): Promise<string> => {
  // `[id]` in this path is no URL segment, so paths resolve from the directory instead of `import.meta.url`.
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebook-sidebar.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-notebook-sidebar-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Notebook sidebar harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const note = (id: string, title: string, children: NoteTreeNode[] = [], parentId: string | null = null, position = 0): NoteTreeNode => ({
  id,
  parentId,
  title,
  position,
  hasChildren: children.length > 0,
  contentMd: `Notes about ${title}.`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lockedAt: null,
  children,
});

const row = (node: NoteTreeNode): SidebarNote => ({
  id: node.id,
  parentId: node.parentId,
  title: node.title,
  position: node.position,
  hasChildren: node.children.length > 0,
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
  lockedAt: node.lockedAt,
});
const byDate = (field: "createdAt" | "updatedAt") => (left: NoteTreeNode, right: NoteTreeNode) =>
  right[field].localeCompare(left[field]) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
/** A level in the server's order: the notebook order or newest first, the homepage leading its own level. */
const ordered = (level: NoteTreeNode[], sort: string, homepageId: string | null): NoteTreeNode[] => {
  const sorted = [...level].sort(
    sort === "title" ? compareNoteOrder("en", (node: NoteTreeNode) => node.id) : byDate(sort === "created" ? "createdAt" : "updatedAt"),
  );
  const home = sorted.findIndex((node) => node.id === homepageId);
  if (home > 0) sorted.unshift(...sorted.splice(home, 1));
  return sorted;
};
/** A small notebook as the server hands it over: every level complete, every branch open. */
const stateOf = (tree: NoteTreeNode[], homepageId: string | null = "Home01", sort = "title"): SidebarTreeState => {
  const levels: SidebarLevel[] = [];
  const expandedIds: string[] = [];
  const visit = (level: NoteTreeNode[], parentId: string | null) => {
    levels.push({ parentId, total: level.length, offset: 0, items: ordered(level, sort, homepageId).map(row) });
    for (const node of level)
      if (node.children.length > 0) {
        expandedIds.push(node.id);
        visit(node.children, node.id);
      }
  };
  visit(tree, null);
  return { total: levels.reduce((sum, level) => sum + level.total, 0), levels, expandedIds };
};
const flatten = (nodes: NoteTreeNode[]): NoteTreeNode[] => nodes.flatMap((node) => [node, ...flatten(node.children)]);

/** The maintainer's example: the homepage "Overview" sits among top-level notes and one note with sub-notes. */
const defaultTree = () => [
  note("Reels1", "Reels"),
  note("Rules1", "Content rules", [note("Lang01", "Language", [], "Rules1")]),
  note("Home01", "Overview"),
  note("Exam01", "Examples"),
];
const ctx = (homepageNoteId: string | null = "Home01"): NotebookContext => ({
  notebook: {
    id: "Book01",
    name: "Social media",
    description: null,
    icon: null,
    homepageNoteId,
    defaultPresentationMode: "write",
    defaultNoteTitleTemplate: "",
    noteDeletePermission: "write",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  sidebarTree: stateOf(defaultTree(), homepageNoteId),
  sidebarList: null,
  selectedNoteId: null,
  userId: "user01",
  settings: { lastNoteId: null, richMode: "rich", treeSort: "title" },
  navigationHidden: false,
  fullWidth: false,
  permission: "read",
  attachmentCount: 0,
  favoriteNoteIds: [],
  tags: [],
  workspaceCursor: null,
  dateConfig: { locale: "en", timeZone: "UTC" },
  sidebarFilter: {},
});

/**
 * The notebook API the sidebar talks to, with the server's order rules: placing a note renumbers the named level
 * 1..n, a neighbour outside that level is refused, sorting alphabetically sets the level back to 0, and the
 * workspace state returns the result.
 */
const api = {
  notebook: ctx().notebook,
  tree: [] as NoteTreeNode[],
  favoriteNoteIds: [] as string[],
  tags: [] as NotebookContext["tags"],
  requests: [] as { path: string; body: unknown }[],
};
const levelOf = (nodes: NoteTreeNode[], id: string | null): NoteTreeNode[] | null => {
  if (id === null) return nodes;
  for (const node of nodes) {
    if (node.id === id) return node.children;
    const found = levelOf(node.children, id);
    if (found) return found;
  }
  return null;
};
const parentOf = (nodes: NoteTreeNode[], id: string): string | null => {
  const walk = (level: NoteTreeNode[], parent: string | null): string | null | undefined => {
    for (const node of level) {
      if (node.id === id) return parent;
      const found = walk(node.children, node.id);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(nodes, null) ?? null;
};
const handleApi = async (request: Request, path: string): Promise<Response> => {
  const query = new URL(request.url).searchParams;
  if (path === "workspace-state")
    return Response.json({ notebook: api.notebook, favoriteNoteIds: api.favoriteNoteIds, tags: api.tags, attachmentCount: 0 });
  if (path === "tree/levels") {
    const levels = (query.get("levels") ?? "").split(",").filter(Boolean);
    return Response.json({
      levels: levels.map((entry) => {
        const [parent = "", offset = "0", limit = "100"] = entry.split(":");
        const level = ordered(levelOf(api.tree, parent || null) ?? [], query.get("sort") ?? "title", api.notebook.homepageNoteId);
        return {
          parentId: parent || null,
          total: level.length,
          offset: Number(offset),
          items: level.slice(Number(offset), Number(offset) + Number(limit)).map(row),
        };
      }),
      expandedIds: [],
    });
  }
  if (path === "tree/list") {
    const view = query.get("view");
    const notes = flatten(api.tree)
      .filter((node) =>
        view === "favorites"
          ? api.favoriteNoteIds.includes(node.id)
          : view === "tag"
            ? extractTags(node.contentMd).includes(query.get("tag")!)
            : true,
      )
      .sort(byDate("updatedAt"))
      .slice(0, view === "recents" ? 12 : 100);
    return Response.json({
      total: notes.length,
      offset: 0,
      items: notes.map((node) => ({ ...row(node), tags: extractTags(node.contentMd) })),
    });
  }
  const body = (await request.json()) as { before?: string; after?: string; parentId?: string | null; favorite?: boolean };
  api.requests.push({ path, body });
  if (path.endsWith("/favorite")) return Response.json({ favorite: body.favorite });
  const moved = /^notes\/(\w+)\/move$/u.exec(path)?.[1];
  const anchor = body.before ?? body.after;
  const level = levelOf(api.tree, moved && !("parentId" in body) ? parentOf(api.tree, anchor!) : (body.parentId ?? null));
  if (!level) return new Response("Not found", { status: 404 });
  if (moved && !level.some((node) => node.id === anchor))
    return Response.json({ message: "The anchor note is not in the target level" }, { status: 400 });
  if (moved) {
    const order = level.filter((node) => node.id !== moved).sort(compareNoteOrder("en", (node: NoteTreeNode) => node.id));
    const index = order.findIndex((node) => node.id === anchor);
    order.splice(body.before ? index : index + 1, 0, level.find((node) => node.id === moved)!);
    order.forEach((node, index) => {
      node.position = index + 1;
    });
  } else for (const node of level) node.position = 0;
  return Response.json({ message: "ok" });
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../styles/app.css")));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/notebooks/Book01/")) return handleApi(request, url.pathname.slice("/api/notebooks/Book01/".length));
    if (url.pathname === "/api/notebooks" || url.pathname === "/api/notebooks/")
      return Response.json({
        data: [api.notebook, { ...api.notebook, id: "Book02", name: "Recipes", icon: "ti ti-chef-hat" }],
        pagination: { page: 1, per_page: 100, total: 2, total_pages: 1, has_next: false },
      });
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    return new Response(
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0;height:100vh;display:flex;flex-direction:column">' +
        '<div id="root" style="display:flex;flex:1;min-height:0"></div><div id="phone-menu"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const open = async (context: BrowserContextOptions, value: NotebookContext, locale = "en", theme: "light" | "dark" = "light") => {
  const page = await (await browser.newContext(context)).newPage();
  await page.goto(new URL("/app/notebooks/Book01", server.url).href);
  await page.evaluate((name) => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(name);
  }, theme);
  await page.evaluate(({ value, locale }) => window.mountNotebookSidebar(value, locale), { value, locale });
  return page;
};

/** Box and colour of the leading icon of each top-level tree row, in tree order. */
const rowIcons = (page: Page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="tree"] > [role="treeitem"]'));
    return rows.map((row) => {
      const control = row.firstElementChild!.getBoundingClientRect();
      const icon = row.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-icon")!;
      const box = icon.getBoundingClientRect();
      const label = row.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-item-label")!.getBoundingClientRect();
      return {
        id: row.dataset.k2bNavTreeId,
        glyph: icon.querySelector("i")!.className,
        left: box.left,
        width: box.width,
        height: box.height,
        labelLeft: label.left,
        rowHeight: control.height,
        color: getComputedStyle(icon).color,
      };
    });
  });

describe("Notebook sidebar homepage in the tree", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`the tree lists the homepage first with a home icon that sits like every other icon (${theme})`, async () => {
      const page = await open(desktop, ctx(), "en", theme);
      try {
        const rows = await rowIcons(page);
        expect(rows.map((row) => [row.id, row.glyph])).toEqual([
          ["Home01", "ti ti-home"],
          ["Rules1", "ti ti-files"],
          ["Exam01", "ti ti-file-text"],
          ["Reels1", "ti ti-file-text"],
        ]);
        // Rows with sub-notes carry the disclosure and are compared with each other elsewhere; leaves share one size.
        const [home, ...others] = rows.filter((row) => row.glyph !== "ti ti-files");
        for (const other of others) {
          expect({
            left: home!.left,
            width: home!.width,
            height: home!.height,
            labelLeft: home!.labelLeft,
            rowHeight: home!.rowHeight,
          }).toEqual({
            left: other.left,
            width: other.width,
            height: other.height,
            labelLeft: other.labelLeft,
            rowHeight: other.rowHeight,
          });
          expect(home!.color).toBe(other.color);
        }
        expect(await page.getByRole("treeitem", { name: "Homepage Overview", exact: true }).count()).toBe(1);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("the keyboard reaches and opens the homepage from the tree", async () => {
    const page = await open(desktop, ctx());
    try {
      await page.locator('[data-k2b-nav-tree-id="Rules1"]').focus();
      await page.keyboard.press("ArrowUp");
      // A focused row also shows its menu button, which joins its accessible name.
      const home = page.locator('[data-k2b-nav-tree-id="Home01"]');
      expect(await home.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.openedNotes)).toEqual(["/app/notebooks/Book01/notes/Home01"]);
      expect(await home.getAttribute("aria-selected")).toBe("true");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the tree names the home icon in German and keeps the homepage first", async () => {
    const page = await open(desktop, ctx(), "de");
    try {
      expect((await rowIcons(page)).map((row) => row.glyph)).toEqual(["ti ti-home", "ti ti-files", "ti ti-file-text", "ti ti-file-text"]);
      expect(await page.getByRole("treeitem", { name: "Startseite Overview", exact: true }).count()).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("on a phone the menu lists the homepage first with a named home icon in a row like the others", async () => {
    const page = await open(phone, ctx());
    try {
      await page.evaluate(() => window.mountPhoneMenu("en"));
      const link = page.locator("#phone-menu").getByRole("link", { name: "Homepage Overview", exact: true });
      expect(await link.count()).toBe(1);
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('#phone-menu a.k2b-navigation__control[href*="/notes/"]')).map((row) => ({
          text: row.textContent,
          height: row.getBoundingClientRect().height,
          width: row.getBoundingClientRect().width,
          icon: row.querySelector("i")!.getBoundingClientRect().width,
        })),
      );
      expect(rows.map((row) => row.text)).toEqual(["Overview", "Content rules", "Language", "Examples", "Reels"]);
      expect(new Set(rows.map((row) => `${row.height}:${row.icon}`)).size).toBe(1);
      // The note rows share one width, so the homepage row ends where the others do.
      expect(rows[0]!.width).toBe(rows[3]!.width);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("One notebook sidebar with quick filters", () => {
  const LONG_TAG = "project/garden-renovation-2026";
  const filtered = (): NotebookContext => {
    const base = ctx();
    const dated = (node: NoteTreeNode, updatedAt: string, contentMd: string): NoteTreeNode => ({ ...node, updatedAt, contentMd });
    const start = defaultTree();
    const tree = [
      dated(start[0]!, "2026-09-01T00:00:00.000Z", "Short videos #video #social #weekly"),
      { ...start[1]!, children: [dated(start[1]!.children[0]!, "2026-10-01T00:00:00.000Z", `Tone #${LONG_TAG}`)] },
      start[2]!,
      dated(start[3]!, "2026-08-01T00:00:00.000Z", `Samples #video #${LONG_TAG}`),
    ];
    api.tree = structuredClone(tree);
    api.favoriteNoteIds = ["Reels1", "Exam01"];
    api.tags = [
      { tag: "video", count: 2 },
      { tag: LONG_TAG, count: 2 },
    ];
    api.requests = [];
    return { ...base, sidebarTree: stateOf(tree), favoriteNoteIds: [...api.favoriteNoteIds], tags: [...api.tags] };
  };
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`pressed sidebar chips use the notebook navigation fill and ink at ${viewport.width}px`, async () => {
      const page = await open({ viewport, reducedMotion: "reduce" }, filtered());
      try {
        await page.clock.setFixedTime(new Date("2026-10-01T12:00:00Z"));
        await page.evaluate((style) => {
          const root = document.querySelector<HTMLElement>("#root")!;
          root.classList.add("app-accent-scope");
          root.style.cssText += `;${style}`;
          const old = document.createElement("span");
          old.id = "old-chip";
          old.style.cssText = "background:color-mix(in srgb,var(--app-accent) 14%,var(--k2b-surface))";
          root.append(old);
        }, appAccentStyle("#eab308")!);
        // The sidebar remains in the DOM on phones, as the source of the shared phone navigation.
        await page
          .locator(".notebook-sidebar-chip")
          .filter({ hasText: "Favorites" })
          .evaluate((button) => (button as HTMLButtonElement).click());
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate((theme) => {
            document.documentElement.className = theme;
          }, theme);
          await settled(page);
          const colors = await page.evaluate(() => {
            const chip = getComputedStyle(document.querySelector('.notebook-sidebar-chip[aria-pressed="true"]')!);
            const old = getComputedStyle(document.querySelector("#old-chip")!);
            return { fill: chip.backgroundColor, ink: chip.color, oldFill: old.backgroundColor };
          });
          expect(colors.fill, theme).toBe(rgb(appColors("#eab308")[theme].selectedNav));
          expect(colors.ink, theme).toBe(rgb(appColors("#eab308")[theme].ink));
          expect(colors.fill).not.toBe(colors.oldFill);
        }
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  /** Top of the scrolling note area and the height of the chips row: neither may move when a filter changes. */
  const frame = (page: Page) =>
    page.evaluate(() => ({
      body: document.querySelector(".k2b-app-workspace__sidebar-body")!.getBoundingClientRect().top,
      chips: document.querySelector(".notebook-sidebar-chips")!.getBoundingClientRect().height,
    }));
  const listed = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="tree"] > [role="treeitem"]')).map((row) => ({
        id: row.dataset.k2bNavTreeId,
        meta: row.querySelector(".k2b-app-workspace__sidebar-item-description")?.textContent ?? null,
      })),
    );

  for (const theme of ["light", "dark"] as const) {
    test(`chips turn the tree into a list newest first and back, and nothing above the list moves (${theme})`, async () => {
      const page = await open(desktop, filtered(), "en", theme);
      try {
        const before = await frame(page);
        const favorites = page.getByRole("button", { name: "Favorites" });
        await settled(page);
        const idle = await favorites.evaluate((element) => getComputedStyle(element).backgroundColor);
        await favorites.click();
        expect(await favorites.getAttribute("aria-pressed")).toBe("true");
        // The chip fades its fill in; a read during the fade sees the idle fill.
        await settled(page);
        expect(await favorites.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(idle);
        expect((await listed(page)).map((row) => row.id)).toEqual(["Reels1", "Exam01"]);
        // At most two tags follow the date.
        expect((await listed(page))[0]!.meta).toMatch(/ · #video #social$/);
        expect(await page.locator(".notebook-sidebar-filter__label").textContent()).toBe("Favorites 2 notes");
        expect(await frame(page)).toEqual(before);

        await page.getByRole("button", { name: "Tags" }).click();
        await page.getByRole("menuitemradio", { name: new RegExp(LONG_TAG) }).click();
        expect(await page.getByRole("button", { name: `Tags: ${LONG_TAG}` }).getAttribute("aria-current")).toBe("true");
        expect(await favorites.getAttribute("aria-pressed")).toBe("false");
        expect((await listed(page)).map((row) => row.id)).toEqual(["Lang01", "Exam01"]);
        // A long tag in the chip neither wraps the row nor moves the list.
        expect(await frame(page)).toEqual(before);

        await page.getByRole("button", { name: "Clear filter" }).click();
        expect((await listed(page)).map((row) => row.id)).toEqual(["Home01", "Rules1", "Exam01", "Reels1"]);
        expect(await frame(page)).toEqual(before);
        expect(new URL(page.url()).search).toBe("");
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a listed note opens with the filter kept, and the keyboard moves through the list and opens its menu", async () => {
    const page = await open(desktop, filtered());
    try {
      await page.getByRole("button", { name: "Recent" }).click();
      expect(new URL(page.url()).search).toBe("?view=recents");
      expect((await listed(page)).map((row) => row.id)).toEqual(["Lang01", "Reels1", "Exam01", "Rules1", "Home01"]);

      await page.getByRole("treeitem", { name: /Reels/ }).click();
      expect(await page.evaluate(() => window.openedNotes)).toEqual(["/app/notebooks/Book01/notes/Reels1?view=recents"]);
      expect(await page.locator(".notebook-sidebar-filter__label").textContent()).toBe("Recently changed 5 notes");
      expect(await page.getByRole("treeitem", { name: /Reels/ }).getAttribute("aria-selected")).toBe("true");

      await page.getByRole("treeitem", { name: /Reels/ }).focus();
      await page.keyboard.press("ArrowDown");
      const examples = page.getByRole("treeitem", { name: /Examples/ });
      expect(await examples.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Shift+F10");
      const remove = page.getByRole("menuitem", { name: "Remove favorite" });
      await remove.waitFor();
      // The menu opens beside the focused row, not at the top of the list.
      const [row, menu] = await Promise.all([examples.boundingBox(), page.locator(".k2b-context-menu").boundingBox()]);
      expect(Math.abs(menu!.y - row!.y)).toBeLessThan(row!.height);
      await remove.click();
      await page.waitForFunction(() => document.querySelectorAll(".k2b-context-menu").length === 0);
      expect(api.requests).toEqual([{ path: "notes/Exam01/favorite", body: { favorite: false } }]);

      await page.getByRole("button", { name: "Favorites" }).click();
      expect((await listed(page)).map((row) => row.id)).toEqual(["Reels1"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a link in a note to another note shows the tree, and Back shows the list again", async () => {
    const page = await open(desktop, filtered());
    try {
      await page.getByRole("button", { name: "Favorites" }).click();
      await page.getByRole("treeitem", { name: /Reels/ }).click();
      expect(new URL(page.url()).search).toBe("?view=favorites");
      // A link in the note's text names no filter. The editor announces the note before the history shows its address.
      await page.evaluate(() => {
        const link = document.createElement("a");
        link.href = "/app/notebooks/Book01/notes/Rules1";
        link.textContent = "Content rules";
        document.querySelector(".notebook-document-surface")!.append(link);
      });
      await page.locator(".notebook-document-surface a").click();
      expect(await page.evaluate(() => window.openedNotes.at(-1))).toBe("/app/notebooks/Book01/notes/Rules1");
      expect(new URL(page.url()).search).toBe("");
      expect((await listed(page)).map((row) => row.id)).toEqual(["Home01", "Rules1", "Exam01", "Reels1"]);
      expect(await page.locator(".notebook-sidebar-filter").count()).toBe(0);

      await page.goBack();
      await page.locator(".notebook-sidebar-filter").waitFor();
      expect(new URL(page.url()).search).toBe("?view=favorites");
      expect((await listed(page)).map((row) => row.id)).toEqual(["Reels1", "Exam01"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the chosen tag again shows the tree, and a live change keeps every listed note in its place", async () => {
    const page = await open(desktop, filtered());
    try {
      await page.getByRole("button", { name: "Tags" }).click();
      await page.getByRole("menuitemradio", { name: /^video/ }).click();
      expect((await listed(page)).map((row) => row.id)).toEqual(["Reels1", "Exam01"]);
      await page.getByRole("button", { name: "Tags: video" }).click();
      await page.getByRole("menuitemradio", { name: /^video/ }).click();
      expect(new URL(page.url()).search).toBe("");
      expect((await listed(page)).map((row) => row.id)).toEqual(["Home01", "Rules1", "Exam01", "Reels1"]);

      await page.getByRole("button", { name: "Favorites" }).click();
      expect((await listed(page)).map((row) => row.id)).toEqual(["Reels1", "Exam01"]);
      const rows = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[role="tree"] > [role="treeitem"]')).map((row) => row.getBoundingClientRect().top),
        );
      const before = await rows();
      const date = (await listed(page)).find((row) => row.id === "Exam01")!.meta;
      // Someone saves Examples, which makes it the newest favorite.
      api.tree.find((node) => node.id === "Exam01")!.updatedAt = "2026-10-02T00:00:00.000Z";
      await page.evaluate(
        (exam) =>
          new Promise<void>((done) => {
            const covered: Promise<void>[] = [];
            window.dispatchEvent(
              new CustomEvent("notebooks.workspace.event", {
                detail: {
                  cursor: null,
                  event: { type: "note.updated", note: exam },
                  cover: (coverage: Promise<void>) => covered.push(coverage),
                },
              }),
            );
            void Promise.all(covered).then(() => done());
          }),
        api.tree.find((node) => node.id === "Exam01"),
      );
      // The row shows the new date in its place.
      await page.waitForFunction(
        (date) =>
          document.querySelector('[data-k2b-nav-tree-id="Exam01"] .k2b-app-workspace__sidebar-item-description')?.textContent !== date,
        date,
      );
      expect((await listed(page)).map((row) => row.id)).toEqual(["Reels1", "Exam01"]);
      expect(await rows()).toEqual(before);
      // Choosing the filter anew sorts it newest first.
      await page.getByRole("button", { name: "Favorites" }).click();
      await page.getByRole("button", { name: "Favorites" }).click();
      expect((await listed(page)).map((row) => row.id)).toEqual(["Exam01", "Reels1"]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a right-click on a tree row opens the note menu, and the notebook name switches notebooks", async () => {
    const page = await open(desktop, { ...filtered(), permission: "write" });
    try {
      await page.getByRole("treeitem", { name: "Examples" }).click({ button: "right" });
      const menu = page.locator(".k2b-context-menu");
      await menu.waitFor();
      const items = await menu.getByRole("menuitem").allTextContents();
      expect(items.slice(0, 2)).toEqual(["New subnote", "Remove favorite"]);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Social media" }).click();
      await page.getByRole("link", { name: "Recipes", exact: true }).waitFor();
      expect(await page.getByRole("link", { name: "Recipes", exact: true }).getAttribute("href")).toBe("/app/notebooks/Book02");
      expect(await page.locator('[data-switcher-option][aria-current="true"]').getAttribute("href")).toBe("/app/notebooks/Book01");
      expect(await page.getByRole("link", { name: "All notebooks", exact: true }).getAttribute("href")).toBe("/app/notebooks");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the phone menu uses the same notebook head and overview action", async () => {
    const page = await open(phone, filtered(), "de");
    try {
      await page.evaluate(() => window.mountPhoneMenu("de", true));
      const menu = page.locator("#phone-menu");
      expect(await menu.locator(".k2b-sidebar-switcher__trigger").getAttribute("aria-label")).toBe("Social media");
      expect(await menu.locator(".k2b-sidebar-switcher .k2b-sr-only").textContent()).toContain("Notizbuch wechseln");
      expect(await menu.locator('a.k2b-navigation__control[href="/app/notebooks"]').count()).toBe(0);
      await menu.getByRole("button", { name: "Social media", exact: true }).click();
      await menu.getByRole("link", { name: "Recipes", exact: true }).waitFor();
      expect(await menu.getByRole("link", { name: "Alle Notizbücher", exact: true }).getAttribute("href")).toBe("/app/notebooks");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("on a phone the menu offers the same filters, shows the list right away and lists notes with their dates", async () => {
    const page = await open(phone, filtered(), "de");
    try {
      await page.evaluate(() => window.mountPhoneMenu("de", true));
      const menu = page.locator("#phone-menu");
      // A filter changes only what the menu shows, so the menu stays open with the list.
      await menu.getByRole("button", { name: "Favoriten", exact: true }).click();
      await menu.getByText("Favoriten · 2 Notizen").waitFor();
      expect(await page.evaluate(() => window.phoneMenuClosed)).toBe(false);
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('#phone-menu a.k2b-navigation__control[href*="/notes/"]')).map((row) => ({
          href: row.getAttribute("href"),
          text: row.textContent,
        })),
      );
      expect(rows.map((row) => row.href)).toEqual([
        "/app/notebooks/Book01/notes/Reels1?view=favorites",
        "/app/notebooks/Book01/notes/Exam01?view=favorites",
      ]);
      expect(rows[0]!.text).toContain("#video #social");
      await menu.getByRole("button", { name: "Filter aufheben" }).click();
      await menu.getByRole("link", { name: "Startseite Overview" }).waitFor();

      await menu.getByRole("button", { name: "Tags", exact: true }).click();
      await menu.getByRole("button", { name: /^video/ }).click();
      await menu.getByText("#video · 2 Notizen").waitFor();
      expect(new URL(page.url()).search).toBe("?view=tag&tag=video");
      // The tag again shows the tree again, as on the desktop.
      await menu.getByRole("button", { name: /^video/ }).click();
      await menu.getByRole("link", { name: "Startseite Overview" }).waitFor();
      await menu.getByRole("button", { name: "Notizen sortieren" }).click();
      await menu.getByRole("button", { name: "Zuletzt geändert" }).click();
      // The homepage leads; the newest note follows it.
      await page.waitForFunction(
        () => document.querySelectorAll('#phone-menu a.k2b-navigation__control[href*="/notes/"]')[1]?.textContent === "Reels",
      );
      expect(await page.evaluate(() => window.phoneMenuClosed)).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("Notebook sidebar order by hand", () => {
  // Top level: the homepage leads, the rest reads by title until someone arranges it.
  const writable = (tree: NoteTreeNode[]): NotebookContext => {
    api.tree = structuredClone(tree);
    api.favoriteNoteIds = [];
    api.tags = [];
    api.requests = [];
    return { ...ctx(), sidebarTree: stateOf(tree), permission: "write" };
  };
  const startTree = () => [
    note("Reels1", "Reels"),
    note("Rules1", "Content rules", [note("Lang01", "Language", [], "Rules1"), note("Tone01", "Tone", [], "Rules1")]),
    note("Home01", "Overview"),
    note("Exam01", "Examples"),
  ];
  const order = (page: Page, parent: string | null = null) =>
    page.evaluate(
      (parent) =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            parent ? `[data-k2b-nav-tree-parent-id="${parent}"]` : '[role="tree"] > [role="treeitem"]',
          ),
        ).map((row) => row.dataset.k2bNavTreeId),
      parent,
    );
  const rowBoxes = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).map((row) => {
        const box = row.getBoundingClientRect();
        return [row.dataset.k2bNavTreeId, box.top, box.height];
      }),
    );
  const row = (page: Page, id: string) => page.locator(`[data-k2b-nav-tree-id="${id}"] > :first-child`);

  test("a writer drags a note to a new place; a line marks the gap without moving any row, and the tree shows the saved order", async () => {
    const page = await open(desktop, writable(startTree()));
    try {
      expect(await order(page)).toEqual(["Home01", "Rules1", "Exam01", "Reels1"]);
      const before = await rowBoxes(page);
      const source = await row(page, "Reels1").boundingBox();
      const target = await row(page, "Rules1").boundingBox();
      await page.mouse.move(source!.x + 40, source!.y + source!.height / 2);
      await page.mouse.down();
      await page.mouse.move(target!.x + 40, target!.y + 6, { steps: 8 });
      await page.mouse.move(target!.x + 40, target!.y + 4, { steps: 2 });
      expect(await page.locator('[data-k2b-nav-tree-drop="before"]').getAttribute("data-k2b-nav-tree-id")).toBe("Rules1");
      expect(await rowBoxes(page)).toEqual(before);
      await page.mouse.up();
      await page.waitForFunction(
        () => document.querySelector('[role="tree"] > [role="treeitem"]:nth-child(2)')?.getAttribute("data-k2b-nav-tree-id") === "Reels1",
      );
      expect(api.requests).toEqual([{ path: "notes/Reels1/move", body: { parentId: null, before: "Rules1" } }]);
      expect(await order(page)).toEqual(["Home01", "Reels1", "Rules1", "Exam01"]);
      expect(await page.locator("[data-k2b-nav-tree-drop]").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("nothing moves above the homepage or into another level", async () => {
    const page = await open(desktop, writable(startTree()));
    try {
      expect(await page.locator('[data-k2b-nav-tree-id="Home01"]').getAttribute("draggable")).toBeNull();
      const source = await row(page, "Exam01").boundingBox();
      const home = await row(page, "Home01").boundingBox();
      const child = await row(page, "Lang01").boundingBox();
      await page.mouse.move(source!.x + 40, source!.y + source!.height / 2);
      await page.mouse.down();
      await page.mouse.move(home!.x + 40, home!.y + 4, { steps: 8 });
      expect(await page.locator("[data-k2b-nav-tree-drop]").count()).toBe(0);
      await page.mouse.move(child!.x + 40, child!.y + 4, { steps: 8 });
      expect(await page.locator("[data-k2b-nav-tree-drop]").count()).toBe(0);
      await page.mouse.up();
      expect(api.requests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("Alt+Arrow moves the focused note within its level and keeps the focus on it", async () => {
    const page = await open(desktop, writable(startTree()));
    try {
      await page.locator('[data-k2b-nav-tree-id="Tone01"]').focus();
      await page.keyboard.press("Alt+ArrowUp");
      await page.waitForFunction(
        () => document.querySelector('[data-k2b-nav-tree-parent-id="Rules1"]')?.getAttribute("data-k2b-nav-tree-id") === "Tone01",
      );
      expect(api.requests).toEqual([{ path: "notes/Tone01/move", body: { parentId: "Rules1", before: "Lang01" } }]);
      expect(await order(page, "Rules1")).toEqual(["Tone01", "Lang01"]);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.k2bNavTreeId)).toBe("Tone01");
      expect(await page.locator('[data-k2b-nav-tree-id="Tone01"]').getAttribute("aria-posinset")).toBe("1");

      // The first note has no place further up, and plain arrows still only move the focus.
      await page.keyboard.press("Alt+ArrowUp");
      await page.keyboard.press("ArrowDown");
      expect(api.requests.length).toBe(1);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.k2bNavTreeId)).toBe("Lang01");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a neighbour that left the level on screen moves nothing; the tree reloads and says why", async () => {
    const page = await open(desktop, writable(startTree()), "de");
    try {
      // Someone else moved Language to the top level; this sidebar still shows it under Content rules.
      const rules = api.tree.find((node) => node.id === "Rules1")!;
      api.tree.push({ ...rules.children.shift()!, parentId: null });
      await page.locator('[data-k2b-nav-tree-id="Tone01"]').focus();
      await page.keyboard.press("Alt+ArrowUp");
      // The toast's screen-reader line ("Fehler: …") carries the same words 100 ms later, so look in the visible toast.
      await page
        .locator("[data-k2b-toast]")
        .getByText("Diese Ebene wurde inzwischen geändert. Sie zeigt jetzt die aktuelle Reihenfolge.", { exact: true })
        .waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-k2b-nav-tree-parent-id="Rules1"][data-k2b-nav-tree-id="Lang01"]'));
      expect(api.requests).toEqual([{ path: "notes/Tone01/move", body: { parentId: "Rules1", before: "Lang01" } }]);
      expect(await order(page, "Rules1")).toEqual(["Tone01"]);
      expect(await order(page)).toContain("Lang01");
      expect(api.tree.find((node) => node.id === "Rules1")!.children.map((node) => node.position)).toEqual([0]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the folder menu sorts a level arranged by hand back into title order", async () => {
    const tree = startTree();
    tree[1]!.children = [note("Tone01", "Tone", [], "Rules1", 1), note("Lang01", "Language", [], "Rules1", 2)];
    const page = await open(desktop, writable(tree), "de");
    try {
      expect(await order(page, "Rules1")).toEqual(["Tone01", "Lang01"]);
      await page.locator('[data-k2b-nav-tree-id="Rules1"] > :first-child').hover();
      await page.getByRole("button", { name: "Aktionen für Content rules" }).click();
      await page.getByRole("menuitem", { name: "Unternotizen alphabetisch sortieren" }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-k2b-nav-tree-parent-id="Rules1"]')?.getAttribute("data-k2b-nav-tree-id") === "Lang01",
      );
      expect(api.requests).toEqual([{ path: "note-order/reset", body: { parentId: "Rules1" } }]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("readers see the order but cannot change it", async () => {
    const page = await open(desktop, { ...writable(startTree()), permission: "read" });
    try {
      expect(await page.locator('[role="treeitem"][draggable="true"]').count()).toBe(0);
      await page.locator('[data-k2b-nav-tree-id="Exam01"]').focus();
      await page.keyboard.press("Alt+ArrowUp");
      await page.waitForTimeout(200);
      expect(api.requests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("on a phone the note menu moves a note up", async () => {
    const page = await open(phone, writable(startTree()));
    try {
      await page.evaluate(() => window.mountPhoneMenu("en", true));
      const menu = page.locator("#phone-menu");
      await menu
        .getByRole("button", { name: /Examples/ })
        .first()
        .click();
      await page.getByRole("menuitem", { name: "Move up" }).click();
      await page.waitForFunction(
        () => document.querySelector('[role="tree"] > [role="treeitem"]:nth-child(2)')?.getAttribute("data-k2b-nav-tree-id") === "Exam01",
      );
      expect(api.requests).toEqual([{ path: "notes/Exam01/move", body: { parentId: null, before: "Rules1" } }]);
      // A note's action closes the menu before it runs.
      expect(await page.evaluate(() => window.phoneMenuClosed)).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("Notebook sidebar names the open note", () => {
  test("from 64 rem the marked note replaces the title row; the head names the note only while the note has no heading", async () => {
    const page = await (await browser.newContext(desktop)).newPage();
    try {
      await page.goto(new URL("/app/notebooks/Book01/notes/Exam01", server.url).href);
      // The trail Cloud's layout publishes for a note: the notebook above it.
      await page.evaluate(() => {
        const script = document.createElement("script");
        script.type = "application/json";
        script.setAttribute("data-k2b-page-trail", "");
        script.textContent = JSON.stringify({ title: "Examples", ancestors: [{ title: "Social media", href: "/app/notebooks/Book01" }] });
        document.body.append(script);
      });
      await page.evaluate((value) => window.mountNotebookSidebar(value, "en"), { ...ctx(), selectedNoteId: "Exam01" });
      const current = page.locator('.k2b-app-workspace__sidebar [aria-current="page"]');
      expect(await current.getAttribute("href")).toBe("/app/notebooks/Book01/notes/Exam01");
      const head = await page.locator('.k2b-app-workspace__head[data-trail="up"]').boundingBox();
      expect(head!.width).toBeLessThanOrEqual(1);
      expect(head!.height).toBeLessThanOrEqual(1);
      expect(await page.locator(".k2b-page-title__up:visible, .k2b-page-title__title:visible").count()).toBe(0);
      expect(await page.locator("h1").allTextContents()).toEqual(["Examples"]);
      // The note's own first heading names it; the head adds no second one.
      await page.evaluate(() => {
        const heading = document.createElement("h1");
        heading.textContent = "Examples";
        document.querySelector(".notebook-document-surface")!.append(heading);
      });
      expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
      expect(await page.locator(".k2b-app-workspace__head-heading").evaluate((element) => getComputedStyle(element).display)).toBe("none");
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
