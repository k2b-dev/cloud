import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, RangeSet, type Transaction } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import { tagColor } from "./common";

type Markdown = typeof import("@k2b/editor/markdown");

/** The tag syntax of the overview filter and the search (`lib/derive.ts`), so a pill always finds its notes. */
const TAG = /(^|[\s([{])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;
const NOT_PROSE = new Set(["FencedCode", "CodeBlock", "InlineCode", "HeaderMark", "URL"]);

/**
 * `#tag` in a note shows as a pill in the tag's colour, as in mockup v4; a click opens the overview filtered by it.
 * While the caret is inside a tag, its text stays editable as typed.
 */
export function tagPills(md: Markdown, options: { open: (tag: string) => void; label: (tag: string) => string }): Extension {
  class Pill extends WidgetType {
    constructor(readonly tag: string) {
      super();
    }
    override toDOM(view: EditorView) {
      const pill = document.createElement("a");
      pill.className = "n-tagpill";
      pill.href = `/?tag=${encodeURIComponent(this.tag)}`;
      pill.title = options.label(this.tag);
      pill.style.setProperty("--c", tagColor(this.tag));
      pill.textContent = `#${this.tag}`;
      md.makeOpener(pill, view, () => options.open(this.tag));
      return pill;
    }
    override eq(other: WidgetType) {
      return other instanceof Pill && other.tag === this.tag;
    }
    override ignoreEvent(event: Event) {
      return event.type !== "mousedown";
    }
  }

  const find = (state: EditorState) => {
    const excluded: { from: number; to: number }[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        if (NOT_PROSE.has(node.type.name)) excluded.push({ from: node.from, to: node.to });
      },
    });
    const decorations: Range<Decoration>[] = [];
    const ranges: { from: number; to: number }[] = [];
    const caret = state.selection.main;
    for (const match of state.doc.toString().matchAll(TAG)) {
      const from = match.index + (match[1]?.length ?? 0);
      const tag = match[2] ?? "";
      const to = from + 1 + tag.length;
      if (excluded.some((range) => from >= range.from && to <= range.to)) continue;
      ranges.push({ from, to });
      if (!md.selectionIntersectsRange(caret, from, to))
        decorations.push(Decoration.replace({ widget: new Pill(tag.toLowerCase()) }).range(from, to));
    }
    return { decorations: decorations.length ? RangeSet.of(decorations, true) : Decoration.none, ranges, hasSyntax: ranges.length > 0 };
  };

  // Typing prose without `#` nearby keeps the pills as they are instead of rescanning the note.
  const mightAffectTags = (transaction: Transaction) => {
    let might = false;
    transaction.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
      if (might) return;
      const doc = transaction.state.doc;
      might = inserted.toString().includes("#") || doc.sliceString(Math.max(0, fromB - 2), Math.min(doc.length, toB + 2)).includes("#");
    });
    return might;
  };

  return md.cursorZoneStateField(find, { changesMightAffectSyntax: mightAffectTags });
}
