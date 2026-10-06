import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { type MarkdownInfoBlockType, NOTICE_CARD_CLASSES, renderMarkdownInfoBlock, scanMarkdownInfoBlock } from "@k2b/ui";
import { literalMarkdownLines } from "../../../lib/markdown-context";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { applyLigatures } from "./ligatures";

type InfoBlockData = {
  type: MarkdownInfoBlockType;
  title?: string;
  content: string;
};

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const renderContent = (content: string): string => {
  const codeSpans: string[] = [];
  return escapeHtml(content)
    .replace(/`([^`]+)`/g, (_match, body: string) => {
      const index = codeSpans.push(`<code class="bg-black/10 dark:bg-white/10 px-1 py-0.5 rounded text-sm">${body}</code>`) - 1;
      return `\u0000CODE${index}\u0000`;
    })
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\n/g, "<br>")
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
};

class InfoBlockWidget extends WidgetType {
  constructor(
    private blockData: InfoBlockData,
    private fromPos: number,
    private locale: string,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-notice-card-widget cursor-pointer";
    container.setAttribute("contenteditable", "false");
    container.setAttribute("tabindex", "0");
    container.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };
    container.ondblclick = (event) => {
      event.stopPropagation();
    };

    // The shared info block, as in Book; the editor preview renders inline formatting only.
    container.innerHTML = renderMarkdownInfoBlock({
      type: this.blockData.type,
      title: this.blockData.title,
      bodyHtml: renderContent(this.blockData.content),
      locale: this.locale,
    });
    const body = container.querySelector<HTMLElement>(`.${NOTICE_CARD_CLASSES.body}`);
    if (body) applyLigatures(body);
    return container;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof InfoBlockWidget &&
      other.fromPos === this.fromPos &&
      other.locale === this.locale &&
      other.blockData.type === this.blockData.type &&
      other.blockData.title === this.blockData.title &&
      other.blockData.content === this.blockData.content
    );
  }

  override ignoreEvent() {
    return true;
  }

  override get estimatedHeight() {
    // One 22px line per title and body source line plus the card's padding and border.
    const lines = this.blockData.content.split("\n").length + (this.blockData.title ? 1 : 0);
    return lines * 22 + 34;
  }
}

/** Finds notices with the same block scanner as the book view, so every
 *  directive ends at its own `:::` and code or list content stays source. */
const findInfoBlocks = (state: EditorState, locale: string): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;
  const text = state.doc.toString();
  if (!text.includes(":::")) return { decorations: Decoration.none, atomicDecorations: Decoration.none, ranges };
  const literal = literalMarkdownLines(text);

  for (let number = 1; number <= state.doc.lines; number++) {
    const opener = state.doc.line(number);
    if (!/^ {0,3}:::/.test(opener.text) || literal.has(number - 1)) continue;
    const notice = scanMarkdownInfoBlock(text.slice(opener.from));
    if (!notice?.closed) continue;
    const blockLines = text
      .slice(opener.from, opener.from + notice.length)
      .replace(/\n$/, "")
      .split("\n");
    const blockStart = opener.from;
    const blockEnd = state.doc.line(number + blockLines.length - 1).to;
    const sourceVisibleStart = state.doc.lineAt(Math.max(blockStart - 1, 0)).from;
    const sourceVisibleEnd = state.doc.lineAt(Math.min(blockEnd + 1, state.doc.length)).to;
    ranges.push({ from: sourceVisibleStart, to: sourceVisibleEnd });

    // Cursor is inside the block → don't render the widget so the user
    // can edit the raw `:::xxx` markers.
    if (selectionIntersectsRange(cursor, sourceVisibleStart, sourceVisibleEnd)) continue;

    const blockData = { type: notice.type, title: notice.title, content: notice.body.trim() };
    decorations.push(
      Decoration.replace({
        widget: new InfoBlockWidget(blockData, blockStart, locale),
        block: true,
      }).range(blockStart, blockEnd),
    );
  }

  const set = decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none;
  return { decorations: set, atomicDecorations: set, ranges };
};

/** `locale` names an untitled notice's type for screen readers; the rendered block shows it as the tone tint. */
export const infoBlocksExtension = (locale: string): Extension => {
  // Container context anywhere above a notice decides whether it renders, so
  // every document change rescans, like the query and table-of-contents blocks.
  const stateField = cursorZoneStateField((state) => findInfoBlocks(state, locale));

  const theme = EditorView.theme({
    ".cm-notice-card-widget": {
      display: "block",
      margin: "0 !important",
      lineHeight: "1",
    },
  });

  return [stateField, blockWidgetLineNavigationExtension(stateField, (value) => value.atomicDecorations), theme];
};
