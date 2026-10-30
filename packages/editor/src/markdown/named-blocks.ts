import { type Extension, type Range, RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { extractNamedBlocks } from "./lib/named-blocks";

class NamedBlockHandleWidget extends WidgetType {
  constructor(
    private name: string,
    private fromPos: number,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-named-block-handle md-block-handle";
    el.setAttribute("contenteditable", "false");
    el.textContent = `@${this.name}`;
    el.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };
    return el;
  }

  override eq(other: WidgetType) {
    return other instanceof NamedBlockHandleWidget && other.name === this.name && other.fromPos === this.fromPos;
  }

  override ignoreEvent() {
    return true;
  }
}

export const namedBlocksExtension = (): Extension => {
  const stateField = cursorZoneStateField((state): CursorZoneState => {
    const decorations: Range<Decoration>[] = [];
    const atomicDecorations: Range<Decoration>[] = [];
    const ranges: { from: number; to: number }[] = [];
    const cursor = state.selection.main;
    const text = state.doc.toString();

    for (const block of extractNamedBlocks(text)) {
      const prevLine = state.doc.lineAt(Math.max(block.handleStart - 1, 0));
      const nextLine = state.doc.lineAt(Math.min(block.handleEnd + 1, state.doc.length));
      const sourceVisibleRange = { from: prevLine.from, to: nextLine.to };
      ranges.push(sourceVisibleRange);
      // Table/data handles are rendered by their block widgets together
      // with the preview so the handle and body collapse as one stable block.
      if (block.type === "table" || block.type === "data") continue;
      if (selectionIntersectsRange(cursor, sourceVisibleRange.from, sourceVisibleRange.to)) continue;
      const handleDecoration = Decoration.replace({
        widget: new NamedBlockHandleWidget(block.name, block.handleStart),
        block: true,
      }).range(block.handleStart, block.handleEnd);
      decorations.push(handleDecoration);
      atomicDecorations.push(handleDecoration);
    }

    return {
      decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
      atomicDecorations: atomicDecorations.length > 0 ? RangeSet.of(atomicDecorations, true) : Decoration.none,
      ranges,
      hasSyntax: decorations.length > 0,
    };
  });

  return [
    stateField,
    blockWidgetLineNavigationExtension(stateField, (value) => value.atomicDecorations),
    EditorView.theme({
      ".cm-named-block-handle": {
        margin: "0 !important",
      },
    }),
  ];
};
