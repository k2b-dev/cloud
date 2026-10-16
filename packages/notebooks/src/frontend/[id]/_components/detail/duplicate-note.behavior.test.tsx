import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { DUPLICATE_NOTE_EVENT } from "./events";

const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
};

describe("duplicate a note", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async (trees = 0, canWrite = true) => {
    const dom = createDomTestHarness();
    const { prompts, toast, LocaleProvider } = await import("@k2b/ui");
    const navigation = await import("../../../lib/soft-navigation");
    const { useNoteActions } = await import("../sidebar/NoteTree");
    const { default: Panel } = await import("./NotebookDetailPanel.island");
    const { useDuplicateNote } = await import("./duplicate-note");
    const form = spyOn(prompts, "form").mockResolvedValue({ targetNotebookId: "target" });
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const toastError = spyOn(toast, "error").mockImplementation(() => ({ dismiss() {}, update() {} }));
    const navigate = spyOn(navigation, "navigateToNotebookNote").mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    const copies: { path: string; body: unknown }[] = [];
    let failList = false;
    let failCopy = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("/copy")) {
          copies.push({ path, body: JSON.parse(String(init?.body)) });
          return failCopy ? Response.json({}, { status: 403 }) : Response.json({ id: "copied", notebookId: "target" });
        }
        if (path.includes("/overview/activity")) return Response.json({ data: [], nextCursor: null });
        if (failList) return Response.json({ message: "Cannot load notebooks" }, { status: 503 });
        return Response.json({
          data: [
            { id: "book01", name: "Source", icon: null },
            { id: "target", name: "Target", icon: "ti-book" },
          ],
          pagination: { has_next: false },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const treeActions: ReturnType<typeof useNoteActions>[] = [];
    let standalone!: ReturnType<typeof useDuplicateNote>;
    function Harness() {
      for (let index = 0; index < trees; index++) treeActions.push(useNoteActions("book01", () => []));
      standalone = useDuplicateNote("book01");
      return createComponent(Panel, {
        mode: "edit",
        fullWidth: false,
        initiallyOpen: true,
        tocItems: [],
        taskProgress: { done: 0, total: 0 },
        attachments: [],
        backlinks: [],
        namedBlocks: [],
        currentNotebookId: "book01",
        notebookId: "book01",
        noteId: "note01",
        noteTitle: "Plan",
        contentMd: "# Plan",
        createdAt: "2026-10-13T19:30:00.000Z",
        updatedAt: "2026-10-16T19:18:00.000Z",
        lockedAt: null,
        historyIncomplete: false,
        isLocked: false,
        canWrite,
        currentUserId: "me",
        initialCommentsPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
        dateConfig: { locale: "de", timeZone: "UTC", ...{ base: "2026-10-16T19:30:00.000Z" } },
      });
    }
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(Harness, {});
          },
        }),
      dom.root,
    );
    return {
      dom,
      copies,
      form,
      error,
      toastError,
      navigate,
      treeActions,
      standalone,
      dispose,
      failList: () => {
        failList = true;
      },
      failCopy: () => {
        failCopy = true;
      },
      dispatch: (noteId = "note01") => window.dispatchEvent(new CustomEvent(DUPLICATE_NOTE_EVENT, { detail: { noteId } })),
      cleanup() {
        dispose();
        globalThis.fetch = originalFetch;
        form.mockRestore();
        error.mockRestore();
        toastError.mockRestore();
        navigate.mockRestore();
        dom.cleanup();
      },
    };
  };
  for (const trees of [0, 2]) {
    test(`the panel copies once with ${trees} mounted trees and navigates to the result`, async () => {
      const view = await setup(trees);
      try {
        view.dispatch();
        await until(() => view.navigate.mock.calls.length === 1);
        expect(view.form).toHaveBeenCalledTimes(1);
        expect(view.form.mock.calls[0]?.[0]).toMatchObject({
          title: "Notiz duplizieren",
          fields: {
            targetNotebookId: {
              default: "book01",
              options: [
                { id: "book01", label: "Source", icon: "ti ti-notebook" },
                { id: "target", label: "Target", icon: "ti ti-book" },
              ],
            },
          },
        });
        expect(view.copies).toEqual([
          { path: expect.stringContaining("/api/notebooks/book01/notes/note01/copy"), body: { targetNotebookId: "target" } },
        ]);
        expect(view.navigate).toHaveBeenCalledWith("/app/notebooks/target/notes/copied");
      } finally {
        view.cleanup();
      }
    });
  }
  test("the tree uses the same prompt and copy flow", async () => {
    const view = await setup(1);
    try {
      await view.treeActions[0]!.handleCopy({
        id: "tree01",
        title: "Tree note",
        parentId: null,
        children: [],
        lockedAt: null,
        position: 0,
        notebookId: "book01",
        hasChildren: false,
        yjsSnapshotAt: null,
        contentMd: null,
        createdBy: "me",
        createdAt: "2026-10-13T19:30:00.000Z",
        updatedAt: "2026-10-16T19:18:00.000Z",
      });
      await until(() => view.navigate.mock.calls.length === 1);
      expect(view.form).toHaveBeenCalledTimes(1);
      expect(view.copies[0]?.path).toContain("/notes/tree01/copy");
    } finally {
      view.cleanup();
    }
  });
  test("cancel and notebook-loading failures do not copy", async () => {
    const view = await setup();
    try {
      view.form.mockResolvedValueOnce(null);
      await view.standalone.duplicate("note01");
      expect(view.copies).toHaveLength(0);
      view.failList();
      await view.standalone.duplicate("note01");
      expect(view.error).toHaveBeenCalledWith("Cannot load notebooks");
      expect(view.form).toHaveBeenCalledTimes(1);
      expect(view.copies).toHaveLength(0);
      expect(view.navigate).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });
  test("a failed copy reports the error without navigating", async () => {
    const view = await setup();
    try {
      view.failCopy();
      view.dispatch();
      await until(() => view.toastError.mock.calls.length === 1);
      expect(view.toastError).toHaveBeenCalledWith("Die Notiz konnte nicht dupliziert werden");
      expect(view.navigate).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });
  test("unrelated events and a disposed panel do nothing", async () => {
    const view = await setup(2);
    try {
      view.dispatch("other");
      await Bun.sleep(10);
      expect(view.form).not.toHaveBeenCalled();
      view.dispose();
      view.dispatch();
      await Bun.sleep(10);
      expect(view.form).not.toHaveBeenCalled();
      expect(view.copies).toHaveLength(0);
    } finally {
      view.cleanup();
    }
  });
  test("viewers cannot trigger duplication through an event", async () => {
    const view = await setup(0, false);
    try {
      view.dispatch();
      await Bun.sleep(10);
      expect(view.form).not.toHaveBeenCalled();
      expect(view.copies).toHaveLength(0);
    } finally {
      view.cleanup();
    }
  });
});
