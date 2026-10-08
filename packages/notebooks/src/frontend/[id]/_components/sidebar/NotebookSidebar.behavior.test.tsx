import { describe, expect, mock, test } from "bun:test";
import type { NavigationItem } from "@k2b/ui";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { NotebookContext, NoteTreeNode } from "./types";

describe("notebook sidebar homepage", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  mock.module("@/api/client", () => ({ apiClient: {} }));

  const note = (id: string, title: string, children: NoteTreeNode[] = [], parentId: string | null = null): NoteTreeNode => ({
    id,
    notebookId: "Book01",
    parentId,
    title,
    position: 0,
    hasChildren: children.length > 0,
    yjsSnapshotAt: null,
    contentMd: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lockedAt: null,
    children,
  });

  const ctx = (homepageNoteId: string | null): NotebookContext => ({
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
    // In title order the homepage would sit between Alpha and Projects.
    tree: [
      note("Zeta01", "Zeta"),
      note("Proj01", "Projects", [note("Nest01", "Nested", [], "Proj01"), note("Home02", "Guide", [], "Proj01")]),
      note("Home01", "Overview"),
      note("Alpha1", "Alpha"),
    ],
    selectedNoteId: null,
    userId: "user01",
    settings: { lastNoteId: null, richMode: "rich", sidebarMode: "simple", navigatorSort: "updated", treeSort: "title" },
    navigationHidden: false,
    permission: "read",
    attachmentCount: 0,
    favoriteNoteIds: [],
    tags: [],
    workspaceCursor: null,
    dateConfig: { locale: "en", timeZone: "UTC" },
    navigatorQuery: {},
  });

  const mount = async (homepageNoteId: string | null) => {
    const dom = createDomTestHarness();
    const { default: NotebookSidebar } = await import("./NotebookSidebar.island");
    const dispose = render(() => createComponent(NotebookSidebar, { ctx: ctx(homepageNoteId) }), dom.root);
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
    const phoneNotes = () => {
      const script = dom.root.querySelector<HTMLScriptElement>("script[data-cloud-workspace-navigation]");
      const items = (JSON.parse(script?.textContent ?? "{}") as { items: NavigationItem[] }).items;
      return items.filter((item) => item.id.startsWith("note:"));
    };
    return {
      rows,
      phoneNotes,
      cleanup: () => {
        dispose();
        dom.cleanup();
      },
    };
  };

  test("the note tree lists the homepage first in its level with a named home icon", async () => {
    const view = await mount("Home01");
    try {
      expect(view.rows(null)).toEqual([
        { id: "Home01", icon: "ti ti-home", name: "Homepage" },
        { id: "Alpha1", icon: "ti ti-file-text", name: null },
        { id: "Proj01", icon: "ti ti-file-text", name: null },
        { id: "Zeta01", icon: "ti ti-file-text", name: null },
      ]);
    } finally {
      view.cleanup();
    }
  });

  test("a homepage below another note leads that note's sub-notes", async () => {
    const view = await mount("Home02");
    try {
      expect(view.rows(null).map((row) => row.id)).toEqual(["Alpha1", "Home01", "Proj01", "Zeta01"]);
      expect(view.rows("Proj01")).toEqual([
        { id: "Home02", icon: "ti ti-home", name: "Homepage" },
        { id: "Nest01", icon: "ti ti-file-text", name: null },
      ]);
    } finally {
      view.cleanup();
    }
  });

  test("the phone menu lists the homepage note first with a named home icon", async () => {
    const view = await mount("Home01");
    try {
      const notes = view.phoneNotes();
      expect(notes.map((item) => item.id)).toEqual(["note:Home01", "note:Alpha1", "note:Proj01", "note:Zeta01"]);
      expect(notes[0]).toMatchObject({ icon: "ti ti-home", iconLabel: "Homepage" });
      expect(notes.slice(1).every((item) => item.icon === "ti ti-file-text" && item.iconLabel === undefined)).toBe(true);
    } finally {
      view.cleanup();
    }
  });

  test("without a homepage the tree keeps its sort order and the note icon", async () => {
    const view = await mount(null);
    try {
      expect(view.rows(null).map((row) => row.id)).toEqual(["Alpha1", "Home01", "Proj01", "Zeta01"]);
      expect(view.rows(null).every((row) => row.icon === "ti ti-file-text")).toBe(true);
    } finally {
      view.cleanup();
    }
  });
});
