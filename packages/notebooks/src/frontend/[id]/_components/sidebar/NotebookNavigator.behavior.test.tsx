import { expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { Notebook, NoteTreeNode } from "./types";

if (!isServer) {
  const navigated: string[] = [];
  mock.module("@/api/client", () => ({ apiClient: {} }));
  mock.module("../../../lib/soft-navigation", () => ({
    navigateToNotebookNote: async (href: string) => {
      navigated.push(href);
    },
  }));

  const notebook: Notebook = {
    id: "Book01",
    name: "Journal",
    description: null,
    icon: null,
    homepageNoteId: "Home01",
    defaultPresentationMode: "write",
    noteDeletePermission: "write",
    defaultNoteTitleTemplate: "",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const note = (
    id: string,
    title: string,
    dates: { created: string; updated: string },
    children: NoteTreeNode[] = [],
    parentId: string | null = null,
  ) => ({
    id,
    notebookId: notebook.id,
    parentId,
    title,
    position: 0,
    hasChildren: children.length > 0,
    yjsSnapshotAt: null,
    contentMd: null,
    createdBy: null,
    createdAt: dates.created,
    updatedAt: dates.updated,
    lockedAt: null,
    children,
  });

  const tree: NoteTreeNode[] = [
    note("Alpha1", "Alpha", { created: "2026-03-01T00:00:00.000Z", updated: "2026-02-01T00:00:00.000Z" }),
    note("Home01", "Home", { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" }),
    note("Proj01", "Projects", { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" }, [
      note("Nest01", "Nested", { created: "2026-01-01T00:00:00.000Z", updated: "2026-05-01T00:00:00.000Z" }, [], "Proj01"),
    ]),
    note("Zeta01", "Zeta", { created: "2026-02-01T00:00:00.000Z", updated: "2026-04-01T00:00:00.000Z" }),
  ];

  const renderNavigator = async (
    initialSortMode: "updated" | "created" | "title",
    options: { tree?: NoteTreeNode[]; homepageNoteId?: string | null } = {},
  ) => {
    const dom = createDomTestHarness();
    const { default: NotebookNavigator } = await import("./NotebookNavigator");
    const dispose = render(
      () =>
        createComponent(NotebookNavigator, {
          notebook: {
            ...notebook,
            homepageNoteId: options.homepageNoteId === undefined ? notebook.homepageNoteId : options.homepageNoteId,
          },
          tree: options.tree ?? tree,
          selectedNoteId: null,
          permission: "read",
          canWrite: false,
          favoriteNoteIds: [],
          tags: [],
          initialSortMode,
          dateConfig: { locale: "en", timeZone: "UTC" },
          initialQuery: {},
        }),
      dom.root,
    );
    const noteItems = () =>
      Array.from(dom.root.querySelectorAll<HTMLElement>('[data-k2b-nav-tree-parent-id="notes"]')).map((item) => ({
        element: item,
        id: item.dataset.k2bNavTreeId,
        icon: item.querySelector(".k2b-app-workspace__sidebar-item-icon i")?.className ?? "",
        iconName: item.querySelector(".k2b-app-workspace__sidebar-item-icon")?.getAttribute("aria-label") ?? null,
      }));
    return {
      dom,
      noteItems,
      treeIds: () => Array.from(dom.root.querySelectorAll<HTMLElement>("[data-k2b-nav-tree-id]")).map((item) => item.dataset.k2bNavTreeId),
      dispose: () => {
        dispose();
        dom.cleanup();
      },
    };
  };

  test("lists the homepage first, then the folders and the other top-level notes, and keeps nested notes out of the tree", async () => {
    const view = await renderNavigator("title");
    try {
      expect(view.noteItems().map((item) => item.id)).toEqual(["note:Home01", "note:Proj01", "note:Alpha1", "note:Zeta01"]);
      expect(view.noteItems().map((item) => item.icon)).toEqual(["ti ti-home", "ti ti-folder", "ti ti-file-text", "ti ti-file-text"]);
      // Only the home icon carries meaning, so only it has a name; the treeitem reads "Homepage Home".
      expect(view.noteItems().map((item) => item.iconName)).toEqual(["Homepage", null, null, null]);
      expect(view.noteItems()[0]!.element.querySelector(".k2b-app-workspace__sidebar-item-icon")?.getAttribute("role")).toBe("img");
      expect(view.treeIds()).not.toContain("note:Nest01");
    } finally {
      view.dispose();
    }
  });

  test("shows every top-level note with the note icon when the notebook has no homepage", async () => {
    const view = await renderNavigator("title", { homepageNoteId: null });
    try {
      expect(view.noteItems().map((item) => item.id)).toEqual(["note:Proj01", "note:Alpha1", "note:Home01", "note:Zeta01"]);
      expect(view.noteItems().map((item) => item.icon)).not.toContain("ti ti-home");
    } finally {
      view.dispose();
    }
  });

  test("a homepage with sub-notes leads the folders of its own level with the home icon", async () => {
    const date = { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" };
    const nested = [
      note("Alpha1", "Alpha", date),
      note("Proj01", "Projects", date, [
        note("Bravo1", "Bravo", date, [note("Leaf01", "Leaf", date, [], "Bravo1")], "Proj01"),
        note("Home01", "Overview", date, [note("Leaf02", "Leaf", date, [], "Home01")], "Proj01"),
      ]),
    ];
    const view = await renderNavigator("title", { tree: nested });
    try {
      expect(view.treeIds()).toEqual(["notes", "note:Proj01", "note:Home01", "note:Bravo1", "note:Alpha1", "tags"]);
      const home = view.dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="note:Home01"] .k2b-app-workspace__sidebar-item-icon');
      expect(home?.querySelector("i")?.className).toBe("ti ti-home");
      expect(home?.getAttribute("aria-label")).toBe("Homepage");
    } finally {
      view.dispose();
    }
  });

  test("a childless homepage below another note leads that folder in the tree and opens like a note", async () => {
    const date = { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" };
    const nested = [
      note("Alpha1", "Alpha", date),
      note("Proj01", "Projects", date, [note("Aaa001", "Aaa", date, [], "Proj01"), note("Nest01", "Nested home", date, [], "Proj01")]),
    ];
    const view = await renderNavigator("title", { tree: nested, homepageNoteId: "Nest01" });
    navigated.length = 0;
    try {
      expect(view.treeIds()).toEqual(["notes", "note:Proj01", "note:Nest01", "note:Alpha1", "tags"]);
      const home = view.dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="note:Nest01"]');
      expect(home?.dataset.k2bNavTreeParentId).toBe("note:Proj01");
      expect(home?.querySelector(".k2b-app-workspace__sidebar-item-icon i")?.className).toBe("ti ti-home");
      // The other sub-note without children stays in the note list, as before.
      expect(view.treeIds()).not.toContain("note:Aaa001");
      home?.querySelector<HTMLElement>(".k2b-app-workspace__nav-tree-row")?.click();
      expect(navigated).toEqual(["/app/notebooks/Book01/notes/Nest01"]);
      expect(window.location.search).toBe("");
    } finally {
      view.dispose();
    }
  });

  test("follows renames and a new homepage while it stays mounted", async () => {
    const date = { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" };
    const flat = (homeTitle: string) => [
      note("Alpha1", "Alpha", date),
      note("Home01", homeTitle, date),
      note("Proj01", "Projects", date, [note("Nest01", "Nested", date, [], "Proj01")]),
      note("Zeta01", "Zeta", date),
    ];
    const [currentTree, setCurrentTree] = createSignal(flat("Home"));
    const [homepageNoteId, setHomepageNoteId] = createSignal<string | null>("Home01");
    const dom = createDomTestHarness();
    const { default: NotebookNavigator } = await import("./NotebookNavigator");
    const dispose = render(
      () =>
        createComponent(NotebookNavigator, {
          get notebook() {
            return { ...notebook, homepageNoteId: homepageNoteId() };
          },
          get tree() {
            return currentTree();
          },
          selectedNoteId: null,
          permission: "read",
          canWrite: false,
          favoriteNoteIds: [],
          tags: [],
          initialSortMode: "title",
          dateConfig: { locale: "en", timeZone: "UTC" },
          initialQuery: {},
        }),
      dom.root,
    );
    const rows = () =>
      Array.from(dom.root.querySelectorAll<HTMLElement>('[data-k2b-nav-tree-parent-id="notes"]')).map(
        (item) =>
          `${item.dataset.k2bNavTreeId}|${item.querySelector(".k2b-app-workspace__nav-tree-row")?.textContent?.trim()}|${item.querySelector(".k2b-app-workspace__sidebar-item-icon i")?.className}`,
      );
    navigated.length = 0;
    try {
      setCurrentTree(flat("Overview"));
      expect(rows()).toEqual([
        "note:Home01|Overview|ti ti-home",
        "note:Proj01|Projects|ti ti-folder",
        "note:Alpha1|Alpha|ti ti-file-text",
        "note:Zeta01|Zeta|ti ti-file-text",
      ]);
      setHomepageNoteId("Zeta01");
      expect(rows()).toEqual([
        "note:Zeta01|Zeta|ti ti-home",
        "note:Proj01|Projects|ti ti-folder",
        "note:Alpha1|Alpha|ti ti-file-text",
        "note:Home01|Overview|ti ti-file-text",
      ]);
      dom.root.querySelector<HTMLElement>('[data-k2b-nav-tree-id="note:Zeta01"] .k2b-app-workspace__nav-tree-row')?.click();
      expect(navigated).toEqual(["/app/notebooks/Book01/notes/Zeta01"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("names the home icon in the reader's language", async () => {
    const dom = createDomTestHarness();
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: NotebookNavigator } = await import("./NotebookNavigator");
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(NotebookNavigator, {
              notebook,
              tree,
              selectedNoteId: null,
              permission: "read",
              canWrite: false,
              favoriteNoteIds: [],
              tags: [],
              initialSortMode: "title",
              dateConfig: { locale: "de", timeZone: "UTC" },
              initialQuery: {},
            });
          },
        }),
      dom.root,
    );
    try {
      const home = dom.root.querySelector('[data-k2b-nav-tree-id="note:Home01"] .k2b-app-workspace__sidebar-item-icon');
      expect(home?.getAttribute("aria-label")).toBe("Startseite");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("orders top-level notes by the navigator sort mode, with the homepage always first", async () => {
    for (const [mode, expected] of [
      ["updated", ["note:Home01", "note:Proj01", "note:Zeta01", "note:Alpha1"]],
      ["created", ["note:Home01", "note:Proj01", "note:Alpha1", "note:Zeta01"]],
    ] as const) {
      const view = await renderNavigator(mode);
      try {
        expect(view.noteItems().map((item) => item.id)).toEqual([...expected]);
      } finally {
        view.dispose();
      }
    }
  });

  test("opens a top-level note directly without selecting a folder context", async () => {
    const view = await renderNavigator("title");
    navigated.length = 0;
    try {
      const alpha = view.noteItems().find((item) => item.id === "note:Alpha1");
      alpha?.element.querySelector<HTMLElement>(".k2b-app-workspace__nav-tree-row")?.click();
      expect(navigated).toEqual(["/app/notebooks/Book01/notes/Alpha1"]);
      expect(window.location.search).toBe("");
      expect(view.dom.root.querySelector('[data-k2b-nav-tree-id="notes"]')?.getAttribute("aria-selected")).toBe("true");
    } finally {
      view.dispose();
    }
  });

  test("opens the homepage from the tree like any other top-level note", async () => {
    const view = await renderNavigator("title");
    navigated.length = 0;
    try {
      const home = view.noteItems().find((item) => item.id === "note:Home01");
      home?.element.querySelector<HTMLElement>(".k2b-app-workspace__nav-tree-row")?.click();
      expect(navigated).toEqual(["/app/notebooks/Book01/notes/Home01"]);
      expect(window.location.search).toBe("");
      expect(view.dom.root.querySelector('[data-k2b-nav-tree-id="notes"]')?.getAttribute("aria-selected")).toBe("true");
    } finally {
      view.dispose();
    }
  });
}
