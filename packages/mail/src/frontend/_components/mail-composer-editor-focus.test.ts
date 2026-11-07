import { describe, expect, test } from "bun:test";
import { focusMailComposerEditorAtStart } from "./mail-composer-editor-focus";

describe("Mail composer initial focus", () => {
  test("focuses the body and places the caret before signature content", () => {
    const calls: unknown[][] = [];
    const editor = {
      view: {
        focus: () => {
          calls.push(["focus"]);
        },
        dispatch: (...specs: readonly unknown[]) => {
          calls.push(["dispatch", ...specs]);
        },
      },
    };

    focusMailComposerEditorAtStart(editor);

    expect(calls).toEqual([["dispatch", { selection: { anchor: 0 } }], ["focus"]]);
  });
});
