import { type EditorState, type Extension, Prec, type Range, RangeSet, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { type DataBlock, extractDataBlocks, namedBlockBody, renderDataBlockHtml } from "../../../lib/named-blocks";
import { holdsDecorations, refreshMarkdownDecorationsEffect, selectionIntersectsRange } from "./_lib/cursor-zone-field";

type DataBlockRange = {
  from: number;
  to: number;
  widgetFrom: number;
  widgetTo: number;
};

type DataBlocksState = {
  decorations: DecorationSet;
  blockWidgetDecorations: DecorationSet;
  ranges: DataBlockRange[];
};

class DataBlockWidget extends WidgetType {
  constructor(
    private block: DataBlock,
    private body: string,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-data-block-widget";
    el.setAttribute("contenteditable", "false");
    el.innerHTML = renderDataBlockHtml(this.block.name, this.body);
    el.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.block.blockStart }, scrollIntoView: true });
      view.focus();
    };
    el.ondblclick = (event) => {
      event.stopPropagation();
    };
    return el;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof DataBlockWidget &&
      other.block.name === this.block.name &&
      other.block.blockStart === this.block.blockStart &&
      other.body === this.body
    );
  }

  override get estimatedHeight() {
    const rows = Math.max(1, this.body.split("\n").filter((line) => line.trim().length > 0).length);
    // 12px / 16px cells + 16px padding + divider; the handle and outer padding round up to 44px.
    return 44 + rows * 33;
  }

  override ignoreEvent() {
    return true;
  }
}

export const dataBlocksExtension = (): Extension => {
  const stateField = StateField.define<DataBlocksState>({
    create: scanDataBlocks,
    update(value, tr) {
      if (tr.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect))) return scanDataBlocks(tr.state);
      if (tr.docChanged) return scanDataBlocks(tr.state);
      if (holdsDecorations(tr)) return value;
      if (!tr.selection) return value;
      const oldKey = cursorDataBlockKey(tr.startState, value.ranges);
      const newKey = cursorDataBlockKey(tr.state, value.ranges);
      if (oldKey === newKey) return value;
      return scanDataBlocks(tr.state);
    },
    provide(field) {
      return [
        EditorView.decorations.from(field, (value) => value.decorations),
        EditorView.atomicRanges.of((view) => view.state.field(field).blockWidgetDecorations),
      ];
    },
  });

  const navKeymap = Prec.highest(
    keymap.of([
      { key: "ArrowUp", run: (view) => navigateLine(view, stateField, -1, false) },
      { key: "Shift-ArrowUp", run: (view) => navigateLine(view, stateField, -1, true) },
      { key: "ArrowDown", run: (view) => navigateLine(view, stateField, 1, false) },
      { key: "Shift-ArrowDown", run: (view) => navigateLine(view, stateField, 1, true) },
    ]),
  );

  return [
    stateField,
    navKeymap,
    EditorView.theme({
      ".cm-data-block-widget": {
        display: "block",
        padding: "0.5rem 0",
        margin: "0 !important",
      },
      ".cm-data-block-widget .md-data-block": {
        margin: "0 !important",
      },
    }),
  ];
};

const scanDataBlocks = (state: EditorState): DataBlocksState => {
  const decorations: Range<Decoration>[] = [];
  const blockWidgetDecorations: Range<Decoration>[] = [];
  const ranges: DataBlockRange[] = [];
  const cursor = state.selection.main;
  const text = state.doc.toString();

  for (const block of extractDataBlocks(text)) {
    const prevLine = state.doc.lineAt(Math.max(block.handleStart - 1, 0));
    const nextLine = state.doc.lineAt(Math.min(block.blockEnd + 1, state.doc.length));
    const range = {
      from: prevLine.from,
      to: nextLine.to,
      widgetFrom: block.handleStart,
      widgetTo: block.blockEnd,
    };
    ranges.push(range);
    if (selectionIntersectsRange(cursor, range.from, range.to)) continue;
    const widgetDecoration = Decoration.replace({
      widget: new DataBlockWidget(block, namedBlockBody(text, block)),
      block: true,
    }).range(block.handleStart, block.blockEnd);
    decorations.push(widgetDecoration);
    blockWidgetDecorations.push(widgetDecoration);
  }

  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    blockWidgetDecorations: blockWidgetDecorations.length > 0 ? RangeSet.of(blockWidgetDecorations, true) : Decoration.none,
    ranges,
  };
};

const cursorDataBlockKey = (state: EditorState, ranges: DataBlockRange[]): string | null => {
  const cursor = state.selection.main;
  const hits: number[] = [];
  for (const range of ranges) {
    if (selectionIntersectsRange(cursor, range.from, range.to)) hits.push(range.widgetFrom);
  }
  return hits.length > 0 ? hits.sort((a, b) => a - b).join(",") : null;
};

const isLineInBlockWidget = (state: DataBlocksState, from: number, to: number): DataBlockRange | null => {
  for (const range of state.ranges) {
    if (from > range.widgetTo || to < range.widgetFrom) continue;
    let isWidget = false;
    state.blockWidgetDecorations.between(range.widgetFrom, range.widgetTo, (decoFrom, decoTo) => {
      if (decoFrom === range.widgetFrom && decoTo === range.widgetTo) {
        isWidget = true;
        return false;
      }
      return undefined;
    });
    if (isWidget) return range;
  }
  return null;
};

const navigateLine = (view: EditorView, stateField: StateField<DataBlocksState>, dir: -1 | 1, extend: boolean): boolean => {
  const dataState = view.state.field(stateField, false);
  if (!dataState || dataState.ranges.length === 0) return false;

  const sel = view.state.selection.main;
  const head = sel.head;
  const caretLine = view.state.doc.lineAt(head);
  const caretCol = head - caretLine.from;

  let targetLineNumber = caretLine.number + dir;
  while (targetLineNumber >= 1 && targetLineNumber <= view.state.doc.lines) {
    const line = view.state.doc.line(targetLineNumber);
    const inside = isLineInBlockWidget(dataState, line.from, line.to);
    if (!inside) break;
    const widgetStartLine = view.state.doc.lineAt(inside.widgetFrom).number;
    const widgetEndLine = view.state.doc.lineAt(inside.widgetTo).number;
    targetLineNumber = dir < 0 ? widgetStartLine - 1 : widgetEndLine + 1;
  }

  if (targetLineNumber < 1) {
    view.dispatch({
      selection: extend ? { anchor: sel.anchor, head: 0 } : { anchor: 0 },
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  if (targetLineNumber > view.state.doc.lines) {
    const target = view.state.doc.length;
    view.dispatch({
      selection: extend ? { anchor: sel.anchor, head: target } : { anchor: target },
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  const targetLine = view.state.doc.line(targetLineNumber);
  const target = targetLine.from + Math.min(caretCol, targetLine.length);
  view.dispatch({
    selection: extend ? { anchor: sel.anchor, head: target } : { anchor: target },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};
