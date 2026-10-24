import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { answerTreeLevels, bookNavigationState } from "../sidebar/sidebar-tree.test-fixture";
import { dispatchWorkspaceEvent } from "../sidebar/workspace-events";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";

const metadata: BookMetadata = {
  href: "/app/notebooks/book01/notes/note02?mode=book",
  notebookName: "Updated handbook",
  title: "Second",
  selectedNoteId: "note02",
  hasNotes: true,
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
    const current = [{ id: "note01", title: "Parent", children: [{ id: "note02", title: "Second", children: [] }] }];
    const originalFetch = globalThis.fetch;
    // The navigation reads its levels from the server; the notebook now holds Parent and Second.
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) =>
        Response.json(
          answerTreeLevels(
            current,
            new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost"),
          ),
        ),
      { preconnect: originalFetch.preconnect },
    );
    const { default: Navigator } = await import("./BookNavigator.island");
    const dispose = render(
      () =>
        createComponent(Navigator, {
          notebookId: "book01",
          notebookName: "Handbook",
          notebookIcon: null,
          selectedNoteId: "note03",
          currentHref: "/app/notebooks/book01/notes/note03?mode=book",
          navigation: bookNavigationState([{ id: "note03", title: "Deleted", children: [] }], "note03"),
          tags: [{ tag: "obsolete", count: 1 }],
          navigationHidden: false,
        }),
      dom.root,
    );
    try {
      await dispatchWorkspaceEvent({ v: 1, type: "note.deleted", notebookId: "book01", noteId: "note03" }, "2-0");
      window.dispatchEvent(new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
      await Bun.sleep(20);
      expect(dom.root.textContent).not.toContain("Deleted");
      expect(dom.root.textContent).not.toContain("obsolete");
      expect(dom.root.textContent).toContain("Second");
      expect(dom.root.querySelector('a[href="/app/notebooks/book01/notes/note02?mode=book"]')).not.toBeNull();
      expect(dom.root.querySelector('a[href="/app/notebooks/book01/tags/team?mode=book"]')).not.toBeNull();
      current.length = 0;
      await dispatchWorkspaceEvent({ v: 1, type: "note.deleted", notebookId: "book01", noteId: "note01" }, "3-0");
      window.dispatchEvent(
        new CustomEvent(BOOK_SNAPSHOT_EVENT, { detail: { ...metadata, selectedNoteId: null, hasNotes: false, tags: [] } }),
      );
      await Bun.sleep(20);
      expect(dom.root.querySelector('a[href*="/notes/"]')).toBeNull();
      expect(dom.root.querySelector('a[href*="/tags/"]')).toBeNull();
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test.each(["write", "readonly"] as const)("workspace tree links retain explicit %s presentation", async (presentationMode) => {
    const dom = createDomTestHarness();
    const { default: NoteTree } = await import("../sidebar/NoteTree");
    const { createSidebarTree } = await import("../sidebar/sidebar-tree");
    const { sidebarTreeState } = await import("../sidebar/sidebar-tree.test-fixture");
    const dispose = render(
      () =>
        createComponent(NoteTree, {
          notebookId: "book01",
          selectedNoteId: "note01",
          presentationMode,
          tree: createSidebarTree({
            notebookId: () => "book01",
            sort: () => "title",
            initial: sidebarTreeState([{ id: "note02", title: "Second" }]),
          }),
          titleOf: (note) => note.title,
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
