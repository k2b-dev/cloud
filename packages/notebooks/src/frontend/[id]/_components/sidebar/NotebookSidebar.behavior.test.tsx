import { describe, expect, mock, test } from "bun:test";
import type { NavigationItem } from "@k2b/ui";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { SidebarLevel, SidebarList, SidebarListNote } from "../../../../lib/sidebar-tree";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import { type FixtureTreeNode, sidebarNote, sidebarTreeState } from "./sidebar-tree.test-fixture";
import type { NotebookContext } from "./types";

describe("notebook sidebar", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  // The server filters, sorts and pages; the fake answers what each request names.
  const requests: string[] = [];
  let lists: Record<string, SidebarListNote[]> = {};
  let levels: Record<string, SidebarLevel> = {};
  let listFails = false;
  /** Holds back answers to reveal requests until the test lets each one through. */
  let revealGate: ((noteId: string) => Promise<LevelsAnswer>) | null = null;
  type LevelsAnswer = { levels: SidebarLevel[]; expandedIds: string[] };
  const answerLevels = (query: { levels?: string; reveal?: string }) => ({
    levels: (query.levels ? query.levels.split(",") : []).map((entry) => {
      const [parent = "", offset = "0", limit = "100"] = entry.split(":");
      const level = levels[parent] ?? { parentId: parent || null, total: 0, offset: 0, items: [] };
      return { ...level, offset: Number(offset), items: level.items.slice(Number(offset), Number(offset) + Number(limit)) };
    }),
    expandedIds: [],
  });
  mock.module("@/api/client", () => ({
    apiClient: {
      ":id": {
        tree: {
          levels: {
            $get: async ({ query }: { query: { levels?: string; reveal?: string } }) => {
              requests.push(`levels ${query.levels ?? ""}${query.reveal ? ` reveal ${query.reveal}` : ""}`);
              if (query.reveal && revealGate) return Response.json(await revealGate(query.reveal));
              return Response.json(answerLevels(query));
            },
          },
          list: {
            $get: async ({ query }: { query: { view: string; tag?: string } }) => {
              requests.push(`list ${query.view}${query.tag ? ` ${query.tag}` : ""}`);
              if (listFails) return Response.json({ message: "Unavailable" }, { status: 503 });
              const items = lists[query.tag ?? query.view] ?? [];
              return Response.json({ total: items.length, offset: 0, items } satisfies SidebarList);
            },
          },
        },
      },
    },
  }));

  const note = (
    id: string,
    title: string,
    children: FixtureTreeNode[] = [],
    parentId: string | null = null,
    extra: Partial<FixtureTreeNode> = {},
  ): FixtureTreeNode => ({ id, title, parentId, children, ...extra });
  const listed = (node: FixtureTreeNode, tags: string[] = []): SidebarListNote => ({ ...sidebarNote(node), tags });
  const settle = async () => {
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const zeta = note("Zeta01", "Zeta", [], null, { updatedAt: "2026-03-01T00:00:00.000Z" });
  const nested = note("Nest01", "Nested", [], "Proj01", { updatedAt: "2026-05-01T00:00:00.000Z" });
  const projects = note("Proj01", "Projects", [nested, note("Home02", "Guide", [], "Proj01")]);
  const home = note("Home01", "Overview");
  const alpha = note("Alpha1", "Alpha", [], null, { updatedAt: "2026-02-01T00:00:00.000Z" });

  const ctx = (homepageNoteId: string | null, overrides: Partial<NotebookContext> = {}): NotebookContext => ({
    notebook: {
      id: "Book01",
      name: "Journal",
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
    // The levels arrive in the order on screen; the server leads a level with its homepage.
    sidebarTree: sidebarTreeState(
      homepageNoteId === "Home01" ? [home, alpha, projects, zeta] : [alpha, { id: "Home01", title: "Overview" }, projects, zeta],
    ),
    sidebarList: null,
    selectedNoteId: null,
    userId: "user01",
    settings: { lastNoteId: null, richMode: "rich", treeSort: "title" },
    navigationHidden: false,
    fullWidth: false,
    permission: "read",
    attachmentCount: 0,
    favoriteNoteIds: [],
    tags: [{ tag: "garden", count: 2 }],
    workspaceCursor: null,
    dateConfig: { locale: "en", timeZone: "UTC" },
    sidebarFilter: {},
    ...overrides,
  });

  const mount = async (value: NotebookContext, href = "/app/notebooks/Book01", current?: "attachments" | "graph") => {
    const dom = createDomTestHarness();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
    delegateEvents(["click"], dom.document);
    window.history.replaceState({}, "", href);
    const { default: NotebookSidebar } = await import("./NotebookSidebar.island");
    const dispose = render(() => createComponent(NotebookSidebar, { ctx: value, current }), dom.root);
    const rows = (parent: string | null) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>("[data-k2b-nav-tree-id]"))
        .filter((item) => (item.dataset.k2bNavTreeParentId ?? null) === parent)
        .map((item) => {
          const icon = item.querySelector(":scope > * .k2b-app-workspace__sidebar-item-icon");
          return {
            id: item.dataset.k2bNavTreeId,
            icon: icon?.querySelector("i")?.className,
            name: icon?.getAttribute("aria-label") ?? null,
          };
        });
    // The phone menu receives the same items through the workspace navigation script.
    const phoneItems = () => {
      const script = dom.root.querySelector<HTMLScriptElement>("script[data-cloud-workspace-navigation]");
      return (JSON.parse(script?.textContent ?? "{}") as { items: NavigationItem[] }).items;
    };
    const phoneNotes = () =>
      phoneItems()
        .flatMap((item) => (item.section ? (item.children ?? []) : [item]))
        .filter((item) => item.id.startsWith("note:"));
    const button = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
      );
    return {
      dom,
      rows,
      phoneItems,
      phoneNotes,
      button,
      cleanup: () => {
        dispose();
        if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
        else Reflect.deleteProperty(globalThis, "sessionStorage");
        dom.cleanup();
      },
    };
  };

  test.each([undefined, "attachments"] as const)(
    "desktop and phone destinations agree on the current attachments page (%s)",
    async (current) => {
      const view = await mount(ctx(null), "/app/notebooks/Book01/attachments", current);
      try {
        const active = view.dom.root.querySelectorAll('.notebook-sidebar-foot [aria-current="page"]');
        expect(Array.from(active, (row) => row.textContent?.trim())).toEqual(current ? ["Attachments"] : []);
        expect(view.phoneItems().find((item) => item.id === "attachments")?.active).toBe(current === "attachments");
        expect(view.phoneItems().find((item) => item.id === "settings")?.active).toBeUndefined();
      } finally {
        view.cleanup();
      }
    },
  );

  test("choosing Settings in the footer opens the notebook settings dialog", async () => {
    const view = await mount(ctx(null, { permission: "write" }));
    const { dialogCore } = await import("@k2b/ui");
    try {
      expect(view.dom.document.querySelector("dialog[open]")).toBeNull();
      view.dom.root.querySelector<HTMLButtonElement>(".notebook-sidebar-foot button")!.click();
      // The shared dialog mounts after the action, without an API preflight; wait for it rather than for a fixed time.
      let dialog: Element | null = null;
      for (let tick = 0; tick < 200 && !dialog; tick++) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        dialog = view.dom.document.querySelector("dialog[open]");
      }
      expect(dialog).not.toBeNull();
      expect(dialog?.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Notebook settings");
      expect(dialog?.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe("Journal");
    } finally {
      while (dialogCore.isOpen()) dialogCore.close();
      view.cleanup();
    }
  });

  test("the Links footer follows the note selected by a graph recentre", async () => {
    const view = await mount(ctx(null, { selectedNoteId: "Alpha1" }), "/app/notebooks/Book01?mode=graph&note=Alpha1", "graph");
    const linksHref = () => view.dom.root.querySelector<HTMLAnchorElement>('.notebook-sidebar-foot a[aria-current="page"]')?.href;
    try {
      expect(new URL(linksHref()!).searchParams.get("note")).toBe("Alpha1");
      window.dispatchEvent(
        new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, {
          detail: { noteId: "Zeta01", href: "/app/notebooks/Book01?mode=graph&note=Zeta01" },
        }),
      );
      expect(new URL(linksHref()!).searchParams.get("note")).toBe("Zeta01");
    } finally {
      view.cleanup();
    }
  });

  test("the note tree lists the homepage first in its level with a named home icon, and notes with sub-notes as stacks", async () => {
    const view = await mount(ctx("Home01"));
    try {
      expect(view.rows(null)).toEqual([
        { id: "Home01", icon: "ti ti-home", name: "Homepage" },
        { id: "Alpha1", icon: "ti ti-file-text", name: null },
        { id: "Proj01", icon: "ti ti-files", name: null },
        { id: "Zeta01", icon: "ti ti-file-text", name: null },
      ]);
    } finally {
      view.cleanup();
    }
  });

  test("Favorites turns the tree into a list newest first with date and tags, and the address keeps it", async () => {
    lists = { favorites: [listed(zeta, ["garden", "roses", "soil"]), listed(alpha)] };
    const view = await mount(ctx("Home01", { favoriteNoteIds: ["Alpha1", "Zeta01"] }), "/app/notebooks/Book01/notes/Alpha1?mode=write");
    try {
      const favorites = view.button("Favorites")!;
      expect(favorites.getAttribute("aria-pressed")).toBe("false");
      favorites.click();
      await settle();

      expect(favorites.getAttribute("aria-pressed")).toBe("true");
      expect(window.location.search).toBe("?mode=write&view=favorites");
      expect(view.rows(null).map((row) => row.id)).toEqual(["Zeta01", "Alpha1"]);
      const descriptions = Array.from(view.dom.root.querySelectorAll(".k2b-app-workspace__sidebar-item-description")).map(
        (line) => line.textContent,
      );
      expect(descriptions).toHaveLength(2);
      // At most two tags follow the date.
      expect(descriptions[0]).toMatch(/ · #garden #roses$/);
      expect(view.dom.root.querySelector(".notebook-sidebar-filter__label")?.textContent).toBe("Favorites 2 notes");
      // A listed note keeps the filter in its address, so the list stays when it opens.
      expect(view.dom.root.querySelector('[data-k2b-nav-tree-id="Zeta01"] a')?.getAttribute("href")).toBe(
        "/app/notebooks/Book01/notes/Zeta01?view=favorites",
      );

      favorites.click();
      expect(window.location.search).toBe("?mode=write");
      expect(view.rows(null).map((row) => row.id)).toEqual(["Home01", "Alpha1", "Proj01", "Zeta01"]);
    } finally {
      view.cleanup();
    }
  });

  test("a tag from the address lists its notes, and clearing the filter shows the tree again", async () => {
    const garden = [listed(nested, ["garden"]), listed(zeta, ["garden", "roses", "soil"])];
    const view = await mount(
      ctx("Home01", { sidebarFilter: { view: "tag", tag: "garden" }, sidebarList: { total: 2, offset: 0, items: garden } }),
      "/app/notebooks/Book01?view=tag&tag=garden",
    );
    try {
      expect(view.rows(null).map((row) => row.id)).toEqual(["Nest01", "Zeta01"]);
      expect(view.button("Tags: garden")?.getAttribute("aria-current")).toBe("true");
      expect(view.dom.root.querySelector(".notebook-sidebar-filter__label")?.textContent).toBe("#garden 2 notes");

      view.button("Clear filter")!.click();
      expect(window.location.search).toBe("");
      expect(view.rows(null).map((row) => row.id)).toEqual(["Home01", "Alpha1", "Proj01", "Zeta01"]);
      expect(view.button("Tags")?.hasAttribute("aria-current")).toBe(false);
    } finally {
      view.cleanup();
    }
  });

  test("an empty favorites list says how to add one", async () => {
    const view = await mount(
      ctx("Home01", { sidebarFilter: { view: "favorites" }, sidebarList: { total: 0, offset: 0, items: [] } }),
      "/app/notebooks/Book01?view=favorites",
    );
    try {
      expect(view.rows(null)).toEqual([]);
      expect(view.dom.root.textContent).toContain("No favorites yet. Add notes from their menu.");
    } finally {
      view.cleanup();
    }
  });

  test("the phone menu lists the homepage note first with a named home icon under Notes", async () => {
    const view = await mount(ctx("Home01"));
    try {
      const notes = view.phoneNotes();
      expect(notes.map((item) => item.id)).toEqual(["note:Home01", "note:Alpha1", "note:Proj01", "note:Zeta01"]);
      expect(notes[0]).toMatchObject({ icon: "ti ti-home", iconLabel: "Homepage" });
      expect(notes.slice(1).every((item) => item.iconLabel === undefined)).toBe(true);
      expect(view.phoneItems().map((item) => item.id)).toEqual([
        "search",
        "filter:favorites",
        "filter:recents",
        "filter:tags",
        "notes",
        "graph",
        "attachments",
        "settings",
      ]);
    } finally {
      view.cleanup();
    }
  });

  test("the phone menu shows a filter as a list with dates, tags and a way back to the tree", async () => {
    const recent = [nested, zeta, alpha, home, projects, note("Home02", "Guide", [], "Proj01")].map((node, index) =>
      listed(node, index === 0 ? ["garden"] : []),
    );
    const view = await mount(
      ctx("Home01", { sidebarFilter: { view: "recents" }, sidebarList: { total: 6, offset: 0, items: recent } }),
      "/app/notebooks/Book01?view=recents",
    );
    try {
      const section = view.phoneItems().find((item) => item.id === "filtered");
      expect(section?.label).toBe("Recently changed · 6 notes");
      expect(section?.children?.[0]).toMatchObject({ id: "filter:clear", label: "Clear filter", action: "filter:clear" });
      expect(view.phoneNotes()[0]).toMatchObject({
        id: "note:Nest01",
        href: "/app/notebooks/Book01/notes/Nest01?view=recents",
      });
      expect(view.phoneNotes()[0]?.description).toMatch(/ · #garden$/);
      expect(view.phoneItems().find((item) => item.id === "filter:recents")?.active).toBe(true);
    } finally {
      view.cleanup();
    }
  });

  test("readers can still keep favorites from the note menu", async () => {
    const view = await mount(ctx("Home01"));
    try {
      const actions = view.phoneNotes().find((item) => item.id === "note:Alpha1")?.actions ?? [];
      expect(actions.map((action) => action.label)).toEqual(["Add favorite"]);
    } finally {
      view.cleanup();
    }
  });

  test("the phone menu keeps the lock of a locked homepage next to its home icon", async () => {
    const locked = "2026-02-01T00:00:00.000Z";
    const view = await mount(
      ctx("Home01", { sidebarTree: sidebarTreeState([{ ...home, lockedAt: locked }, alpha, projects, { ...zeta, lockedAt: locked }]) }),
    );
    try {
      const notes = view.phoneNotes();
      expect(notes.find((item) => item.id === "note:Home01")).toMatchObject({
        icon: "ti ti-home",
        status: { icon: "ti ti-lock", label: "Locked" },
      });
      // Every other locked note keeps the lock as its icon.
      expect(notes.find((item) => item.id === "note:Zeta01")).toMatchObject({ icon: "ti ti-lock" });
      expect(notes.find((item) => item.id === "note:Zeta01")?.status).toBeUndefined();
    } finally {
      view.cleanup();
    }
  });

  test("the phone menu keeps an empty status slot on an unlocked homepage, so locking it moves nothing", async () => {
    const view = await mount(ctx("Home01"));
    try {
      const notes = view.phoneNotes();
      expect(notes[0]?.status).toBeNull();
      expect(notes.slice(1).every((item) => item.status === undefined)).toBe(true);
    } finally {
      view.cleanup();
    }
  });

  test("without a homepage every row keeps the note icon", async () => {
    const view = await mount(ctx(null));
    try {
      expect(view.rows(null).map((row) => row.id)).toEqual(["Alpha1", "Home01", "Proj01", "Zeta01"]);
      expect(view.rows(null).every((row) => row.icon !== "ti ti-home")).toBe(true);
    } finally {
      view.cleanup();
    }
  });

  test("a large notebook opens the way to the open note; a closed branch loads when it opens", async () => {
    requests.length = 0;
    const children = Array.from({ length: 3 }, (_, index) => note(`Kid00${index}`, `Kid ${index}`, [], "Proj01"));
    levels = { Proj01: { parentId: "Proj01", total: 3, offset: 0, items: children.map(sidebarNote) } };
    const value = ctx(null, { sidebarTree: { ...sidebarTreeState([alpha, { ...projects, children: [] }, zeta]), total: 5000 } });
    value.sidebarTree.levels[0]!.items[1]!.hasChildren = true;
    const view = await mount(value);
    try {
      const branch = view.dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="Proj01"]')!;
      expect(branch.getAttribute("aria-expanded")).toBe("false");
      expect(view.rows("Proj01")).toEqual([]);
      branch.querySelector<HTMLElement>("[data-k2b-nav-tree-toggle]")!.click();
      await settle();
      expect(requests).toEqual(["levels Proj01:0:100"]);
      expect(view.rows("Proj01").map((row) => row.id)).toEqual(["Kid000", "Kid001", "Kid002"]);
    } finally {
      view.cleanup();
    }
  });

  test("a long level shows a page of notes and loads the next page on request", async () => {
    requests.length = 0;
    const many = Array.from({ length: 250 }, (_, index) => note(`N${String(index).padStart(5, "0")}`, `Note ${index}`));
    levels = { "": { parentId: null, total: 250, offset: 0, items: many.map(sidebarNote) } };
    const value = ctx(null, {
      sidebarTree: {
        total: 250,
        levels: [{ parentId: null, total: 250, offset: 0, items: many.slice(0, 100).map(sidebarNote) }],
        expandedIds: [],
      },
    });
    const view = await mount(value);
    try {
      expect(view.rows(null)).toHaveLength(101);
      const more = view.dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="more:"]')!;
      expect(more.textContent).toContain("150 more notes");
      more.querySelector<HTMLElement>("a, button, [role]")?.click() ?? more.click();
      await settle();
      expect(requests).toEqual(["levels :100:100"]);
      expect(view.rows(null)).toHaveLength(201);
      // Focus moves to the first note that just loaded, so the keyboard continues there.
      expect(view.dom.document.activeElement?.getAttribute("data-k2b-nav-tree-id")).toBe("N00100");
      expect(view.dom.root.querySelector('[data-k2b-nav-tree-id="more:"]')?.textContent).toContain("50 more notes");
      expect(view.phoneNotes()).toHaveLength(200);
      expect(
        view
          .phoneItems()
          .find((item) => item.id === "notes")
          ?.children?.at(-1),
      ).toMatchObject({ id: "more:", action: "more:" });
    } finally {
      view.cleanup();
    }
  });

  test("a note opened from elsewhere opens its way in the tree", async () => {
    requests.length = 0;
    const view = await mount(
      ctx(null, { sidebarTree: { ...sidebarTreeState([alpha, projects, zeta], { expanded: false }), total: 5000 } }),
    );
    try {
      window.dispatchEvent(
        new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: { noteId: "Nest01", href: "/app/notebooks/Book01/notes/Nest01" } }),
      );
      await settle();
      expect(requests).toEqual(["levels  reveal Nest01"]);
    } finally {
      view.cleanup();
    }
  });
  test("a note opened later wins over an earlier one whose way down answers late", async () => {
    requests.length = 0;
    const releases = new Map<string, (answer: LevelsAnswer) => void>();
    revealGate = (noteId) => new Promise((resolve) => releases.set(noteId, resolve));
    const view = await mount(
      ctx(null, { sidebarTree: { ...sidebarTreeState([alpha, projects, zeta], { expanded: false }), total: 5000 } }),
    );
    try {
      const open = (noteId: string) =>
        window.dispatchEvent(
          new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: { noteId, href: `/app/notebooks/Book01/notes/${noteId}` } }),
        );
      open("Nest01");
      open("Home02");
      await settle();
      const way = (noteId: string) => ({
        levels: [
          { parentId: "Proj01", total: 2, offset: 0, items: [sidebarNote({ ...nested }), sidebarNote(note(noteId, noteId, [], "Proj01"))] },
        ],
        expandedIds: ["Proj01"],
      });
      releases.get("Home02")!(way("Home02"));
      await settle();
      // The earlier answer shows another window of the level; it must not replace the one that holds Home02.
      releases.get("Nest01")!({
        levels: [
          {
            parentId: "Proj01",
            total: 2,
            offset: 0,
            items: [sidebarNote({ ...nested }), sidebarNote(note("Late01", "Late", [], "Proj01"))],
          },
        ],
        expandedIds: ["Proj01"],
      });
      await settle();
      expect(view.rows("Proj01").map((row) => row.id)).toEqual(["Nest01", "Home02"]);
    } finally {
      revealGate = null;
      view.cleanup();
    }
  });

  test("a list that cannot load says so with Retry instead of loading forever", async () => {
    listFails = true;
    const view = await mount(ctx("Home01"), "/app/notebooks/Book01");
    try {
      view.button("Favorites")!.click();
      await settle();
      expect(view.dom.root.textContent).not.toContain("Loading notes");
      expect(view.dom.root.querySelector('[role="alert"]')?.textContent).toContain("Retry");
      listFails = false;
      lists = { favorites: [listed(alpha)] };
      view.button("Retry")!.click();
      await settle();
      expect(view.rows(null).map((row) => row.id)).toEqual(["Alpha1"]);
    } finally {
      listFails = false;
      view.cleanup();
    }
  });

  test("a deleted note leaves Recent at once", async () => {
    const recent = [listed(zeta), listed(alpha)];
    lists = { recents: recent };
    levels = {};
    const view = await mount(
      ctx("Home01", { sidebarFilter: { view: "recents" }, sidebarList: { total: 2, offset: 0, items: recent } }),
      "/app/notebooks/Book01?view=recents",
    );
    try {
      lists = { recents: [listed(alpha)] };
      await new Promise<void>((done) => {
        const covered: Promise<void>[] = [];
        window.dispatchEvent(
          new CustomEvent("notebooks.workspace.event", {
            detail: {
              cursor: null,
              event: { v: 1, type: "note.deleted", notebookId: "Book01", noteId: "Zeta01" },
              cover: (coverage: Promise<void>) => covered.push(coverage),
            },
          }),
        );
        void Promise.allSettled(covered).then(() => done());
      });
      await settle();
      expect(view.rows(null).map((row) => row.id)).toEqual(["Alpha1"]);
    } finally {
      view.cleanup();
    }
  });
  test("a live change reads the window around the open note again at its size, so no rows appear", async () => {
    const all = Array.from({ length: 5000 }, (_, index) => note(`N${String(index).padStart(5, "0")}`, `Note ${index}`));
    const whole = sidebarTreeState(all).levels[0]!;
    levels = { "": whole };
    // A page opened deep in the level shows the 20 rows around it.
    const around = { ...whole, offset: 4320, items: whole.items.slice(4320, 4340) };
    const view = await mount(ctx("N04321", { sidebarTree: { total: 5000, levels: [around], expandedIds: [] } }));
    requests.length = 0;
    try {
      await new Promise<void>((done) => {
        const covered: Promise<void>[] = [];
        window.dispatchEvent(
          new CustomEvent("notebooks.workspace.event", {
            detail: {
              cursor: null,
              event: { v: 1, type: "note.created", notebookId: "Book01", note: { id: "New001" } },
              cover: (coverage: Promise<void>) => covered.push(coverage),
            },
          }),
        );
        void Promise.allSettled(covered).then(() => done());
      });
      await settle();
      expect(requests).toContain("levels :4320:20");
      const notes = view.rows(null).filter((row) => row.id?.startsWith("N"));
      expect(notes.map((row) => row.id)).toEqual(whole.items.slice(4320, 4340).map((item) => item.id));
    } finally {
      view.cleanup();
    }
  });

  test("a refresh reads every open branch again, also beyond the levels one request reads", async () => {
    const branches = Array.from({ length: 60 }, (_, index) =>
      note(`B${String(index).padStart(5, "0")}`, `Branch ${index}`, [
        note(`C${String(index).padStart(5, "0")}`, `Child ${index}`, [], null),
      ]),
    );
    for (const branch of branches) branch.children![0]!.parentId = branch.id;
    const state = sidebarTreeState(branches);
    // The server answers every level as it is; only the first 50 are read again.
    levels = Object.fromEntries(state.levels.map((level) => [level.parentId ?? "", level]));
    const view = await mount(ctx(null, { sidebarTree: { ...state, total: 5000 } }));
    // Someone renames the child of the 60th open branch.
    const last = levels.B00059!;
    levels.B00059 = { ...last, items: [{ ...last.items[0]!, title: "Renamed child" }] };
    try {
      await new Promise<void>((done) => {
        const covered: Promise<void>[] = [];
        window.dispatchEvent(
          new CustomEvent("notebooks.workspace.event", {
            detail: {
              cursor: null,
              event: { v: 1, type: "note.created", notebookId: "Book01", note: { id: "New001" } },
              cover: (coverage: Promise<void>) => covered.push(coverage),
            },
          }),
        );
        void Promise.allSettled(covered).then(() => done());
      });
      await settle();
      expect(view.dom.root.textContent).not.toContain("Loading notes");
      expect(view.rows("B00059").map((row) => row.id)).toEqual(["C00059"]);
      expect(view.dom.root.querySelector('[data-k2b-nav-tree-id="C00059"]')?.textContent).toContain("Renamed child");
    } finally {
      view.cleanup();
    }
  });
});
