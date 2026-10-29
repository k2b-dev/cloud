import { afterEach, describe, expect, test } from "bun:test";
import { autocompletion, completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { buildNoteLinkCompletionSource, noteLinkSuggestionsAfterDelete } from "./note-link-autocomplete";

describe("[[ link suggestions in the editor", () => {
  if (isServer) {
    test.skip("link suggestions run with browser export conditions", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const waitFor = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  test("deleting back from a target without a match to one with matches offers them again", async () => {
    const queries: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        const query = url.searchParams.get("q") ?? "";
        queries.push(query);
        const notes = query.toLowerCase() === "plan" ? [{ id: "Note01", title: "Plan" }] : [];
        return Response.json({ data: notes, hasMore: false });
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    const dom = createDomTestHarness();
    const doc = "See [[Planx";
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          autocompletion({ override: [buildNoteLinkCompletionSource("Book01")], activateOnTyping: true }),
          noteLinkSuggestionsAfterDelete,
        ],
      }),
    });
    try {
      view.dispatch({ changes: { from: doc.length, insert: "" }, userEvent: "input.type" });
      view.dispatch({ changes: { from: doc.length - 1, to: doc.length, insert: "x" }, userEvent: "input.type" });
      await waitFor(() => queries.includes("Planx") && completionStatus(view.state) === null);
      view.dispatch({ changes: { from: doc.length - 1, to: doc.length }, userEvent: "delete.backward" });
      await waitFor(() => currentCompletions(view.state).length > 0);
      expect(queries.at(-1)).toBe("Plan");
      expect(currentCompletions(view.state).map((option) => option.label)).toEqual(["Plan"]);
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
