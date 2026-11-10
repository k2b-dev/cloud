/** Hide Markdown markers outside the current selection, retaining unchanged blocks. Until the person acts in the editor,
 *  nothing is being edited and every marker stays hidden, also on the title line where the caret starts. */
import { syntaxTree } from "@codemirror/language";
import type { EditorSelection, EditorState, Extension, Range } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import {
  changedMarkdownBlocks,
  intersectsMarkdownSpans,
  type MarkdownSpan,
  markdownBlockAt,
  mergeMarkdownSpans,
} from "./_lib/changed-blocks";
import {
  holdsDecorations,
  markdownEditorFocused,
  placeMarkdownCaret,
  refreshesMarkdownDecorations,
  revealedSelection,
} from "./_lib/cursor-zone-field";

class HorizontalRuleWidget extends WidgetType {
  override toDOM(view: EditorView) {
    const hr = document.createElement("div");
    hr.className = "cm-hr-widget";
    hr.setAttribute("contenteditable", "false");
    hr.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: view.posAtDOM(hr) }, scrollIntoView: true, effects: placeMarkdownCaret.of() });
      view.focus();
    };
    return hr;
  }
  override eq(other: WidgetType) {
    return other instanceof HorizontalRuleWidget;
  }
  override ignoreEvent() {
    return true;
  }
}

const cursorOnLine = (state: EditorState, from: number, to: number): boolean => {
  const first = state.doc.lineAt(from).from;
  const last = state.doc.lineAt(to).to;
  return (revealedSelection(state)?.ranges ?? []).some((range) => range.from <= last && range.to >= first);
};
const cursorInRange = (state: EditorState, from: number, to: number): boolean =>
  (revealedSelection(state)?.ranges ?? []).some((range) => range.from <= to && range.to >= from);

/** `selection` is the selection the decorations reveal around: `null` while the person is not editing. */
type MarkupState = { decorations: DecorationSet; atomicDecorations: DecorationSet; selection: EditorSelection | null };
const build = (state: EditorState, span?: MarkdownSpan): MarkupState => {
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    from: span?.from,
    to: span?.to,
    enter(node) {
      const { name, from, to } = node;
      if (span && (from >= span.to || to <= span.from)) return false;
      // A code subtree is literal; do not search a separate list of code ranges per node.
      if (name === "FencedCode" || name === "CodeBlock" || name === "InlineCode") return false;
      if (name.startsWith("ATXHeading")) {
        if (cursorOnLine(state, from, to)) return;
        const mark = node.node.getChild("HeaderMark");
        if (mark) decorations.push(Decoration.replace({}).range(from, mark.to + Number(state.sliceDoc(mark.to, mark.to + 1) === " ")));
      } else if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
        if (cursorInRange(state, from, to)) return;
        const size = name === "Emphasis" ? 1 : 2;
        decorations.push(Decoration.replace({}).range(from, from + size), Decoration.replace({}).range(to - size, to));
      } else if (name === "HorizontalRule" && !cursorOnLine(state, from, to)) {
        const rule = Decoration.replace({ widget: new HorizontalRuleWidget(), block: true }).range(from, to);
        decorations.push(rule);
        atomic.push(rule);
      }
    },
  });
  return {
    decorations: Decoration.set(decorations, true),
    atomicDecorations: Decoration.set(atomic, true),
    selection: revealedSelection(state),
  };
};

const replaceBlocks = (previous: DecorationSet, additions: readonly DecorationSet[], spans: readonly MarkdownSpan[]): DecorationSet => {
  if (!spans.length) return previous;
  const add: Range<Decoration>[] = [];
  for (const set of additions)
    for (let cursor = set.iter(); cursor.value; cursor.next()) add.push(cursor.value.range(cursor.from, cursor.to));
  return previous.update({
    filterFrom: spans[0]!.from,
    filterTo: spans.at(-1)!.to,
    filter: (from, to) => from < to && !intersectsMarkdownSpans(spans, from, to),
    add,
    sort: true,
  });
};

export const markupExtension = (): Extension => {
  const field = StateField.define<MarkupState>({
    create: build,
    update(value, tr) {
      // An explicit refresh, or the person starting or stopping to edit, redraws the blocks around the selection too.
      const refresh = refreshesMarkdownDecorations(tr);
      const spans = [...changedMarkdownBlocks(tr)];
      if ((!holdsDecorations(tr) && tr.selection) || refresh) {
        for (const range of value.selection?.ranges ?? []) {
          const block = markdownBlockAt(syntaxTree(tr.startState), range.from);
          const end = markdownBlockAt(syntaxTree(tr.startState), range.to);
          spans.push({ from: tr.changes.mapPos(block.from, -1), to: tr.changes.mapPos(end.to, 1) });
        }
        for (const range of revealedSelection(tr.state)?.ranges ?? []) {
          spans.push({
            from: markdownBlockAt(syntaxTree(tr.state), range.from).from,
            to: markdownBlockAt(syntaxTree(tr.state), range.to).to,
          });
        }
      }
      const merged = mergeMarkdownSpans(spans);
      const additions = merged.map((span) => build(tr.state, span));
      return {
        decorations: replaceBlocks(
          value.decorations.map(tr.changes),
          additions.map((next) => next.decorations),
          merged,
        ),
        atomicDecorations: replaceBlocks(
          value.atomicDecorations.map(tr.changes),
          additions.map((next) => next.atomicDecorations),
          merged,
        ),
        selection: holdsDecorations(tr) ? (value.selection?.map(tr.changes) ?? null) : revealedSelection(tr.state),
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicDecorations),
    ],
  });
  return [
    markdownEditorFocused,
    field,
    EditorView.theme({
      ".cm-hr-widget": {
        borderTop: "2px solid",
        borderColor: "var(--color-zinc-300)",
        margin: "0 !important",
        padding: "0.75em 0 0",
        boxSizing: "border-box",
      },
      ".dark .cm-hr-widget": { borderColor: "var(--color-zinc-600)" },
    }),
  ];
};
