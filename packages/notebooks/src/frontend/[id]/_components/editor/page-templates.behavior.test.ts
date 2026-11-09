import { expect, mock, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { Compartment, EditorState, StateEffect, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

/** The draft answers when the test lets it, so the note can change in between. */
let answerDraft: () => void = () => {};
mock.module("@/api/client", () => ({
  apiClient: {
    ":id": {
      "page-templates": {
        ":templateId": {
          draft: {
            $get: () =>
              new Promise<Response>((resolve) => {
                answerDraft = () => resolve(Response.json({ name: "Meeting notes", contentMd: "# Meeting\n\n## Agenda\n" }));
              }),
          },
        },
      },
    },
  },
}));

const loading = createDomTestHarness();
const { applyPageTemplate, applyPageTemplateById, isBlankNoteText } = await import("./page-templates");
loading.cleanup();

const template = "# Meeting 2026-11-04\n\n- **Notes by:** Ada\n\n## Agenda\n\n1.\n";

const mount = (doc: string, anchor = doc.length) => {
  const dom = createDomTestHarness();
  const view = new EditorView({ parent: dom.root, state: EditorState.create({ doc, selection: { anchor }, extensions: [history()] }) });
  return {
    view,
    [Symbol.dispose]: () => {
      view.destroy();
      dom.cleanup();
    },
  };
};

test("a note that holds only its title becomes the template, with the new title selected to type over", () => {
  using editor = mount("# New Document\n");
  applyPageTemplate(editor.view, template);
  expect(editor.view.state.doc.toString()).toBe(template);
  const { from, to } = editor.view.state.selection.main;
  expect(editor.view.state.sliceDoc(from, to)).toBe("Meeting 2026-11-04");
  // One change, so one undo brings the empty note back.
  undo(editor.view);
  expect(editor.view.state.doc.toString()).toBe("# New Document\n");
});

test("inside a note with text, the template's sections land at the caret on lines of their own, without its title", () => {
  using editor = mount("# Plan\n\nIntro text", "# Plan\n\nIntro".length);
  applyPageTemplate(editor.view, template);
  expect(editor.view.state.doc.toString()).toBe("# Plan\n\nIntro\n\n- **Notes by:** Ada\n\n## Agenda\n\n1.\n\n text");
});

test("at the end of a note the sections follow after a blank line", () => {
  using editor = mount("# Plan\n\nIntro\n");
  applyPageTemplate(editor.view, template);
  expect(editor.view.state.doc.toString()).toBe("# Plan\n\nIntro\n\n- **Notes by:** Ada\n\n## Agenda\n\n1.\n");
});

test("the empty-note offer reads only short notes", () => {
  expect(isBlankNoteText("# New Document\n")).toBe(true);
  expect(isBlankNoteText(`# Title\n${" ".repeat(2000)}`)).toBe(false);
  expect(isBlankNoteText("# Title\n\nBody")).toBe(false);
});

test("the empty-note offer shows for the title alone and leaves with a second line, also an empty one", () => {
  expect(isBlankNoteText("")).toBe(true);
  expect(isBlankNoteText("# Title")).toBe(true);
  expect(isBlankNoteText(Text.of(["# Title", ""]))).toBe(true);
  expect(isBlankNoteText("# Title\n\n")).toBe(false);
  expect(isBlankNoteText("# Title\n ")).toBe(false);
  expect(isBlankNoteText("# Title\n/")).toBe(false);
  expect(isBlankNoteText("\n# Title\n")).toBe(false);
});

test("a note that turns read-only while the template loads stays as it is", async () => {
  using editor = mount("# New Document\n");
  const lock = new Compartment();
  editor.view.dispatch({ effects: StateEffect.appendConfig.of(lock.of([])) });
  const meeting = { id: "meeting-notes", name: "Meeting notes", description: null, icon: "ti ti-users", builtIn: true, updatedAt: null };
  const applying = applyPageTemplateById(editor.view, "Book01", meeting, "en");
  editor.view.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(true)) });
  answerDraft();
  await applying;
  expect(editor.view.state.doc.toString()).toBe("# New Document\n");
});
