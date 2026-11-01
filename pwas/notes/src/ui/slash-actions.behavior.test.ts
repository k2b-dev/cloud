import { describe, expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../packages/ui/test/dom";

// @k2b/ui registers its events on import, so the document comes first.
const loading = createDomTestHarness();
const { CompletionContext } = await import("@codemirror/autocomplete");
const { EditorState } = await import("@codemirror/state");
const { createEditor, markdownActions, slashCompletionSource } = await import("@k2b/editor");
const { createRoot } = await import("solid-js");
const { messages } = await import("../i18n");
const { noteSlashActions } = await import("./slash-actions");
loading.cleanup();

const tag: import("@k2b/editor").EditorAction = { id: "tag", icon: "ti-hash", label: "Tag", run: () => {} };
const actions = (locale: "en" | "de", inCell = false) =>
  createRoot((dispose) => {
    const result = noteSlashActions({
      t: messages.resolve([locale]).t,
      md: markdownActions(createEditor(), locale),
      tag,
      inCell: () => inCell,
      pickFiles: () => {},
    });
    dispose();
    return result;
  });
const complete = (locale: "en" | "de", doc: string, inCell = false) =>
  slashCompletionSource(actions(locale, inCell))(
    new CompletionContext(EditorState.create({ doc, selection: { anchor: doc.length } }), doc.length, false),
  )?.options.map((option) => option.displayLabel);

describe("Notes slash menu names", () => {
  test("the bare slash lists everything: text, then lists, then blocks and media", () => {
    expect(complete("de", "/")).toEqual([
      "Überschrift 1",
      "Überschrift 2",
      "Überschrift 3",
      "Zitat",
      "Link",
      "Tag",
      "Aufzählung",
      "Nummerierte Liste",
      "Checkliste",
      "Tabelle",
      "Hinweis",
      "Info",
      "Erfolg",
      "Warnung",
      "Gefahr",
      "Codeblock",
      "Trennlinie",
      "Bild oder PDF",
      "Diagramm",
      "Diagramm: Balken",
      "Diagramm: Kreis",
      "Diagramm: Ring",
      "Diagramm: Punkte",
    ]);
    expect(complete("en", "/")?.length).toBe(23);
  });

  test.each([
    ["/quote", "Zitat", "Quote"],
    ["/zitat", "Zitat", "Quote"],
    ["/h1", "Überschrift 1", "Heading 1"],
    ["/ueberschrift", "Überschrift 2", "Heading 2"],
    ["/überschrift", "Überschrift 2", "Heading 2"],
    ["/heading", "Überschrift 2", "Heading 2"],
    ["/aufzählung", "Aufzählung", "Bulleted list"],
    ["/bullet", "Aufzählung", "Bulleted list"],
    ["/trennlinie", "Trennlinie", "Divider"],
    ["/hr", "Trennlinie", "Divider"],
    ["/warnung", "Warnung", "Warning"],
    ["/warning", "Warnung", "Warning"],
    ["/pdf", "Bild oder PDF", "Image or PDF"],
    ["/pie", "Diagramm: Kreis", "Chart: pie"],
    ["/kreis", "Diagramm: Kreis", "Chart: pie"],
  ])("%s finds the same block in both languages", (typed, german, english) => {
    expect(complete("de", typed)?.[0]).toBe(german);
    expect(complete("en", typed)?.[0]).toBe(english);
  });

  test("a label in the note's language matches while typing", () => {
    expect(complete("de", "/nummer")?.[0]).toBe("Nummerierte Liste");
    expect(complete("en", "/number")?.[0]).toBe("Numbered list");
  });

  test("a table cell offers no block: it would split the row", () => {
    expect(complete("de", "/", true)).toEqual([]);
  });
});
