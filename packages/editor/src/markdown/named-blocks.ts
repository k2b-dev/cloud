import { type Extension, Facet, type Range, RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { extractNamedBlocks } from "./lib/named-blocks";

/**
 * Block types whose anchor line another extension draws together with the block, such as data blocks. The anchor
 * label leaves those lines alone; every other named block (tables, lists, …) gets the label.
 */
export const blockAnchorsDrawnElsewhere = Facet.define<string, ReadonlySet<string>>({ combine: (types) => new Set(types) });

/** The anchor line `@name` above a block, shown as a quiet label until the caret enters the line. */
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
    el.dataset.blockName = this.name;
    el.setAttribute("contenteditable", "false");
    el.textContent = this.name;
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
      if (state.facet(blockAnchorsDrawnElsewhere).has(block.type)) continue;
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
      // A block of the editor, measured without margins: an inline label would sit in a taller line box than the
      // editor measures, and every line after it would drift from where the editor places it.
      ".cm-named-block-handle": {
        display: "flex",
        margin: "0 !important",
        padding: "0.35rem 0 0.15rem",
      },
    }),
  ];
};
