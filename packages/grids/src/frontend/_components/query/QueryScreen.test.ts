import { describe, expect, test } from "bun:test";
import { insertTextAtEditorSelection } from "./QueryScreen";

const editor = (selectionStart: number, selectionEnd = selectionStart) => ({ selectionEnd, selectionStart }) as HTMLTextAreaElement;

describe("query editor insertion", () => {
  test("keeps insertions independent across multiple editors", () => {
    const secondSource = "from Orders\nselect Total";
    const first = insertTextAtEditorSelection("from Items", ' "Name"', editor(4));
    const second = insertTextAtEditorSelection(secondSource, ' "Status"', editor(secondSource.length));

    expect(first).toEqual({ value: 'from "Name" Items', caret: 11 });
    expect(second).toEqual({ value: 'from Orders\nselect Total "Status"', caret: 33 });
  });

  test("replaces the active selection and appends without an editor", () => {
    expect(insertTextAtEditorSelection("select Old", '"New"', editor(7, 10))).toEqual({ value: 'select "New"', caret: 12 });
    expect(insertTextAtEditorSelection("from Items", "\nlimit 10", null)).toEqual({
      value: "from Items\nlimit 10",
      caret: 19,
    });
  });
});
