import { expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "./markdown/markdown";
import { slashCompletionSource } from "./slash-menu";

const source = slashCompletionSource([{ id: "heading", name: "heading", icon: "ti-h-1", label: "Heading", run() {} }]);
test.each(["```bash\ncd /|\n```", "~~~bash\ncd /|\n~~~", "```bash\ncd /|", "    cd /|", "Text `cd /|` end"])(
  "slash actions stay out of literal code: %s",
  (marked) => {
    const pos = marked.indexOf("|");
    const doc = marked.replace("|", "");
    const state = EditorState.create({ doc, extensions: [markdownExtension()] });
    ensureSyntaxTree(state, doc.length);
    expect(source(new CompletionContext(state, pos, false))).toBeNull();
  },
);
test("slash actions still open in prose", () => {
  const state = EditorState.create({ doc: "Text /", extensions: [markdownExtension()] });
  expect(source(new CompletionContext(state, state.doc.length, false))?.options).toHaveLength(1);
});
