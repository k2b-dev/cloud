import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { compareNoteOrder } from "../../../../lib/note-order";
import type { NotebookContext, NoteTreeNode } from "./types";

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
  notebookId: "Book01",
  parentId,
  title,
  position,
  hasChildren: children.length > 0,
  yjsSnapshotAt: null,
  contentMd: `Notes about ${title}.`,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lockedAt: null,
  children,
});

/** The maintainer's example: the homepage "Overview" sits among top-level notes and one note with sub-notes. */
const ctx = (sidebarMode: "simple" | "navigator", homepageNoteId: string | null = "Home01"): NotebookContext => ({
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
  tree: [
    note("Reels1", "Reels"),
    note("Rules1", "Content rules", [note("Lang01", "Language", [], "Rules1")]),
    note("Home01", "Overview"),
    note("Exam01", "Examples"),
  ],
  selectedNoteId: null,
  userId: "user01",
  settings: { lastNoteId: null, richMode: "rich", sidebarMode, navigatorSort: "title", treeSort: "title" },
  navigationHidden: false,
  permission: "read",
  attachmentCount: 0,
  favoriteNoteIds: [],
  tags: [],
  workspaceCursor: null,
  dateConfig: { locale: "en", timeZone: "UTC" },
  navigatorQuery: {},
});

/**
 * The notebook API the sidebar talks to, with the server's order rules: placing a note renumbers its level 1..n
 * in the order on screen, sorting alphabetically sets the level back to 0, and the workspace state returns the result.
 */
const api = {
  notebook: ctx("simple").notebook,
  tree: [] as NoteTreeNode[],
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
  if (path === "workspace-state")
    return Response.json({ notebook: api.notebook, tree: api.tree, favoriteNoteIds: [], tags: [], attachmentCount: 0 });
  const body = (await request.json()) as { before?: string; after?: string; parentId?: string | null };
  api.requests.push({ path, body });
  const moved = /^notes\/(\w+)\/move$/u.exec(path)?.[1];
  const level = moved ? levelOf(api.tree, parentOf(api.tree, moved)) : levelOf(api.tree, body.parentId ?? null);
  if (!level) return new Response("Not found", { status: 404 });
  if (moved) {
    const order = level.filter((node) => node.id !== moved).sort(compareNoteOrder("en", (node: NoteTreeNode) => node.id));
    const anchor = order.findIndex((node) => node.id === (body.before ?? body.after));
    order.splice(body.before ? anchor : anchor + 1, 0, level.find((node) => node.id === moved)!);
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

/** Box and colour of the leading icon of each row under the given tree parent, in tree order. */
const rowIcons = (page: Page, parent: string) =>
  page.evaluate((parent) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-k2b-nav-tree-parent-id="${parent}"]`));
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
  }, parent);

describe("Notebook sidebar homepage in the tree", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`the navigator tree lists the homepage first with a home icon that sits like every other icon (${theme})`, async () => {
      const page = await open(desktop, ctx("navigator"), "en", theme);
      try {
        const rows = await rowIcons(page, "notes");
        expect(rows.map((row) => [row.id, row.glyph])).toEqual([
          ["note:Home01", "ti ti-home"],
          ["note:Rules1", "ti ti-folder"],
          ["note:Exam01", "ti ti-file-text"],
          ["note:Reels1", "ti ti-file-text"],
        ]);
        const [home, ...others] = rows;
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
        await expect(page.getByRole("treeitem", { name: "Homepage Overview", exact: true }).count()).resolves.toBe(1);
        // The note list leads with the same note and the same icon.
        const firstCard = page.locator('[data-workspace-main-region="notebook-notes"] a').first();
        await expect(firstCard.textContent()).resolves.toContain("Overview");
        await expect(firstCard.locator("i.ti-home").getAttribute("aria-label")).resolves.toBe("Homepage");
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("the keyboard reaches and opens the homepage from the tree, and every homepage control agrees it is open", async () => {
    const page = await open(desktop, ctx("navigator"));
    try {
      const home = page.getByRole("treeitem", { name: "Homepage Overview", exact: true });
      const homeAction = page.locator('.k2b-app-workspace__sidebar-icon-action[aria-label="Homepage"]');
      await expect(homeAction.evaluate((element) => element.classList.contains("is-active"))).resolves.toBe(false);
      await page.getByRole("treeitem", { name: "All notes" }).focus();
      await page.keyboard.press("ArrowDown");
      await expect(home.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.evaluate(() => window.openedNotes)).resolves.toEqual(["/app/notebooks/Book01/notes/Home01"]);
      await expect(homeAction.evaluate((element) => element.classList.contains("is-active"))).resolves.toBe(true);
      // Like any top-level note, the open homepage keeps "All notes" as the list's place in the tree.
      await expect(page.getByRole("treeitem", { name: "All notes" }).getAttribute("aria-selected")).resolves.toBe("true");

      await page.getByRole("treeitem", { name: "Examples", exact: true }).click();
      await expect(homeAction.evaluate((element) => element.classList.contains("is-active"))).resolves.toBe(false);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the simple tree names the home icon in German and keeps the homepage first", async () => {
    const page = await open(desktop, ctx("simple"), "de");
    try {
      const roots = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="tree"] > [role="treeitem"]')).map(
          (row) => row.querySelector(".k2b-app-workspace__sidebar-item-icon i")!.className,
        ),
      );
      expect(roots).toEqual(["ti ti-home", "ti ti-file-text", "ti ti-file-text", "ti ti-file-text"]);
      await expect(page.getByRole("treeitem", { name: "Startseite Overview", exact: true }).count()).resolves.toBe(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("on a phone the menu lists the homepage first with a named home icon in a row like the others", async () => {
    const page = await open(phone, ctx("simple"));
    try {
      await page.evaluate(() => window.mountPhoneMenu("en"));
      const link = page.locator("#phone-menu").getByRole("link", { name: "Homepage Overview", exact: true });
      await expect(link.count()).resolves.toBe(1);
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('#phone-menu a.k2b-navigation__control[href*="/notes/"]')).map((row) => ({
          text: row.textContent,
          height: row.getBoundingClientRect().height,
          width: row.getBoundingClientRect().width,
          icon: row.querySelector("i")!.getBoundingClientRect().width,
        })),
      );
      // The menu's own Homepage destination stays on top, as the home button does beside the desktop tree.
      expect(rows.map((row) => row.text)).toEqual(["Homepage", "Overview", "Content rules", "Language", "Examples", "Reels"]);
      expect(new Set(rows.map((row) => `${row.height}:${row.icon}`)).size).toBe(1);
      // The note rows share one width, so the homepage row ends where the others do.
      const [overview, , , examples] = rows.slice(1);
      expect(overview!.width).toBe(examples!.width);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});

describe("Notebook sidebar order by hand", () => {
  // Top level: the homepage leads, the rest reads by title until someone arranges it.
  const writable = (tree: NoteTreeNode[]): NotebookContext => {
    api.tree = structuredClone(tree);
    api.requests = [];
    return { ...ctx("simple"), tree, permission: "write" };
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
      await expect(page.locator('[data-k2b-nav-tree-drop="before"]').getAttribute("data-k2b-nav-tree-id")).resolves.toBe("Rules1");
      expect(await rowBoxes(page)).toEqual(before);
      await page.mouse.up();
      await page.waitForFunction(
        () => document.querySelector('[role="tree"] > [role="treeitem"]:nth-child(2)')?.getAttribute("data-k2b-nav-tree-id") === "Reels1",
      );
      expect(api.requests).toEqual([{ path: "notes/Reels1/move", body: { before: "Rules1" } }]);
      expect(await order(page)).toEqual(["Home01", "Reels1", "Rules1", "Exam01"]);
      await expect(page.locator("[data-k2b-nav-tree-drop]").count()).resolves.toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("nothing moves above the homepage or into another level", async () => {
    const page = await open(desktop, writable(startTree()));
    try {
      await expect(page.locator('[data-k2b-nav-tree-id="Home01"]').getAttribute("draggable")).resolves.toBeNull();
      const source = await row(page, "Exam01").boundingBox();
      const home = await row(page, "Home01").boundingBox();
      const child = await row(page, "Lang01").boundingBox();
      await page.mouse.move(source!.x + 40, source!.y + source!.height / 2);
      await page.mouse.down();
      await page.mouse.move(home!.x + 40, home!.y + 4, { steps: 8 });
      await expect(page.locator("[data-k2b-nav-tree-drop]").count()).resolves.toBe(0);
      await page.mouse.move(child!.x + 40, child!.y + 4, { steps: 8 });
      await expect(page.locator("[data-k2b-nav-tree-drop]").count()).resolves.toBe(0);
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
      expect(api.requests).toEqual([{ path: "notes/Tone01/move", body: { before: "Lang01" } }]);
      expect(await order(page, "Rules1")).toEqual(["Tone01", "Lang01"]);
      await expect(page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.k2bNavTreeId)).resolves.toBe("Tone01");
      await expect(page.locator('[data-k2b-nav-tree-id="Tone01"]').getAttribute("aria-posinset")).resolves.toBe("1");

      // The first note has no place further up, and plain arrows still only move the focus.
      await page.keyboard.press("Alt+ArrowUp");
      await page.keyboard.press("ArrowDown");
      expect(api.requests.length).toBe(1);
      await expect(page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.k2bNavTreeId)).resolves.toBe("Lang01");
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
      await expect(page.locator('[role="treeitem"][draggable="true"]').count()).resolves.toBe(0);
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
      expect(api.requests).toEqual([{ path: "notes/Exam01/move", body: { before: "Rules1" } }]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
