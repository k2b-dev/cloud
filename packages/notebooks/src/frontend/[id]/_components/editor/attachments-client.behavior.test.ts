import { describe, expect, spyOn, test } from "bun:test";
import { Compartment, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findTables } from "@k2b/ui/text-editor/model";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const loading = createDomTestHarness();
const { insertAttachment, uploadAndInsert } = await import("./attachments-client");
loading.cleanup();

describe("attachment insertion", () => {
  if (isServer) {
    test.skip("attachment insertion runs with browser export conditions", () => {});
    return;
  }

  const file = { id: "File01", kind: "file", filename: "invoice.pdf" } as const;
  for (const table of ["| Item | Cost |\n| --- | ---: |\n| Paper | 4 |", "Item | Cost\n--- | ---:\nPaper | 4"]) {
    for (const following of ["", "\n# Following section", "\n\nFollowing prose."]) {
      test.each(["file", "image"] as const)(`%s after table ${JSON.stringify(table)} with suffix ${JSON.stringify(following)}`, (kind) => {
        const dom = createDomTestHarness();
        const doc = `Intro\n\n${table}${following}`;
        const view = new EditorView({ parent: dom.root, state: EditorState.create({ doc, selection: { anchor: doc.indexOf("Paper") } }) });
        try {
          insertAttachment(view, { ...file, kind });
          const after = view.state.doc.toString();
          const expectedSuffix = following.startsWith("\n\n") || !following ? following : `\n${following}`;
          expect(after).toBe(`Intro\n\n${table}\n\n${kind === "image" ? "!" : ""}[invoice.pdf](attach://File01)${expectedSuffix}`);
          const tables = findTables(after);
          expect(tables).toHaveLength(1);
          expect(after.slice(tables[0]!.from, tables[0]!.to)).toBe(table);
          expect(tables[0]!.lines[2]!.cells).toHaveLength(2);
        } finally {
          view.destroy();
          dom.cleanup();
        }
      });
    }
  }

  test("files still replace the selected prose inline", () => {
    const dom = createDomTestHarness();
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc: "Read this now", selection: { anchor: 5, head: 9 } }),
    });
    try {
      insertAttachment(view, file);
      expect(view.state.doc.toString()).toBe("Read [invoice.pdf](attach://File01) now");
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });

  test.each([true, false])("upload completion uses the live caret (inside table: %s)", async (finishesInTable) => {
    const dom = createDomTestHarness();
    const table = "Item | Cost\n--- | ---:\nPaper | 4";
    const doc = `Intro\n\n${table}\n\nFollowing prose.`;
    const anchor = finishesInTable ? 2 : doc.indexOf("Paper");
    const view = new EditorView({ parent: dom.root, state: EditorState.create({ doc, selection: { anchor } }) });
    const response = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    try {
      const pending = uploadAndInsert(view, "Book01", new File(["pdf"], "invoice.pdf", { type: "application/pdf" }));
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.main.head).toBe(anchor);
      view.dispatch({ changes: { from: 0, insert: "New intro\n\n" } });
      view.dispatch({ selection: { anchor: finishesInTable ? view.state.doc.toString().indexOf("Paper") : 2 } });
      response.resolve(Response.json(file));
      await pending;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(view.state.doc.toString()).toBe(
        finishesInTable
          ? `New intro\n\nIntro\n\n${table}\n\n[invoice.pdf](attach://File01)\n\nFollowing prose.`
          : `Ne[invoice.pdf](attach://File01)w intro\n\nIntro\n\n${table}\n\nFollowing prose.`,
      );
    } finally {
      fetch.mockRestore();
      view.destroy();
      dom.cleanup();
    }
  });

  test("an insertion after the note becomes read-only dispatches no changes", () => {
    const dom = createDomTestHarness();
    const readOnly = new Compartment();
    const transactions: Transaction[] = [];
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc: "note",
        selection: { anchor: 2 },
        extensions: [
          readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
        ],
      }),
    });
    try {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) });
      transactions.length = 0;
      insertAttachment(view, { id: "File01", kind: "file", filename: "file.txt" });
      insertAttachment(view, { id: "Image1", kind: "image", filename: "image.png" });
      expect(view.state.doc.toString()).toBe("note");
      expect(view.state.selection.main.head).toBe(2);
      expect(transactions).toHaveLength(0);
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
