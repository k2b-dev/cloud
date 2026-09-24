import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
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

  const renderNavigator = async (initialSortMode: "updated" | "created" | "title") => {
    const dom = createDomTestHarness();
    const { default: NotebookNavigator } = await import("./NotebookNavigator");
    const dispose = render(
      () =>
        createComponent(NotebookNavigator, {
          notebook,
          tree,
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

  test("lists top-level notes without sub-notes after the folders, and keeps nested notes out of the tree", async () => {
    const view = await renderNavigator("title");
    try {
      expect(view.noteItems().map((item) => item.id)).toEqual(["note:Proj01", "note:Alpha1", "note:Zeta01"]);
      expect(view.noteItems().map((item) => item.icon)).toEqual(["ti ti-folder", "ti ti-file-text", "ti ti-file-text"]);
      expect(view.treeIds()).not.toContain("note:Nest01");
      expect(view.treeIds()).not.toContain("note:Home01");
    } finally {
      view.dispose();
    }
  });

  test("orders top-level notes by the navigator sort mode", async () => {
    for (const [mode, expected] of [
      ["updated", ["note:Proj01", "note:Zeta01", "note:Alpha1"]],
      ["created", ["note:Proj01", "note:Alpha1", "note:Zeta01"]],
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
}
