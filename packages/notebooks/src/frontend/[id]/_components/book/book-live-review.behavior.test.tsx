import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";

const metadata: BookMetadata = {
  href: "/app/notebooks/book01/notes/note02?mode=book",
  notebookName: "Updated handbook",
  title: "Second",
  selectedNoteId: "note02",
  tree: [{ id: "note01", title: "Parent", children: [{ id: "note02", title: "Second", children: [] }] }],
  tags: [{ tag: "team", count: 2 }],
  canWrite: true,
  locked: false,
  historyIncomplete: false,
  cursor: null,
};

describe("independent Book live metadata regression", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("mode actions follow current note, lock and permission without remounting", async () => {
    const dom = createDomTestHarness();
    const { default: ModeLinks } = await import("./FloatingEditButton.island");
    const dispose = render(
      () =>
        createComponent(ModeLinks, {
          href: "/app/notebooks/book01/notes/note01?mode=book",
          mode: "book",
          locked: false,
          canWrite: true,
        }),
      dom.root,
    );
    try {
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: { ...metadata, locked: true } }));
      expect(dom.root.querySelector('a[href*="mode=write"]')).toBeNull();
      expect(dom.root.querySelectorAll("a")).toHaveLength(0);
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
      expect(dom.root.querySelector('a[href*="mode=write"]')).not.toBeNull();
      expect(dom.root.querySelector("a")?.getAttribute("href")).toBe("/app/notebooks/book01/notes/note02?mode=write");
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: { ...metadata, selectedNoteId: null } }));
      expect(dom.root.querySelectorAll("a")).toHaveLength(0);
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: { ...metadata, canWrite: false } }));
      expect(dom.root.querySelectorAll("a")).toHaveLength(0);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("navigation replaces deleted entries, updates tags and expands the selected ancestry", async () => {
    const dom = createDomTestHarness();
    const { default: Navigator } = await import("./BookNavigator.island");
    const dispose = render(
      () =>
        createComponent(Navigator, {
          notebookId: "book01",
          notebookName: "Handbook",
          notebookIcon: null,
          selectedNoteId: "note03",
          currentHref: "/app/notebooks/book01/notes/note03?mode=book",
          tree: [{ id: "note03", title: "Deleted", children: [] }],
          tags: [{ tag: "obsolete", count: 1 }],
          navigationHidden: false,
        }),
      dom.root,
    );
    try {
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
      expect(dom.root.textContent).not.toContain("Deleted");
      expect(dom.root.textContent).not.toContain("obsolete");
      expect(dom.root.textContent).toContain("Second");
      expect(dom.root.querySelector('a[href="/app/notebooks/book01/notes/note02?mode=book"]')).not.toBeNull();
      expect(dom.root.querySelector('a[href="/app/notebooks/book01/tags/team?mode=book"]')).not.toBeNull();
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: { ...metadata, selectedNoteId: null, tree: [], tags: [] } }));
      expect(dom.root.querySelector('a[href*="/notes/"]')).toBeNull();
      expect(dom.root.querySelector('a[href*="/tags/"]')).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test.each(["write", "readonly"] as const)("workspace tree links retain explicit %s presentation", async (presentationMode) => {
    const dom = createDomTestHarness();
    const { default: NoteTree } = await import("../sidebar/NoteTree");
    const dispose = render(
      () =>
        createComponent(NoteTree, {
          notebookId: "book01",
          selectedNoteId: "note01",
          presentationMode,
          tree: [
            {
              id: "note02",
              notebookId: "book01",
              title: "Second",
              parentId: null,
              position: 0,
              hasChildren: false,
              historyIncomplete: false,
              yjsSnapshotAt: null,
              contentMd: null,
              createdBy: null,
              createdAt: "2026-09-04",
              updatedAt: "2026-09-04",
              lockedAt: null,
              children: [],
            },
          ],
        }),
      dom.root,
    );
    try {
      expect(dom.root.querySelector('a[href*="/notes/note02"]')?.getAttribute("href")).toBe(
        `/app/notebooks/book01/notes/note02?mode=${presentationMode}`,
      );
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
