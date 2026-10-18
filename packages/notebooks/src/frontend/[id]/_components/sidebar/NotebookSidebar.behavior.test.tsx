import { describe, expect, mock, test } from "bun:test";
import type { NavigationItem } from "@k2b/ui";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import type { NotebookContext, NoteTreeNode } from "./types";

describe("notebook sidebar", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  mock.module("@/api/client", () => ({ apiClient: {} }));

  const note = (
    id: string,
    title: string,
    children: NoteTreeNode[] = [],
    parentId: string | null = null,
    extra: Partial<NoteTreeNode> = {},
  ): NoteTreeNode => ({
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
    ...extra,
  });

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
    // In title order the homepage would sit between Alpha and Projects.
    tree: [
      note("Zeta01", "Zeta", [], null, { updatedAt: "2026-03-01T00:00:00.000Z", contentMd: "Plans #garden #roses #soil" }),
      note("Proj01", "Projects", [
        note("Nest01", "Nested", [], "Proj01", { updatedAt: "2026-05-01T00:00:00.000Z", contentMd: "#garden" }),
        note("Home02", "Guide", [], "Proj01"),
      ]),
      note("Home01", "Overview"),
      note("Alpha1", "Alpha", [], null, { updatedAt: "2026-02-01T00:00:00.000Z" }),
    ],
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

  test("a homepage below another note leads that note's sub-notes", async () => {
    const view = await mount(ctx("Home02"));
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

  test("Favorites turns the tree into a list newest first with date and tags, and the address keeps it", async () => {
    const view = await mount(ctx("Home01", { favoriteNoteIds: ["Alpha1", "Zeta01"] }), "/app/notebooks/Book01/notes/Alpha1?mode=write");
    try {
      const favorites = view.button("Favorites")!;
      expect(favorites.getAttribute("aria-pressed")).toBe("false");
      favorites.click();

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
    const view = await mount(ctx("Home01", { sidebarFilter: { view: "tag", tag: "garden" } }), "/app/notebooks/Book01?view=tag&tag=garden");
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
    const view = await mount(ctx("Home01", { sidebarFilter: { view: "favorites" } }), "/app/notebooks/Book01?view=favorites");
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
    const view = await mount(ctx("Home01", { sidebarFilter: { view: "recents" } }), "/app/notebooks/Book01?view=recents");
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
    const base = ctx("Home01");
    const tree = base.tree.map((node) =>
      node.id === "Home01" || node.id === "Zeta01" ? { ...node, lockedAt: "2026-02-01T00:00:00.000Z" } : node,
    );
    const view = await mount({ ...base, tree });
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

  test("without a homepage the tree keeps its sort order and the note icon", async () => {
    const view = await mount(ctx(null));
    try {
      expect(view.rows(null).map((row) => row.id)).toEqual(["Alpha1", "Home01", "Proj01", "Zeta01"]);
      expect(view.rows(null).every((row) => row.icon !== "ti ti-home")).toBe(true);
    } finally {
      view.cleanup();
    }
  });
});
